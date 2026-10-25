// Last-cast cache (Cloudflare Pages Function + D1). POST {fids} answers fresh rows from D1; stale or
// unknown fids are read from the Snapchain hub, at most MISS_CAP per request (the free plan allows
// 50 subrequests), and the rest come back in `missing` for the app to ask again or read itself.
type Row = { fid: number; at: number | null; checked: number };
type Stmt = { bind(...v: unknown[]): Stmt; all<T>(): Promise<{ results: T[] }> };
type D1 = { prepare(sql: string): Stmt; batch(s: Stmt[]): Promise<unknown> };
type Ctx = { request: Request; env: { DB: D1 } };

const HUB = 'https://snap.farcaster.xyz:3381';
// Farcaster timestamps count seconds from 2021-01-01T00:00:00Z.
const FARCASTER_EPOCH_MS = Date.UTC(2021, 0, 1);
const MAX_FIDS = 500;
const MISS_CAP = 40;
// D1 binds at most 100 values per statement.
const READ_CHUNK = 100;
const HOUR = 3_600_000;
const HUB_TIMEOUT_MS = 6000;
// Workers keep 6 connections open per request; more would queue while their timeouts run.
const HUB_LANES = 6;

// Accounts that cast within a day may cast again soon; quiet and silent ones are re-read less often.
function ttl(at: number | null, now: number): number {
  if (at === null) return 24 * HOUR;
  return now - at < 24 * HOUR ? HOUR : 12 * HOUR;
}

async function hubLastCast(fid: number): Promise<number | null> {
  const q = new URLSearchParams({ fid: String(fid), pageSize: '1', reverse: 'true' });
  const res = await fetch(`${HUB}/v1/castsByFid?${q}`, { signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`hub ${res.status}`);
  const body = (await res.json()) as { messages?: Array<{ data?: { timestamp?: number } }> };
  const ts = body.messages?.[0]?.data?.timestamp;
  return typeof ts === 'number' ? FARCASTER_EPOCH_MS + ts * 1000 : null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  // Only the app's own pages may spend the free-plan quota from a browser.
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'forbidden' }, 403);
  let fids: number[];
  try {
    const body = (await request.json()) as { fids?: unknown };
    if (!Array.isArray(body.fids)) throw new Error('fids');
    fids = [...new Set(body.fids)].filter((f): f is number => Number.isInteger(f) && (f as number) > 0);
  } catch {
    return json({ error: 'Send {"fids": [positive integers]}' }, 400);
  }
  if (fids.length > MAX_FIDS) return json({ error: `At most ${MAX_FIDS} fids per request` }, 400);

  const now = Date.now();
  const casts: Record<string, number | null> = {};
  const stale: number[] = [];
  const known = new Map<number, Row>();
  for (let i = 0; i < fids.length; i += READ_CHUNK) {
    const part = fids.slice(i, i + READ_CHUNK);
    const { results } = await env.DB.prepare(`SELECT fid, at, checked FROM lastcast WHERE fid IN (${part.map(() => '?').join(',')})`)
      .bind(...part)
      .all<Row>();
    for (const r of results) known.set(r.fid, r);
  }
  for (const f of fids) {
    const r = known.get(f);
    if (r && now - r.checked < ttl(r.at, now)) casts[f] = r.at;
    else stale.push(f);
  }

  const ask = stale.slice(0, MISS_CAP);
  const read: Array<PromiseSettledResult<number | null>> = new Array(ask.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: HUB_LANES }, async () => {
      while (next < ask.length) {
        const i = next++;
        read[i] = await hubLastCast(ask[i]).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason) => ({ status: 'rejected' as const, reason }),
        );
      }
    }),
  );
  const writes: Stmt[] = [];
  const upsert = 'INSERT INTO lastcast (fid, at, checked) VALUES (?, ?, ?) ON CONFLICT(fid) DO UPDATE SET at = excluded.at, checked = excluded.checked';
  ask.forEach((f, i) => {
    const r = read[i];
    if (r.status !== 'fulfilled') return;
    casts[f] = r.value;
    // A never-cast fid with no row is not stored, so made-up fids cannot fill the table.
    if (r.value !== null || known.has(f)) writes.push(env.DB.prepare(upsert).bind(f, r.value, now));
  });
  // One batch, one subrequest; a failed write only costs a re-read later.
  if (writes.length) await env.DB.batch(writes).catch((e) => console.error('lastcast upsert', e));

  return json({ casts, missing: fids.filter((f) => !(f in casts)) });
}
