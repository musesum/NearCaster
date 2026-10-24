// Snapchain (Farcaster hub) HTTP API provider. The public node answers with CORS "*" and needs no key.
// Links are ~490 bytes each and uncompressed, so page sizes stay modest.
import type { DataProvider, Page, User } from './types.ts';

export const DEFAULT_HUB = 'https://snap.farcaster.xyz:3381';

type LinkMessage = { data?: { fid?: number; linkBody?: { type?: string; targetFid?: number } } };
type LinkResponse = { messages?: LinkMessage[]; nextPageToken?: string };
type UserDataMessage = { data?: { userDataBody?: { type?: string; value?: string } } };
type UserDataResponse = { messages?: UserDataMessage[] };

export type SnapchainOptions = { base?: string; pageSize?: number; profileConcurrency?: number };

export function snapchainProvider(opts: SnapchainOptions = {}): DataProvider {
  const base = (opts.base ?? DEFAULT_HUB).replace(/\/$/, '');
  const pageSize = opts.pageSize ?? 500;
  const profileConcurrency = opts.profileConcurrency ?? 8;

  const links = async (path: string, key: 'fid' | 'target_fid', fid: number, cursor?: string): Promise<{ res: LinkResponse }> => {
    const q = new URLSearchParams({ [key]: String(fid), link_type: 'follow', pageSize: String(pageSize) });
    if (cursor) q.set('pageToken', cursor);
    return { res: await getJson<LinkResponse>(`${base}/v1/${path}?${q}`) };
  };

  const toPage = (res: LinkResponse, pick: (m: LinkMessage) => number | undefined): Page => {
    const fids: number[] = [];
    for (const m of res.messages ?? []) {
      if (m.data?.linkBody?.type !== 'follow') continue;
      const f = pick(m);
      if (typeof f === 'number') fids.push(f);
    }
    return { fids, next: res.nextPageToken || undefined };
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
      return toPage(res, (m) => m.data?.linkBody?.targetFid);
    },
    async followers(fid, cursor) {
      const { res } = await links('linksByTargetFid', 'target_fid', fid, cursor);
      return toPage(res, (m) => m.data?.fid);
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
