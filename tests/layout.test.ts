import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlEgo, DEFAULT_BUDGET } from '../src/data/crawl.ts';
import { sampleProvider, SAMPLE_EGO_FID } from '../src/data/sample.ts';
import { Layout, type SimLink, type SimNode } from '../src/graph/layout.ts';

(globalThis as unknown as { window: unknown }).window = globalThis;

async function fixture() {
  const { graph } = await crawlEgo(sampleProvider(), SAMPLE_EGO_FID, DEFAULT_BUDGET, () => undefined);
  const nodes: SimNode[] = graph.nodes.map((g) => ({ ...g, r: g.hop === 0 ? 18 : g.hop === 1 ? 9 : 5 }) as SimNode);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ego = byId.get(graph.egoId)!;
  for (const n of nodes) if (n.hop === 1) n.dad = ego;
  const links: SimLink[] = graph.links.map((l) => ({ ...l, source: byId.get(l.source)!, target: byId.get(l.target)!, ego: l.source === graph.egoId || l.target === graph.egoId }));
  for (const n of nodes) {
    if (n.hop < 2) continue;
    const l = links.find((x) => (x.source === n && x.target.hop === 1) || (x.target === n && x.source.hop === 1));
    n.dad = l ? (l.source === n ? l.target : l.source) : undefined;
  }
  return { nodes, links, ego };
}

const land = () => new Promise((r) => setTimeout(r, 500));

test('solveFit settles to finite positions with the ego pinned at the origin', async () => {
  const { nodes, links, ego } = await fixture();
  const L = new Layout(() => undefined, () => undefined);
  L.setNodes(nodes);
  L.seedRadial();
  let fitted = 0;
  L.solveFit(nodes, links, (to) => (fitted = to.size));
  await land();
  assert.equal(fitted, nodes.length);
  assert.ok(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  assert.deepEqual([ego.x, ego.y], [0, 0]);
  assert.equal(L.alpha, 0);
  // Radial bands: hop 2 sits further out than hop 1 on average.
  const mean = (h: number) => {
    const r = nodes.filter((n) => n.hop === h).map((n) => Math.hypot(n.x!, n.y!));
    return r.reduce((a, b) => a + b, 0) / r.length;
  };
  assert.ok(mean(2) > mean(1), `hop2 ${mean(2).toFixed(0)} > hop1 ${mean(1).toFixed(0)}`);
});

test('Focus snapshot restores every position exactly', async () => {
  const { nodes, links } = await fixture();
  const L = new Layout(() => undefined, () => undefined);
  L.setNodes(nodes);
  L.seedRadial();
  L.solveFit(nodes, links, () => undefined);
  await land();
  const before = nodes.map((n) => [n.x, n.y]);
  const snap = L.focusSnap();
  L.focusMode = true;
  const subset = nodes.filter((n) => n.hop <= 1);
  const subLinks = links.filter((l) => l.source.hop <= 1 && l.target.hop <= 1);
  L.solveFit(subset, subLinks, () => undefined);
  await land();
  L.focusMode = false;
  L.focusRestore(snap, nodes, links);
  await land();
  const drift = Math.max(...nodes.map((n, i) => Math.hypot(n.x! - before[i][0]!, n.y! - before[i][1]!)));
  assert.equal(drift, 0);
});

test('reheatLocal with an identical visible set changes nothing', async () => {
  const { nodes, links } = await fixture();
  const L = new Layout(() => undefined, () => undefined);
  L.setNodes(nodes);
  L.seedRadial();
  L.solveFit(nodes, links, () => undefined);
  await land();
  const before = nodes.map((n) => [n.x, n.y]);
  L.reheatLocal(nodes, links, []);
  await land();
  const drift = Math.max(...nodes.map((n, i) => Math.hypot(n.x! - before[i][0]!, n.y! - before[i][1]!)));
  assert.equal(drift, 0);
  assert.equal(L.alpha, 0);
});

test('guard forces repair a non-finite node instead of poisoning the field', async () => {
  const { nodes, links } = await fixture();
  const L = new Layout(() => undefined, () => undefined);
  L.setNodes(nodes);
  L.seedRadial();
  L.solveFit(nodes, links, () => undefined);
  await land();
  const victim = nodes.find((n) => n.hop === 2)!;
  victim.x = Infinity;
  victim.vy = Number.NaN;
  L.sim.alpha(0.1);
  for (let i = 0; i < 5; i++) L.sim.tick();
  L.sim.stop();
  assert.ok(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), 'all finite after repair');
});

test('Focus exit holds only pinned nodes: freezes clear, Focus pins and releases stand', async () => {
  const { nodes, links } = await fixture();
  const L = new Layout(() => undefined, () => undefined);
  L.setNodes(nodes);
  L.seedRadial();
  L.solveFit(nodes, links, () => undefined);
  await land();
  // A links-only local reheat (no seeds) freezes the field; Focus is entered while it is still frozen.
  L.reheatLocal(nodes, links.slice(0, -1), []);
  assert.ok(nodes.some((n) => n.fx != null && !n.pinned), 'far field frozen');
  const snap = L.focusSnap();
  L.focusMode = true;
  const subset = nodes.filter((n) => n.hop <= 1);
  L.solveFit(subset, links.filter((l) => l.source.hop <= 1 && l.target.hop <= 1), () => undefined);
  await land();
  const pinIn = subset.find((n) => n.hop === 1)!;
  L.togglePin(pinIn);
  L.focusMode = false;
  L.focusRestore(snap, nodes, links);
  await land();
  const held = nodes.filter((n) => n.fx != null);
  assert.ok(held.every((n) => n.pinned), `unpinned but held: ${held.filter((n) => !n.pinned).length}`);
  assert.ok(pinIn.pinned && pinIn.fx === pinIn.x, 'pin made in Focus stands');
});

test('focusSnap during a flight records the landed layout', async () => {
  const { nodes, links } = await fixture();
  const L = new Layout(() => undefined, () => undefined);
  L.setNodes(nodes);
  L.seedRadial();
  L.solveFit(nodes, links, () => undefined);
  const snap = L.focusSnap();
  const landed = nodes.map((n) => [n.x!, n.y!]);
  const drift = Math.max(...nodes.map((n, i) => Math.hypot(snap.pos.get(n.id)![0] - landed[i][0], snap.pos.get(n.id)![1] - landed[i][1])));
  assert.equal(drift, 0);
});
