import { test } from 'node:test';
import { nearYou } from '../src/ui/near.ts';
import assert from 'node:assert/strict';
import { louvain, type WEdge } from '../src/graph/community.ts';
import { crawlEgo, expandNode, DEFAULT_BUDGET, FollowSet } from '../src/data/crawl.ts';
import { sampleProvider, SAMPLE_EGO_FID } from '../src/data/sample.ts';
import { egoTie, type DataProvider } from '../src/data/types.ts';
import { tieFrom } from '../src/graph/view.ts';

test('louvain splits two cliques joined by one bridge', () => {
  const edges: WEdge[] = [];
  const clique = (ids: number[]) => {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) edges.push({ a: ids[i], b: ids[j], w: 1 });
  };
  clique([0, 1, 2, 3, 4]);
  clique([5, 6, 7, 8, 9]);
  edges.push({ a: 4, b: 5, w: 1 });
  const c = louvain(10, edges);
  assert.equal(new Set(c.slice(0, 5)).size, 1);
  assert.equal(new Set(c.slice(5)).size, 1);
  assert.notEqual(c[0], c[9]);
});

test('louvain leaves isolated nodes in their own community', () => {
  const c = louvain(3, []);
  assert.equal(new Set(c).size, 3);
});

test('FollowSet collapses a reciprocal pair into one mutual link', () => {
  const f = new FollowSet();
  f.add(1, 2);
  f.add(2, 1);
  f.add(1, 3);
  f.add(4, 4);
  const links = f.links(new Set([1, 2, 3, 4]));
  assert.equal(links.length, 2);
  assert.equal(links.find((l) => l.kind === 'mutual')?.source !== undefined, true);
  assert.equal(links.filter((l) => l.kind === 'follow').length, 1);
});

test('crawl on the sample network respects budgets and link integrity', async () => {
  const provider = sampleProvider();
  const { graph, follows } = await crawlEgo(provider, SAMPLE_EGO_FID, DEFAULT_BUDGET, () => undefined);
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.equal(ids.size, graph.nodes.length, 'node ids unique');
  assert.ok(graph.nodes.length <= DEFAULT_BUDGET.maxNodes);
  assert.equal(graph.nodes.filter((n) => n.hop === 0).length, 1);
  assert.ok(graph.nodes.filter((n) => n.hop === 1).length <= DEFAULT_BUDGET.maxFriends);
  for (const l of graph.links) assert.ok(ids.has(l.source) && ids.has(l.target), 'link ends exist');
  for (const n of graph.nodes) if (n.hop === 2) assert.ok(n.support >= DEFAULT_BUDGET.fofMinSupport);
  const comms = new Set(graph.nodes.filter((n) => n.hop > 0).map((n) => n.community));
  assert.ok(comms.size >= 2, `communities found: ${comms.size}`);

  const target = graph.nodes.find((n) => n.hop === 2)!;
  const before = graph.nodes.length;
  const r = await expandNode(provider, graph, follows, target, DEFAULT_BUDGET);
  assert.equal(graph.nodes.length, before + r.added);
  assert.ok(target.expanded);
  const ids2 = new Set(graph.nodes.map((n) => n.id));
  for (const l of graph.links) assert.ok(ids2.has(l.source) && ids2.has(l.target));
  for (const n of graph.nodes) if (n.hop > 0) assert.ok(n.community >= 0, `community seated for ${n.id}`);
});

test('nearYou ranks unfollowed accounts by how many of the ego follows follow them', async () => {
  const { graph } = await crawlEgo(sampleProvider(), SAMPLE_EGO_FID, DEFAULT_BUDGET, () => undefined);
  const picks = nearYou(graph);
  assert.ok(picks.length > 0 && picks.length <= 12);
  assert.ok(picks.every((p) => p.node.hop >= 2 && p.via.every((v) => v.hop === 1)));
  assert.ok(picks.every((p, i) => i === 0 || picks[i - 1].via.length >= p.via.length));
});

// A provider over a fixed follow map: followers are derived from it, profiles are stubs, pages hold `size` fids.
function fakeProvider(out: Record<number, number[]>, size = 1000): DataProvider {
  const inc = new Map<number, number[]>();
  for (const [a, list] of Object.entries(out)) for (const b of list) inc.set(b, [...(inc.get(b) ?? []), Number(a)]);
  const page = (list: number[], cursor?: string) => {
    const at = Number(cursor ?? 0);
    return { fids: list.slice(at, at + size), next: at + size < list.length ? String(at + size) : undefined };
  };
  return {
    name: 'fake',
    following: async (fid, cursor) => page(out[fid] ?? [], cursor),
    followers: async (fid, cursor) => page(inc.get(fid) ?? [], cursor),
    users: async (fids) => fids.map((fid) => ({ fid, username: `u${fid}`, displayName: `U${fid}` })),
    fidByName: async () => undefined,
  };
}

test('followers join the first ring, each node knows which way it follows the ego, and links keep direction', async () => {
  // Ego 1 follows only 2; 2, 3, 4, 5 follow ego; 9 and 10 are followed by two or more of them.
  const { graph } = await crawlEgo(fakeProvider({ 1: [2], 2: [1, 9], 3: [1, 9], 4: [1, 9, 10], 5: [1, 10] }), 1, DEFAULT_BUDGET, () => undefined);
  const hop = (h: number) => graph.nodes.filter((n) => n.hop === h).map((n) => n.id).sort();
  assert.deepEqual(hop(1), ['f2', 'f3', 'f4', 'f5']);
  assert.deepEqual(hop(2), ['f10', 'f9']);
  const tie = (id: string) => egoTie(graph.nodes.find((n) => n.id === id)!);
  assert.equal(tie('f2'), 'mutual');
  assert.equal(tie('f3'), 'follows-you');
  assert.equal(tie('f9'), 'none');
  const link = (a: string, b: string) => graph.links.find((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));
  assert.deepEqual(link('f1', 'f3'), { source: 'f3', target: 'f1', kind: 'follow', oneWay: true });
  assert.equal(link('f1', 'f2')?.kind, 'mutual');
});

test('a follow whose return was never read is not called one-way', async () => {
  // 9 follows 2 and 3 back, but 9's own list is never read (hop 2), so 2>9 and 3>9 stay undecided.
  const { graph } = await crawlEgo(fakeProvider({ 1: [2, 3], 2: [1, 9], 3: [1, 9], 9: [2, 3] }), 1, DEFAULT_BUDGET, () => undefined);
  const l = graph.links.find((x) => x.source === 'f2' && x.target === 'f9')!;
  assert.equal(l.kind, 'follow');
  assert.equal(l.oneWay, false);
  assert.equal(tieFrom({ ...l, target: { id: l.target } }, 'f9'), 'half');
  // The ego's lists were read in full, so 9's ties to the ego are known: neither way.
  assert.equal(egoTie(graph.nodes.find((n) => n.id === 'f9')!), 'none');
});

test('with follower pages unread, accounts you follow keep the circle places ahead of followers', async () => {
  // Pages of 2 and 2 follower pages: 4 of ego 1's 6 followers are read (2, 6, 7, 8); alternating would give 2, 3, 6, 4, 7, 8.
  const out = { 1: [2, 3, 4], 2: [1], 6: [1], 7: [1], 8: [1], 9: [1], 10: [1] };
  const { graph } = await crawlEgo(fakeProvider(out, 2), 1, { ...DEFAULT_BUDGET, egoFollowerPages: 2 }, () => undefined);
  assert.deepEqual(graph.nodes.filter((n) => n.hop === 1).map((n) => n.id), ['f2', 'f3', 'f4', 'f6', 'f7', 'f8']);
  // 9 and 10 were on unread pages: whether they follow the ego is not known.
  assert.ok(graph.nodes.every((n) => n.id !== 'f9'));
});

test('Near you leaves out accounts the ego already follows', async () => {
  // Circle capped at 2 keeps 9 (followed by the ego) at hop 2 beside 10.
  const out = { 1: [2, 3, 9], 2: [9, 10], 3: [9, 10] };
  const { graph } = await crawlEgo(fakeProvider(out), 1, { ...DEFAULT_BUDGET, maxFriends: 2 }, () => undefined);
  assert.equal(graph.nodes.find((n) => n.id === 'f9')?.hop, 2);
  assert.deepEqual(nearYou(graph).map((p) => p.node.id), ['f10']);
});

test('the first ring keeps mutuals first, then alternates accounts you follow and followers, up to the cap', async () => {
  // Ego follows 2-5; 2 follows back; 6, 7, 8 follow ego one way.
  const out = { 1: [2, 3, 4, 5], 2: [1], 6: [1], 7: [1], 8: [1] };
  const { graph } = await crawlEgo(fakeProvider(out), 1, { ...DEFAULT_BUDGET, maxFriends: 4 }, () => undefined);
  assert.deepEqual(graph.nodes.filter((n) => n.hop === 1).map((n) => n.id), ['f2', 'f3', 'f6', 'f4']);
  assert.ok(graph.truncated.includes('circle capped at 4'), graph.truncated.join('; '));
});

test('a link is coloured from one end: a follower comes in (green), a followed account goes out (blue)', () => {
  // f2 follows f1, not back.
  const oneWay = { kind: 'follow' as const, oneWay: true, target: { id: 'f1' } };
  assert.equal(tieFrom(oneWay, 'f1'), 'in');
  assert.equal(tieFrom(oneWay, 'f2'), 'out');
  assert.equal(tieFrom({ kind: 'mutual', oneWay: false, target: { id: 'f1' } }, 'f2'), 'mutual');
});
