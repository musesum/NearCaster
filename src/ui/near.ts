// "Near you": friends of friends the ego does not follow, ranked by how many of the ego's follows follow them.
import type { EgoGraph, GNode } from '../data/types.ts';

export type NearPick = { node: GNode; via: GNode[] };

export function nearYou(graph: EgoGraph, limit = 12): NearPick[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const via = new Map<string, GNode[]>();
  for (const l of graph.links) {
    // A hop-1 account following a deeper one (either end of a mutual link).
    const pairs: Array<[string, string]> = [[l.source, l.target]];
    if (l.kind === 'mutual') pairs.push([l.target, l.source]);
    for (const [a, b] of pairs) {
      const from = byId.get(a);
      const to = byId.get(b);
      if (!from || !to || from.hop !== 1 || to.hop < 2) continue;
      const list = via.get(to.id) ?? [];
      list.push(from);
      via.set(to.id, list);
    }
  }
  return [...via.entries()]
    .map(([id, v]) => ({ node: byId.get(id)!, via: v }))
    .sort((a, b) => b.via.length - a.via.length || a.node.fid - b.node.fid)
    .slice(0, limit);
}
