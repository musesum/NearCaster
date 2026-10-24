// Ego-network crawl: ego -> friends (hop 1) -> friends-of-friends (hop 2), within fetch budgets.
import { louvain, type WEdge } from '../graph/community.ts';
import { idOf, type DataProvider, type EgoGraph, type GLink, type GNode, type Hop, type Page, type User } from './types.ts';

export type CrawlBudget = {
  // Hop-1 accounts kept (mutuals first).
  maxFriends: number;
  // Follower pages read for ego, used to mark mutuals.
  egoFollowerPages: number;
  // Following pages read per friend.
  pagesPerFriend: number;
  // A hop-2 account needs this many hop-1 friends following it.
  fofMinSupport: number;
  // Total node cap.
  maxNodes: number;
  // Parallel requests.
  concurrency: number;
};

// Sized for the Snapchain node: 500-link pages at ~490 B per link, uncompressed.
export const DEFAULT_BUDGET: CrawlBudget = {
  maxFriends: 60,
  egoFollowerPages: 2,
  pagesPerFriend: 1,
  fofMinSupport: 2,
  maxNodes: 300,
  concurrency: 6,
};

export type Progress = (text: string, frac: number) => void;

export async function pages(fetch1: (cursor?: string) => Promise<Page>, maxPages: number): Promise<{ fids: number[]; complete: boolean }> {
  const fids: number[] = [];
  let cursor: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    const page = await fetch1(cursor);
    fids.push(...page.fids);
    cursor = page.next;
    if (!cursor) return { fids, complete: true };
  }
  return { fids, complete: false };
}

export async function pool<T, R>(items: T[], limit: number, run: (item: T, i: number) => Promise<R>): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await run(items[i], i);
      } catch (err) {
        console.warn('[crawl] item failed', items[i], err);
        out[i] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export async function fetchUsers(provider: DataProvider, fids: number[], concurrency: number): Promise<Map<number, User>> {
  const BATCH = 100;
  const batches: number[][] = [];
  for (let i = 0; i < fids.length; i += BATCH) batches.push(fids.slice(i, i + BATCH));
  const got = await pool(batches, concurrency, (b) => provider.users(b));
  const map = new Map<number, User>();
  for (const list of got) for (const u of list ?? []) map.set(u.fid, u);
  return map;
}

function stub(fid: number): User {
  return { fid, username: `fid:${fid}`, displayName: `fid ${fid}` };
}

function makeNode(u: User, hop: Hop): GNode {
  return { ...u, id: idOf(u.fid), hop, mutualWithEgo: false, support: 0, community: -1, expanded: false };
}

// Follow edges as a directed set "a>b".
export class FollowSet {
  private set = new Set<string>();
  add(a: number, b: number): void {
    if (a !== b) this.set.add(`${a}>${b}`);
  }
  has(a: number, b: number): boolean {
    return this.set.has(`${a}>${b}`);
  }
  // Collapse into links; a reciprocal pair becomes one mutual link.
  links(keep: Set<number>): GLink[] {
    const out: GLink[] = [];
    const seen = new Set<string>();
    for (const k of this.set) {
      const [a, b] = k.split('>').map(Number);
      if (!keep.has(a) || !keep.has(b)) continue;
      const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const mutual = this.has(b, a);
      out.push({ source: idOf(a), target: idOf(b), kind: mutual ? 'mutual' : 'follow' });
    }
    return out;
  }
}

export async function crawlEgo(provider: DataProvider, egoFid: number, budget: CrawlBudget, progress: Progress, egoHint?: Partial<User>): Promise<{ graph: EgoGraph; follows: FollowSet }> {
  const truncated: string[] = [];
  progress('Reading who you follow', 0.02);
  const egoFollowing = await pages((c) => provider.following(egoFid, c), 4);
  progress('Reading your followers', 0.08);
  const egoFollowers = await pages((c) => provider.followers(egoFid, c), budget.egoFollowerPages);
  if (!egoFollowers.complete) truncated.push(`followers > ${egoFollowers.fids.length}`);
  const followerSet = new Set(egoFollowers.fids);

  const followingUnique = [...new Set(egoFollowing.fids)].filter((f) => f !== egoFid);
  // Mutuals first, then follow order from the provider.
  const ranked = [...followingUnique.filter((f) => followerSet.has(f)), ...followingUnique.filter((f) => !followerSet.has(f))];
  const friends = ranked.slice(0, budget.maxFriends);
  if (ranked.length > friends.length || !egoFollowing.complete) truncated.push(`friends capped at ${friends.length}`);

  const follows = new FollowSet();
  for (const f of followingUnique) follows.add(egoFid, f);
  for (const f of egoFollowers.fids) follows.add(f, egoFid);

  const friendSet = new Set(friends);
  const support = new Map<number, number>();
  let done = 0;
  let cut = 0;
  await pool(friends, budget.concurrency, async (f) => {
    const out = await pages((c) => provider.following(f, c), budget.pagesPerFriend);
    if (!out.complete) cut++;
    for (const g of out.fids) {
      follows.add(f, g);
      if (g !== egoFid && !friendSet.has(g)) support.set(g, (support.get(g) ?? 0) + 1);
    }
    done++;
    progress(`Reading friends' follows ${done}/${friends.length}`, 0.1 + 0.7 * (done / friends.length));
  });

  if (cut) truncated.push(`${cut} of ${friends.length} friends' follow lists read in part`);
  const room = Math.max(0, budget.maxNodes - friends.length - 1);
  const fofAll = [...support.entries()].filter(([, s]) => s >= budget.fofMinSupport).sort((x, y) => y[1] - x[1] || x[0] - y[0]);
  const fof = fofAll.slice(0, room).map(([f]) => f);
  if (fofAll.length > fof.length) truncated.push(`friends-of-friends capped at ${fof.length} of ${fofAll.length}`);

  progress('Reading profiles', 0.85);
  const all = [egoFid, ...friends, ...fof];
  const profiles = await fetchUsers(provider, all, budget.concurrency);

  const nodes: GNode[] = [];
  // The fetched profile wins; the hint fills gaps; the fid is never the hint's.
  const egoUser = { ...stub(egoFid), ...knownOnly(egoHint), ...knownOnly(profiles.get(egoFid)), fid: egoFid };
  const ego = makeNode(egoUser, 0);
  ego.expanded = true;
  nodes.push(ego);
  for (const f of friends) {
    const n = makeNode(profiles.get(f) ?? stub(f), 1);
    // Ego's follower pages may be partial; the friend's own list closes the gap.
    n.mutualWithEgo = followerSet.has(f) || follows.has(f, egoFid);
    n.expanded = true;
    nodes.push(n);
  }
  for (const f of fof) {
    const n = makeNode(profiles.get(f) ?? stub(f), 2);
    n.support = support.get(f) ?? 0;
    n.mutualWithEgo = followerSet.has(f) && follows.has(egoFid, f);
    nodes.push(n);
  }
  for (const n of nodes) if (n.hop === 1) n.support = countSupport(follows, friends, n.fid);

  const keep = new Set(all);
  const links = follows.links(keep);
  const graph: EgoGraph = { egoId: ego.id, nodes, links, provider: provider.name, truncated };
  assignCommunities(graph);
  progress('Laying out', 1);
  return { graph, follows };
}

function countSupport(follows: FollowSet, friends: number[], fid: number): number {
  let s = 0;
  for (const f of friends) if (f !== fid && follows.has(f, fid)) s++;
  return s;
}

// Drops empty fields and "fid:N" stubs (a hub with no username message), so a real name survives the merge.
function knownOnly<T extends object>(o?: T): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(typeof v === 'string' && v.startsWith('fid:')))) as Partial<T>;
}

// Ego is excluded: its star would merge every community into one.
export function assignCommunities(graph: EgoGraph): void {
  const index = new Map<string, number>();
  const members = graph.nodes.filter((n) => n.id !== graph.egoId);
  members.forEach((n, i) => index.set(n.id, i));
  const edges: WEdge[] = [];
  for (const l of graph.links) {
    const a = index.get(l.source);
    const b = index.get(l.target);
    if (a === undefined || b === undefined) continue;
    edges.push({ a, b, w: l.kind === 'mutual' ? 2 : 1 });
  }
  const comm = louvain(members.length, edges);
  members.forEach((n, i) => (n.community = comm[i]));
  const ego = graph.nodes.find((n) => n.id === graph.egoId);
  if (ego) ego.community = -1;
}

// Vizster "expand": read one node's follows, link it into the graph, add up to `addCap` new accounts.
export async function expandNode(provider: DataProvider, graph: EgoGraph, follows: FollowSet, node: GNode, budget: CrawlBudget, addCap = 24): Promise<{ added: number; linked: number }> {
  const out = await pages((c) => provider.following(node.fid, c), budget.pagesPerFriend);
  const inc = await pages((c) => provider.followers(node.fid, c), 1);
  const have = new Map(graph.nodes.map((n) => [n.fid, n]));
  for (const g of out.fids) follows.add(node.fid, g);
  for (const g of inc.fids) follows.add(g, node.fid);
  node.expanded = true;

  // New accounts: those the node follows that already-known nodes also follow, best first.
  const known = [...have.keys()];
  const fresh = [...new Set(out.fids)].filter((f) => !have.has(f) && f !== node.fid);
  const score = (f: number) => known.reduce((s, k) => s + (follows.has(k, f) ? 1 : 0), 0) + (follows.has(f, node.fid) ? 2 : 0);
  const room = Math.max(0, budget.maxNodes + 200 - graph.nodes.length);
  const pick = fresh.map((f) => [f, score(f)] as const).sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, Math.min(addCap, room)).map(([f]) => f);

  const profiles = pick.length ? await fetchUsers(provider, pick, budget.concurrency) : new Map<number, User>();
  const hop = Math.min(3, node.hop + 1) as Hop;
  // The node set may have grown during the awaits above.
  const present = new Set(graph.nodes.map((n) => n.fid));
  let added = 0;
  for (const f of pick) {
    if (present.has(f)) continue;
    present.add(f);
    added++;
    const n = makeNode(profiles.get(f) ?? stub(f), hop);
    n.support = 1;
    graph.nodes.push(n);
  }

  const keep = new Set(graph.nodes.map((n) => n.fid));
  const before = graph.links.length;
  graph.links = follows.links(keep);
  seatNewcomers(graph, node);
  return { added, linked: graph.links.length - before };
}

// Newcomers join their neighbours' plurality community; settled communities stay put.
function seatNewcomers(graph: EgoGraph, parent: GNode): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    if (n.community !== -1 || n.id === graph.egoId) continue;
    const tally = new Map<number, number>();
    for (const l of graph.links) {
      const other = l.source === n.id ? l.target : l.target === n.id ? l.source : undefined;
      const c = other ? byId.get(other)?.community : undefined;
      if (c !== undefined && c >= 0) tally.set(c, (tally.get(c) ?? 0) + (l.kind === 'mutual' ? 2 : 1));
    }
    let best = parent.community;
    let bestW = -1;
    for (const [c, w] of tally) if (w > bestW || (w === bestW && c < best)) [best, bestW] = [c, w];
    n.community = best;
  }
}
