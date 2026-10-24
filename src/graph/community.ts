// Louvain modularity communities over an undirected weighted view of the follow graph.
// Deterministic: nodes visit in input order, ties keep the current community.

export type WEdge = { a: number; b: number; w: number };

// Returns a community index per node (0 = largest community); isolated nodes get their own.
export function louvain(n: number, edges: WEdge[], maxLevels = 8): number[] {
  let membership = Array.from({ length: n }, (_, i) => i);
  let levelN = n;
  let levelEdges = mergeEdges(edges);

  for (let level = 0; level < maxLevels; level++) {
    const { comm, moved } = localMove(levelN, levelEdges);
    if (!moved) break;
    const { index, count } = compact(comm);
    membership = membership.map((c) => index[comm[c]]);
    levelEdges = mergeEdges(levelEdges.map((e) => ({ a: index[comm[e.a]], b: index[comm[e.b]], w: e.w })));
    levelN = count;
  }
  return rankBySize(membership);
}

function mergeEdges(edges: WEdge[]): WEdge[] {
  const m = new Map<string, WEdge>();
  for (const e of edges) {
    const a = Math.min(e.a, e.b);
    const b = Math.max(e.a, e.b);
    const k = `${a},${b}`;
    const hit = m.get(k);
    if (hit) hit.w += e.w;
    else m.set(k, { a, b, w: e.w });
  }
  return [...m.values()];
}

function localMove(n: number, edges: WEdge[]): { comm: number[]; moved: boolean } {
  const adj: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  const k = new Float64Array(n);
  let m2 = 0;
  for (const e of edges) {
    if (e.a === e.b) {
      k[e.a] += 2 * e.w;
      m2 += 2 * e.w;
      continue;
    }
    adj[e.a].push([e.b, e.w]);
    adj[e.b].push([e.a, e.w]);
    k[e.a] += e.w;
    k[e.b] += e.w;
    m2 += 2 * e.w;
  }
  const comm = Array.from({ length: n }, (_, i) => i);
  if (m2 === 0) return { comm, moved: false };
  const tot = Float64Array.from(k);
  let moved = false;
  let improved = true;
  let passes = 0;
  const wTo = new Map<number, number>();
  while (improved && passes < 32) {
    improved = false;
    passes++;
    for (let i = 0; i < n; i++) {
      const ci = comm[i];
      wTo.clear();
      for (const [j, w] of adj[i]) wTo.set(comm[j], (wTo.get(comm[j]) ?? 0) + w);
      tot[ci] -= k[i];
      // Gain of joining c, up to a shared factor: w_ic - tot_c * k_i / 2m.
      let best = ci;
      let bestGain = (wTo.get(ci) ?? 0) - (tot[ci] * k[i]) / m2;
      for (const [c, w] of wTo) {
        const gain = w - (tot[c] * k[i]) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = c;
        }
      }
      tot[best] += k[i];
      if (best !== ci) {
        comm[i] = best;
        improved = true;
        moved = true;
      }
    }
  }
  return { comm, moved };
}

function compact(comm: number[]): { index: number[]; count: number } {
  const index: number[] = new Array(comm.length).fill(-1);
  let count = 0;
  for (const c of comm) if (index[c] === -1) index[c] = count++;
  return { index, count };
}

function rankBySize(membership: number[]): number[] {
  const size = new Map<number, number>();
  for (const c of membership) size.set(c, (size.get(c) ?? 0) + 1);
  const order = [...size.keys()].sort((x, y) => size.get(y)! - size.get(x)! || x - y);
  const rank = new Map(order.map((c, i) => [c, i]));
  return membership.map((c) => rank.get(c)!);
}
