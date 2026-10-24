// Offline provider: a seeded synthetic network with planted communities, for dev and fallback.
import type { DataProvider, Page, User } from './types.ts';

const SYL = ['ka', 'zu', 'mi', 'ro', 'te', 'la', 'no', 'vi', 'sa', 'de', 'po', 'ri', 'xa', 'lu', 'me', 'jo', 'fe', 'qi'];
const CLUSTERS = ['builders', 'artists', 'degens', 'musicians', 'devs', 'writers', 'founders'];
const PAGE = 100;

export const SAMPLE_EGO_FID = 1000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Net = { users: Map<number, User>; out: Map<number, number[]>; inc: Map<number, number[]> };

function buildNet(seed: number, count: number): Net {
  const rnd = mulberry32(seed);
  const users = new Map<number, User>();
  const cluster = new Map<number, number>();
  const fids: number[] = [];
  for (let i = 0; i < count; i++) {
    const fid = SAMPLE_EGO_FID + i;
    const c = i === 0 ? 0 : Math.floor(rnd() * CLUSTERS.length);
    const name = SYL[Math.floor(rnd() * SYL.length)] + SYL[Math.floor(rnd() * SYL.length)] + SYL[Math.floor(rnd() * SYL.length)];
    const username = i === 0 ? 'you' : `${name}${i % 7 === 0 ? '.eth' : ''}`;
    users.set(fid, {
      fid,
      username,
      displayName: i === 0 ? 'You (sample)' : name[0].toUpperCase() + name.slice(1),
      bio: i === 0 ? 'Sample ego account' : `Into ${CLUSTERS[c]}`,
    });
    cluster.set(fid, c);
    fids.push(fid);
  }
  const byCluster = CLUSTERS.map((_, c) => fids.filter((f) => cluster.get(f) === c));
  const out = new Map<number, number[]>();
  const inc = new Map<number, number[]>();
  const add = (a: number, b: number, set: Set<number>) => {
    if (a === b || set.has(b)) return;
    set.add(b);
    if (!inc.has(b)) inc.set(b, []);
    inc.get(b)!.push(a);
  };
  for (const fid of fids) {
    const set = new Set<number>();
    const own = byCluster[cluster.get(fid)!];
    // Heavy-tailed degree: most accounts follow a few dozen, some follow hundreds.
    const deg = fid === SAMPLE_EGO_FID ? 70 : Math.floor(8 + 60 * Math.pow(rnd(), 2.2));
    for (let k = 0; k < deg; k++) {
      const pool = rnd() < 0.82 ? own : fids;
      // Popular accounts (low index within pool) draw more follows.
      const pick = pool[Math.floor(Math.pow(rnd(), 1.8) * pool.length)];
      add(fid, pick, set);
    }
    out.set(fid, [...set]);
  }
  // Reciprocity: about 40% of follows are returned.
  for (const [a, list] of out) {
    for (const b of list) {
      const back = out.get(b)!;
      if (!back.includes(a) && rnd() < 0.4) {
        back.push(a);
        if (!inc.has(a)) inc.set(a, []);
        inc.get(a)!.push(b);
      }
    }
  }
  for (const [fid, u] of users) {
    u.followingCount = out.get(fid)?.length ?? 0;
    u.followerCount = inc.get(fid)?.length ?? 0;
  }
  return { users, out, inc };
}

function page(list: number[], cursor?: string): Page {
  const start = cursor ? Number(cursor) : 0;
  const fids = list.slice(start, start + PAGE);
  const end = start + fids.length;
  return { fids, next: end < list.length ? String(end) : undefined };
}

export function sampleProvider(seed = 7, count = 900): DataProvider {
  const net = buildNet(seed, count);
  const delay = () => new Promise((r) => setTimeout(r, 15));
  return {
    name: 'sample',
    async following(fid, cursor) {
      await delay();
      return page(net.out.get(fid) ?? [], cursor);
    },
    async followers(fid, cursor) {
      await delay();
      return page(net.inc.get(fid) ?? [], cursor);
    },
    async users(fids) {
      await delay();
      return fids.map((f) => net.users.get(f)).filter((u): u is User => u !== undefined);
    },
  };
}
