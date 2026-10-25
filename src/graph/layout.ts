// Force layout ported from DeepMuse LeafGraph (MuMenu flod3-embed.html, BUILD_TOKEN flod3-v4e0).
// Calm contract:
// - structure changes go through solveFit(): settle synchronously from alpha <= 0.3, then fly 420 ms
// - selection, hover, and search move 0 px (paint only)
// - local edits (expand) seed newcomers beside their dad, freeze the far field, reheatAlpha()
// - alpha rises only in reheatAlpha() (alphaTarget 0.12 for 300 ms); never alpha 1, never a timer loop
// - no-op guard: identical visible ids + link wires => nothing to do
// - forces: guardIn, charge, link, voro, comm, ring, polar, guardOut; ego pinned at (0,0)
// - guard forces at both ends: VEL_MAX clamp, non-finite repair (v3e blowup classes A-C)
// - drag (mouse) moves only the dragged node, pins it on drop, voro parts its neighbours
import * as d3 from 'd3';
import { egoTie, type GNode, type LinkKind } from '../data/types.ts';

export type SimNode = GNode &
  d3.SimulationNodeDatum & {
    r: number;
    pinned?: boolean;
    dad?: SimNode;
    kids?: number;
    seedAngle?: number;
    ringR?: number;
  };
export type SimLink = { source: SimNode; target: SimNode; kind: LinkKind; oneWay?: boolean; ego: boolean; tree?: boolean };

export const TUNE = {
  charge: -50,
  chargeMax: 240,
  theta: 0.9,
  childDist: 16,
  edgeDist: 52,
  labelTerm: 0.6,
  fanout: 3.5,
  childStrength: 2.4,
  edgeStrength: 0.8,
  springMutual: 1,
  springFollow: 0.5,
  lengthMutual: 0.8,
  lengthFollow: 1.2,
  extraComm: 0.25,
  linkIters: 3,
  velocityDecay: 0.55,
  alphaDecay: 0.045,
  reheatTarget: 0.12,
  reheatHold: 300,
  reheatHops: 3,
  polarWeight: 0.05,
  commPull: 0.08,
  // Radial bands about the ego: hop sets the band, support sets the depth inside it.
  // Dense follow graphs (mean degree ~55) collapse into one blob without a firm band.
  ringWeight: 0.5,
  ringGap: 110,
  ringBand: 120,
  voroMargin: 4,
};

// Effective tree spring numerator above ~2.64 overshoots under 3 link iterations (v3e class A).
const SPRING_CAP = 2.6;
const VEL_MAX = 10_000;
const VORO_STEP = 40;
const SEED_RING = 62;
const SEED_JITTER = 6;
// The bands never shrink below this share of their full spacing.
const RING_SCALE_MIN = 0.35;
const THAW_ALPHA = 0.005;
const ALPHA_MIN = 0.001;
const SOLVE_ALPHA = 0.3;
const SOLVE_TICKS = 300;
const ANIM_MS = 420;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

type Polar = { r: number; th: number };
type Snap = { pos: Map<string, [number, number]>; base: Map<string, Polar> };

export class Layout {
  readonly sim: d3.Simulation<SimNode, SimLink>;
  focusMode = false;
  private all: SimNode[] = [];
  private vis: SimNode[] = [];
  private links: SimLink[] = [];
  private adj = new Map<string, SimNode[]>();
  private linkDeg = new Map<string, number>();
  private signature = '';
  private base = new Map<string, Polar>();
  private baseWant = false;
  private frozen = new Set<SimNode>();
  private coolTimer = 0;
  private flight?: d3.Timer;
  private r1 = 160;
  // Band spacing factor: 1 for the whole graph, smaller when Time shows a share of it.
  private ringScale = 1;
  private onTick: () => void;
  private onSettled: () => void;

  constructor(onTick: () => void, onSettled: () => void) {
    this.onTick = onTick;
    this.onSettled = onSettled;
    this.sim = d3
      .forceSimulation<SimNode, SimLink>()
      .velocityDecay(TUNE.velocityDecay)
      .alphaDecay(TUNE.alphaDecay)
      .alphaMin(ALPHA_MIN)
      .randomSource(d3.randomLcg(1))
      .stop()
      .on('tick', () => this.tick())
      .on('end', () => this.onSettled());
  }

  get alpha(): number {
    return this.sim.alpha();
  }

  get flying(): boolean {
    return this.flight !== undefined;
  }

  // Whole node set (visible or not), for seeding and anchors.
  setNodes(all: SimNode[]): void {
    this.all = all;
  }

  // Warm re-solves fold the bands around the ego to one side, a little more each time; a re-solve
  // from the seed cannot accumulate. An expand's frozen far field is not a pin: it seeds like the rest.
  // With `vis` (Time hid accounts), the bands shrink with the share shown, so a sparse graph sits close.
  reseed(vis?: SimNode[]): void {
    this.thawFar();
    this.seedRadial(vis);
    this.base.clear();
  }

  // Deterministic radial seed: hop 1 on a ring sorted by community, deeper hops fanned around their dad.
  seedRadial(vis?: SimNode[]): void {
    const shown = vis ? new Set(vis) : undefined;
    const counted = (n: SimNode) => !shown || shown.has(n);
    // Band area follows the number of accounts, so radii follow its square root.
    this.ringScale = shown ? Math.min(1, Math.max(RING_SCALE_MIN, Math.sqrt(shown.size / Math.max(1, this.all.length)))) : 1;
    const ego = this.all.find((n) => n.hop === 0);
    if (ego) {
      ego.x = ego.fx = 0;
      ego.y = ego.fy = 0;
      ego.pinned = true;
    }
    const ring = this.all.filter((n) => n.hop === 1 && counted(n)).sort((a, b) => a.community - b.community || Number(egoTie(b) === 'mutual') - Number(egoTie(a) === 'mutual') || a.fid - b.fid);
    const meanCap = d3.mean(ring, (n) => n.r * 2) ?? 14;
    this.r1 = Math.max(160 * this.ringScale, (ring.length * (meanCap + 8)) / (2 * Math.PI));
    ring.forEach((n, i) => {
      const th = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, ring.length);
      n.seedAngle = th;
      // A pinned node holds its place through a re-seed.
      if (n.pinned) return;
      n.x = this.r1 * Math.cos(th);
      n.y = this.r1 * Math.sin(th);
      n.vx = n.vy = 0;
    });
    this.seedEntering(this.all.filter((n) => n.hop >= 2 && !n.pinned && counted(n)).map((n) => ((n.x = undefined), n)));
  }

  // seedEntering (P:1961-1988), adapted to bands: unplaced nodes fan out on their own band,
  // centred on their dad's bearing from the ego; shallowest first, golden-angle jitter.
  seedEntering(nodes: SimNode[]): SimNode[] {
    const fresh = nodes.filter((n) => n.x === undefined || !Number.isFinite(n.x)).sort((a, b) => a.hop - b.hop || b.support - a.support || a.fid - b.fid);
    if (fresh.length) this.assignRings();
    const byDad = d3.group(fresh, (n) => n.dad?.id ?? '');
    for (const [, group] of byDad) {
      const dad = group[0].dad;
      const want = group.length;
      const bearing = dad && Number.isFinite(dad.x) && (dad.x || dad.y) ? Math.atan2(dad.y!, dad.x!) : (dad?.seedAngle ?? 0);
      const span = Math.min(1.4 * Math.PI, 0.09 * Math.max(0, want - 1));
      group.forEach((n, i) => {
        const th = bearing - span / 2 + (want > 1 ? (span * i) / (want - 1) : 0);
        const rr = n.ringR ?? this.r1 + TUNE.ringGap * this.ringScale;
        const jit = SEED_JITTER * Math.sqrt(i + 1);
        n.seedAngle = th;
        n.x = rr * Math.cos(th) + jit * Math.cos(i * GOLDEN);
        n.y = rr * Math.sin(th) + jit * Math.sin(i * GOLDEN);
        n.vx = n.vy = 0;
      });
    }
    return fresh;
  }

  // The one recalc chokepoint: settle the visible set synchronously, then fly there.
  // `from` = where the flight starts when the caller re-seeded first.
  solveFit(vis: SimNode[], links: SimLink[], fit: (target: Map<SimNode, [number, number]>) => void, from?: Map<SimNode, [number, number]>): void {
    this.flightAbort();
    from ??= new Map(this.all.map((n) => [n, [n.x ?? 0, n.y ?? 0] as [number, number]]));
    this.thawFar();
    // Seed before bind: d3's initializeNodes would otherwise spiral-place unplaced nodes.
    this.seedEntering(vis);
    this.bind(vis, links);
    this.reheatCancel();
    this.sim.alpha(SOLVE_ALPHA).alphaTarget(0);
    for (let i = 0; i < SOLVE_TICKS && this.sim.alpha() >= ALPHA_MIN; i++) this.sim.tick();
    this.sim.alpha(0).stop();
    for (const n of vis) n.vx = n.vy = 0;
    if (!this.focusMode) this.captureBase();
    const to = new Map(vis.map((n) => [n, [n.x!, n.y!] as [number, number]]));
    fit(to);
    this.fly(from, to);
  }

  // Local edit: newcomers seeded beside their dad, far field frozen, a short warm pulse.
  reheatLocal(vis: SimNode[], links: SimLink[], seeds: SimNode[]): void {
    const sig = this.sigOf(vis, links);
    if (sig === this.signature) return;
    this.flightLand();
    const entering = this.seedEntering(vis);
    this.bind(vis, links);
    this.freezeFar([...seeds, ...entering]);
    this.baseWant = true;
    this.reheatAlpha();
  }

  // Paint-only refresh of the bound arrays (Context, hover, search).
  bindQuiet(vis: SimNode[], links: SimLink[]): void {
    if (this.sigOf(vis, links) === this.signature) return;
    this.bind(vis, links);
  }

  reheatAlpha(): void {
    this.sim.alphaTarget(TUNE.reheatTarget).restart();
    clearTimeout(this.coolTimer);
    this.coolTimer = window.setTimeout(() => this.sim.alphaTarget(0), TUNE.reheatHold);
  }

  // Focus enter records every placed node and its pin; exit puts them back exactly.
  focusSnap(): Snap {
    this.flightLand();
    return { pos: new Map(this.all.filter((n) => n.x !== undefined).map((n) => [n.id, [n.x!, n.y!]])), base: new Map(this.base) };
  }

  focusRestore(snap: Snap, vis: SimNode[], links: SimLink[]): void {
    this.flightAbort();
    this.reheatCancel();
    this.sim.stop();
    this.thawFar();
    const from = new Map(this.all.map((n) => [n, [n.x ?? 0, n.y ?? 0] as [number, number]]));
    for (const n of this.all) {
      const p = snap.pos.get(n.id);
      if (!p) continue;
      // Positions come back; holds follow the live pin flag (pins made or released in Focus stand).
      [n.x, n.y] = p;
      n.fx = n.pinned ? n.x : null;
      n.fy = n.pinned ? n.y : null;
      n.vx = n.vy = 0;
    }
    // A capture queued by a Focus-time reheat would overwrite the restored base.
    this.base = new Map(snap.base);
    this.baseWant = false;
    this.seedEntering(vis);
    this.bind(vis, links);
    const to = new Map(vis.map((n) => [n, [n.x!, n.y!] as [number, number]]));
    this.fly(from, to);
  }

  togglePin(n: SimNode): void {
    if (n.hop === 0) return;
    // A running flight rewrites fx of nodes it captured as pinned.
    this.flightLand();
    n.pinned = !n.pinned;
    if (n.pinned) {
      n.fx = n.x;
      n.fy = n.y;
    } else {
      n.fx = null;
      n.fy = null;
      this.reheatAlpha();
    }
  }

  // `scale` = screen px per world unit; a tap's jitter under 8 screen px moves nothing.
  drag(scale: () => number): d3.DragBehavior<SVGGElement, SimNode, SimNode | d3.SubjectPosition> {
    let from: [number, number] = [0, 0];
    let start: [number, number] = [0, 0];
    let lastVoro = 0;
    let moving = false;
    return d3
      .drag<SVGGElement, SimNode>()
      .clickDistance(8)
      // Mouse only: a finger scrubs the hover preview (graph/touch.ts).
      .touchable(() => false)
      .filter((event: MouseEvent) => !event.button)
      .on('start', (e: d3.D3DragEvent<SVGGElement, SimNode, SimNode>) => {
        from = [e.x, e.y];
        moving = false;
      })
      .on('drag', (e: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        if (d.hop === 0) return;
        if (!moving) {
          if (Math.hypot(e.x - from[0], e.y - from[1]) * scale() < 8) return;
          // The flight lands on the first real move, not on the press.
          moving = true;
          this.flightLand();
          this.frozen.delete(d);
          start = [d.x ?? 0, d.y ?? 0];
        }
        d.x = d.fx = start[0] + (e.x - from[0]);
        d.y = d.fy = start[1] + (e.y - from[1]);
        d.vx = d.vy = 0;
        const now = performance.now();
        if (now - lastVoro > 90) {
          lastVoro = now;
          this.voroPass(0.5, d);
        }
        this.onTick();
      })
      .on('end', (_e: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        if (!moving || d.hop === 0) return;
        moving = false;
        // The drop holds the node where the hand left it.
        d.pinned = true;
        d.fx = d.x;
        d.fy = d.y;
        for (let i = 0; i < 6; i++) this.voroPass(0.5, d);
        if (!this.focusMode) this.setBase(d);
        this.onTick();
        this.onSettled();
      });
  }

  private tick(): void {
    this.thawWhenCold();
    this.onTick();
  }

  private sigOf(vis: SimNode[], links: SimLink[]): string {
    return vis.map((n) => n.id).join(',') + '|' + links.map((l) => `${l.source.id}>${l.target.id}`).join(',');
  }

  private bind(vis: SimNode[], links: SimLink[]): void {
    this.signature = this.sigOf(vis, links);
    this.vis = vis;
    this.links = links;
    this.adj = new Map(vis.map((n) => [n.id, []]));
    for (const l of links) {
      this.adj.get(l.source.id)?.push(l.target);
      this.adj.get(l.target.id)?.push(l.source);
    }
    this.assignRings();
    this.sim.nodes(vis);
    this.installForces();
  }

  private installForces(): void {
    // Ego links are drawn, not sprung: the ring force holds hop 1 at R1 around the pinned ego.
    // Focus turns the ring off, so there they spring, or an account linked only to the ego drifts off.
    const sprung = this.focusMode ? this.links : this.links.filter((l) => !l.ego);
    this.linkDeg = new Map();
    for (const l of sprung) {
      this.linkDeg.set(l.source.id, (this.linkDeg.get(l.source.id) ?? 0) + 1);
      this.linkDeg.set(l.target.id, (this.linkDeg.get(l.target.id) ?? 0) + 1);
    }
    const kidsOf = (n: SimNode) => n.kids ?? 0;
    this.sim
      .force('guardIn', guardForce())
      .force('charge', d3.forceManyBody<SimNode>().strength(TUNE.charge).distanceMax(TUNE.chargeMax).theta(TUNE.theta))
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>(sprung)
          .id((d) => d.id)
          .iterations(TUNE.linkIters)
          .distance((l) => {
            const label = (TUNE.labelTerm * (capW(l.source) + capW(l.target))) / 2;
            if (l.tree) return TUNE.childDist + label + TUNE.fanout * Math.sqrt(Math.max(0, kidsOf(l.source) - 1));
            return TUNE.edgeDist * (l.kind === 'mutual' ? TUNE.lengthMutual : TUNE.lengthFollow) + label;
          })
          .strength((l) => {
            const lo = Math.min(this.linkDeg.get(l.source.id) ?? 1, this.linkDeg.get(l.target.id) ?? 1);
            const kind = l.kind === 'mutual' ? TUNE.springMutual : TUNE.springFollow;
            const comm = l.source.community === l.target.community ? 1 : TUNE.extraComm;
            const base = l.tree ? TUNE.childStrength : TUNE.edgeStrength * kind * comm;
            return Math.min(SPRING_CAP, base) / Math.max(1, lo);
          }),
      )
      .force('voro', () => this.voroPass(1))
      .force('comm', (alpha: number) => this.commForce(alpha))
      .force('ring', (alpha: number) => this.ringForce(alpha))
      .force('polar', (alpha: number) => this.polarForce(alpha))
      .force('guardOut', guardForce());
  }

  // Delaunay-neighbour separation (replaces forceCollide); a constraint, so not alpha-scaled.
  // Without `held` it is the force: a velocity push over every overlapping pair.
  // With `held` it is the drag pass: positions only, the held node's contacts, then theirs.
  private voroPass(scale: number, held?: SimNode): number {
    const vis = this.vis.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
    if (vis.length < 2) return 0;
    const pairs: Array<[SimNode, SimNode]> = [];
    if (vis.length === 2) pairs.push([vis[0], vis[1]]);
    else {
      const del = d3.Delaunay.from(vis, (d) => d.x!, (d) => d.y!);
      for (let i = 0; i < vis.length; i++) for (const j of del.neighbors(i)) if (j > i) pairs.push([vis[i], vis[j]]);
    }
    let worst = 0;
    const sweep = (allowed: Set<SimNode> | undefined, moved: Set<SimNode>) => {
      for (const [a, b] of pairs) {
        if (allowed && !allowed.has(a) && !allowed.has(b)) continue;
        let dx = b.x! - a.x!;
        let dy = b.y! - a.y!;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-6) {
          dx = 0.01;
          dy = 0.01;
          dist = 0.0141;
        }
        let push = a.r + b.r + TUNE.voroMargin - dist;
        if (push <= 0) continue;
        const aFix = a.fx != null || a === held;
        const bFix = b.fx != null || b === held;
        if (aFix && bFix) continue;
        worst = Math.max(worst, push);
        push = Math.min(push, VORO_STEP);
        const share = (aFix || bFix ? push : push / 2) * scale;
        const ux = dx / dist;
        const uy = dy / dist;
        if (held) {
          if (!aFix) (a.x! -= ux * share), (a.y! -= uy * share), moved.add(a);
          if (!bFix) (b.x! += ux * share), (b.y! += uy * share), moved.add(b);
        } else {
          if (!aFix) (a.vx! -= ux * share), (a.vy! -= uy * share);
          if (!bFix) (b.vx! += ux * share), (b.vy! += uy * share);
        }
      }
    };
    if (!held) {
      sweep(undefined, new Set());
      return worst;
    }
    const first = new Set<SimNode>();
    sweep(new Set([held]), first);
    if (first.size) sweep(first, new Set());
    return worst;
  }

  // Per-community centroid pull (v2b COMM_PULL), ego and pinned nodes excluded.
  private commForce(alpha: number): void {
    const k = TUNE.commPull * alpha;
    if (!k) return;
    const acc = new Map<number, { x: number; y: number; n: number }>();
    for (const d of this.vis) {
      if (d.community < 0) continue;
      const c = acc.get(d.community) ?? { x: 0, y: 0, n: 0 };
      c.x += d.x!;
      c.y += d.y!;
      c.n++;
      acc.set(d.community, c);
    }
    for (const d of this.vis) {
      if (d.community < 0 || d.fx != null) continue;
      const c = acc.get(d.community);
      if (!c || c.n < 2) continue;
      d.vx! += (c.x / c.n - d.x!) * k;
      d.vy! += (c.y / c.n - d.y!) * k;
    }
  }

  // Band radius per node: hop 1 at R1 (well-linked friends a little closer), hop 2 from
  // R1 + gap outward by falling support, hop 3 beyond. Off in Focus, where the subset solves free.
  private assignRings(): void {
    const maxSup = [0, 1, 1, 1];
    for (const d of this.all) if (d.hop > 0) maxSup[d.hop] = Math.max(maxSup[d.hop], d.support);
    for (const d of this.all) {
      const s = d.hop > 0 ? Math.sqrt(d.support / maxSup[d.hop]) : 0;
      d.ringR =
        d.hop === 0
          ? 0
          : d.hop === 1
            ? this.r1 * (1.08 - 0.16 * s)
            : d.hop === 2
              ? this.r1 + (TUNE.ringGap + TUNE.ringBand * (1 - s)) * this.ringScale
              : this.r1 + (TUNE.ringGap + TUNE.ringBand + 70) * this.ringScale;
    }
  }

  private ringForce(alpha: number): void {
    if (this.focusMode) return;
    const w = TUNE.ringWeight * alpha;
    for (const d of this.vis) {
      if (d.hop === 0 || d.fx != null || d.ringR === undefined) continue;
      const len = Math.hypot(d.x!, d.y!) || 1;
      const k = ((d.ringR - len) / len) * w;
      d.vx! += d.x! * k;
      d.vy! += d.y! * k;
    }
  }

  // Pull toward the saved layout (basePos about the ego); off in Focus.
  private polarForce(alpha: number): void {
    if (this.focusMode || !this.base.size) return;
    const w = TUNE.polarWeight * alpha;
    for (const d of this.vis) {
      if (d.fx != null) continue;
      const b = this.base.get(d.id);
      if (!b) continue;
      d.vx! += (b.r * Math.cos(b.th) - d.x!) * w;
      d.vy! += (b.r * Math.sin(b.th) - d.y!) * w;
    }
  }

  private captureBase(): void {
    for (const d of this.vis) if (Number.isFinite(d.x)) this.base.set(d.id, polarOf(d));
    this.baseWant = false;
  }

  private setBase(d: SimNode): void {
    this.base.set(d.id, polarOf(d));
  }

  // Freeze everything beyond reheatHops of the seeds; thawed once alpha is cold.
  private freezeFar(seeds: SimNode[]): void {
    this.thawFar();
    const near = new Set<string>();
    let frontier = seeds.filter((s) => this.adj.has(s.id));
    for (const s of frontier) near.add(s.id);
    for (let h = 0; h < TUNE.reheatHops && frontier.length; h++) {
      const next: SimNode[] = [];
      for (const n of frontier)
        for (const m of this.adj.get(n.id) ?? []) {
          if (near.has(m.id)) continue;
          near.add(m.id);
          next.push(m);
        }
      frontier = next;
    }
    for (const d of this.vis) {
      if (near.has(d.id) || d.fx != null) continue;
      d.fx = d.x;
      d.fy = d.y;
      d.vx = d.vy = 0;
      this.frozen.add(d);
    }
  }

  private thawFar(): void {
    for (const d of this.frozen) {
      if (!d.pinned) d.fx = d.fy = null;
    }
    this.frozen.clear();
  }

  private thawWhenCold(): void {
    if (this.sim.alpha() >= THAW_ALPHA) return;
    if (this.frozen.size) this.thawFar();
    if (this.baseWant && this.sim.alpha() < ALPHA_MIN * 2) this.captureBase();
  }

  private reheatCancel(): void {
    clearTimeout(this.coolTimer);
    this.sim.alphaTarget(0);
  }

  // 420 ms cubic ease-in-out flight; the last frame writes the solved numbers exactly.
  private fly(from: Map<SimNode, [number, number]>, to: Map<SimNode, [number, number]>): void {
    const moving = [...to.entries()].map(([n, t]) => ({ n, f: from.get(n) ?? t, t, pinned: n.fx != null }));
    for (const m of moving) {
      m.n.x = m.f[0];
      m.n.y = m.f[1];
    }
    this.onTick();
    const ease = d3.easeCubicInOut;
    this.flight = d3.timer((elapsed) => {
      const k = Math.min(1, elapsed / ANIM_MS);
      const e = ease(k);
      for (const m of moving) {
        m.n.x = m.f[0] + (m.t[0] - m.f[0]) * e;
        m.n.y = m.f[1] + (m.t[1] - m.f[1]) * e;
        if (m.pinned) {
          m.n.fx = m.n.x;
          m.n.fy = m.n.y;
        }
      }
      this.onTick();
      if (k >= 1) this.flightLand();
    });
    this.flightTargets = moving;
  }

  private flightTargets: Array<{ n: SimNode; t: [number, number]; pinned: boolean }> = [];

  private flightLand(): void {
    if (!this.flight) return;
    this.flight.stop();
    this.flight = undefined;
    for (const m of this.flightTargets) {
      m.n.x = m.t[0];
      m.n.y = m.t[1];
      if (m.pinned) {
        m.n.fx = m.t[0];
        m.n.fy = m.t[1];
      }
    }
    this.flightTargets = [];
    this.onTick();
    this.onSettled();
  }

  // A new capture aborts a running flight where it stands instead of snapping forward.
  private flightAbort(): void {
    if (!this.flight) return;
    this.flight.stop();
    this.flight = undefined;
    for (const m of this.flightTargets) {
      if (m.pinned) {
        m.n.fx = m.t[0];
        m.n.fy = m.t[1];
      }
    }
    this.flightTargets = [];
  }
}

function capW(n: SimNode): number {
  return n.r * 2 + 8;
}

function polarOf(d: SimNode): Polar {
  return { r: Math.hypot(d.x!, d.y!), th: Math.atan2(d.y!, d.x!) };
}

// Velocity clamp and non-finite repair; registered first and last (v3e: guardOut alone still wedged).
function guardForce(): d3.Force<SimNode, SimLink> {
  let list: SimNode[] = [];
  const force = () => {
    for (const d of list) {
      if (!(Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.vx) && Number.isFinite(d.vy)) || (d.fx != null && !Number.isFinite(d.fx)) || (d.fy != null && !Number.isFinite(d.fy))) {
        if (d.fx != null && !Number.isFinite(d.fx)) d.fx = null;
        if (d.fy != null && !Number.isFinite(d.fy)) d.fy = null;
        d.vx = d.vy = 0;
        if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) {
          const th = d.seedAngle ?? 0;
          const r = SEED_RING * (1 + d.hop);
          d.x = r * Math.cos(th);
          d.y = r * Math.sin(th);
        }
        continue;
      }
      const q = d.vx! * d.vx! + d.vy! * d.vy!;
      if (q > VEL_MAX * VEL_MAX) {
        const s = VEL_MAX / Math.sqrt(q);
        d.vx! *= s;
        d.vy! *= s;
      }
    }
  };
  force.initialize = (nodes: SimNode[]) => {
    list = nodes;
  };
  return force;
}
