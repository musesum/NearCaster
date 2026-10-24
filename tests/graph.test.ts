import { test } from 'node:test';
import { nearYou } from '../src/ui/near.ts';
import assert from 'node:assert/strict';
import { louvain, type WEdge } from '../src/graph/community.ts';
import { crawlEgo, expandNode, DEFAULT_BUDGET, FollowSet } from '../src/data/crawl.ts';
import { sampleProvider, SAMPLE_EGO_FID } from '../src/data/sample.ts';

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
