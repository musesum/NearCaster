// Snapchain (Farcaster hub) HTTP API provider. The public node answers with CORS "*" and needs no key.
// Links are ~490 bytes each and uncompressed, so page sizes stay modest.
import type { DataProvider, Page, User } from './types.ts';

export const DEFAULT_HUB = 'https://snap.farcaster.xyz:3381';

type LinkMessage = { data?: { fid?: number; linkBody?: { type?: string; targetFid?: number } } };
type LinkResponse = { messages?: LinkMessage[]; nextPageToken?: string };
type CastResponse = { messages?: Array<{ data?: { timestamp?: number } }> };

// Farcaster timestamps count seconds from 2021-01-01T00:00:00Z.
const FARCASTER_EPOCH_MS = Date.UTC(2021, 0, 1);
type UserDataMessage = { data?: { userDataBody?: { type?: string; value?: string } } };
type UserDataResponse = { messages?: UserDataMessage[] };

// castCache: the site's last-cast cache (functions/api/lastcasts.ts); empty = none.
export type SnapchainOptions = { base?: string; pageSize?: number; profileConcurrency?: number; castCache?: string };

export function snapchainProvider(opts: SnapchainOptions = {}): DataProvider {
  const base = (opts.base ?? DEFAULT_HUB).replace(/\/$/, '');
  const pageSize = opts.pageSize ?? 500;
  const castCache = opts.castCache ?? '/api/lastcasts';
  const profileConcurrency = opts.profileConcurrency ?? 8;

  const links = async (path: string, key: 'fid' | 'target_fid', fid: number, cursor?: string): Promise<{ res: LinkResponse }> => {
    const q = new URLSearchParams({ [key]: String(fid), link_type: 'follow', pageSize: String(pageSize) });
    if (cursor) q.set('pageToken', cursor);
    return { res: await getJson<LinkResponse>(`${base}/v1/${path}?${q}`) };
  };

  // The node sends a token even on the last page ("[null,null]", which serves that page again):
  // a short page, or a token equal to the one just sent, ends the list.
  const toPage = (res: LinkResponse, cursor: string | undefined, pick: (m: LinkMessage) => number | undefined): Page => {
    const fids: number[] = [];
    for (const m of res.messages ?? []) {
      if (m.data?.linkBody?.type !== 'follow') continue;
      const f = pick(m);
      if (typeof f === 'number') fids.push(f);
    }
    const token = res.nextPageToken;
    const more = !!token && token !== cursor && (res.messages?.length ?? 0) >= pageSize;
    return { fids, next: more ? token : undefined };
  };

  const profile = async (fid: number): Promise<User | undefined> => {
    const res = await getJson<UserDataResponse>(`${base}/v1/userDataByFid?fid=${fid}`);
    const u: User = { fid, username: `fid:${fid}`, displayName: '' };
    for (const m of res.messages ?? []) {
      const body = m.data?.userDataBody;
      if (!body?.value) continue;
      switch (body.type) {
        case 'USER_DATA_TYPE_USERNAME':
          u.username = body.value;
          break;
        case 'USER_DATA_TYPE_DISPLAY':
          u.displayName = body.value;
          break;
        case 'USER_DATA_TYPE_PFP':
          u.pfpUrl = body.value;
          break;
        case 'USER_DATA_TYPE_BIO':
          u.bio = body.value;
          break;
      }
    }
    if (!u.displayName) u.displayName = u.username;
    return u;
  };

  return {
    name: 'snapchain',
    async following(fid, cursor) {
      const { res } = await links('linksByFid', 'fid', fid, cursor);
      return toPage(res, cursor, (m) => m.data?.linkBody?.targetFid);
    },
    async followers(fid, cursor) {
      const { res } = await links('linksByTargetFid', 'target_fid', fid, cursor);
      return toPage(res, cursor, (m) => m.data?.fid);
    },
    async users(fids) {
      const out: User[] = [];
      let next = 0;
      const worker = async () => {
        while (next < fids.length) {
          const fid = fids[next++];
          try {
            const u = await profile(fid);
            if (u) out.push(u);
          } catch (err) {
            console.warn('[snapchain] profile failed', fid, err);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(profileConcurrency, fids.length) }, worker));
      return out;
    },
    async fidByName(name) {
      try {
        const r = await getJson<{ fid?: number }>(`${base}/v1/userNameProofByName?${new URLSearchParams({ name })}`);
        return typeof r.fid === 'number' && r.fid > 0 ? r.fid : undefined;
      } catch (err) {
        // The node answers 400 for a name with no proof.
        if (err instanceof HttpError && err.status < 500) return undefined;
        throw err;
      }
    },
    ...(castCache && {
      async lastCasts(fids: number[]) {
        const res = await fetch(castCache, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fids }), signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new HttpError(res.status, castCache);
        const body = (await res.json()) as { casts?: Record<string, number | null>; missing?: number[] };
        if (!body.casts || !Array.isArray(body.missing)) throw new Error('cast cache: bad answer');
        return { casts: new Map(Object.entries(body.casts).map(([f, t]) => [Number(f), t])), missing: body.missing };
      },
    }),
    async lastCast(fid) {
      const r = await getJson<CastResponse>(`${base}/v1/castsByFid?${new URLSearchParams({ fid: String(fid), pageSize: '1', reverse: 'true' })}`);
      const ts = r.messages?.[0]?.data?.timestamp;
      return typeof ts === 'number' ? FARCASTER_EPOCH_MS + ts * 1000 : null;
    },
  };
}

// GET with retry on 429/5xx and network errors (3 tries, 400ms·2^n backoff).
async function getJson<T>(url: string, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      // A stalled node must not hang the crawl; the timeout rejects into the retry path.
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (r.ok) return (await r.json()) as T;
      if (r.status !== 429 && r.status < 500) throw new HttpError(r.status, url);
      last = new HttpError(r.status, url);
    } catch (err) {
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      last = err;
    }
    await new Promise((res) => setTimeout(res, 400 * 2 ** i));
  }
  throw last;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}
