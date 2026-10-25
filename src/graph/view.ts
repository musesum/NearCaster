// SVG view: batched link paths, nodes with avatars, community hulls, zoom/pan, drag,
// Focus | Context | All scope by depth, search, and community colouring.
import * as d3 from 'd3';
import type { EgoGraph, GLink, GNode } from '../data/types.ts';
import { Layout, type SimLink, type SimNode } from './layout.ts';
import { TouchGestures, type Pt } from './touch.ts';

export type Mode = 'focus' | 'context' | 'all';

export type ViewEvents = {
  onSelect(node: GNode | undefined): void;
  // Double click or tap: centre the graph on this account.
  onCenter(node: GNode): void;
  onBackground(): void;
  // Mouse hover: the node under the mouse; undefined = the hover ended (500 ms after the mouse left it).
  onHover(node: GNode | undefined): void;
  // Touch scrub preview: the node under the finger; at undefined = preview over, lifted = ended by a clean lift.
  onPeek(node: GNode | undefined, at?: Pt, lifted?: boolean): void;
};

// Links row: which follow directions draw. A link seen from one end is mutual, following (that end follows) or follows.
export type LinkShow = { mutual: boolean; following: boolean; follows: boolean };

const PALETTE = ['#8a63d2', '#56b4e9', '#e69f00', '#009e73', '#cc79a7', '#f0e442', '#d55e00', '#7fd1c7', '#b8a1ff', '#ff9eb5', '#9ccc65', '#ffb74d'];

// Which way a link's follow runs, seen from one of its ends: both ways, in (a follower), out (followed),
// or half (one way seen, the return never read).
type Tie = 'mutual' | 'in' | 'out' | 'half';
type LinkClass = 'follow' | 'mutual' | `ego-${Tie}` | `hit-${Tie}`;
const LINK_CLASSES: LinkClass[] = ['follow', 'mutual', 'ego-half', 'ego-mutual', 'ego-in', 'ego-out', 'hit-half', 'hit-mutual', 'hit-in', 'hit-out'];
export const tieFrom = (l: Pick<SimLink, 'kind' | 'oneWay'> & { target: { id: string } }, end: string): Tie =>
  l.kind === 'mutual' ? 'mutual' : !l.oneWay ? 'half' : l.target.id === end ? 'in' : 'out';
const LABEL_ZOOM = 1.35;
const SEARCH_CAP = 64;
// Vizster hover hysteresis.
const HOVER_EXIT_MS = 500;
const CASTS_QUIET_MS = 1500;
const NEAR_LABEL_CAP = 24;
// A finger covers a node: the scrub picks the nearest rim within this many screen px.
const PICK_PX = 24;
const ZOOM_EXTENT: [number, number] = [0.05, 12];
// Focus re-solves on a tap; a double tap's second press must find the node where it was.
const DOUBLE_TAP_MS = 250;
// Label zoom bands: hop 1 names from LABEL_ZOOM*0.6, the rest from LABEL_ZOOM*1.4.
const labelBand = (k: number) => (k >= LABEL_ZOOM * 1.4 ? 2 : k >= LABEL_ZOOM * 0.6 ? 1 : 0);

export class GraphView {
  readonly communityColor = (c: number): string => (c < 0 ? '#ffe080' : PALETTE[c % PALETTE.length]);
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private root: d3.Selection<SVGGElement, unknown, null, undefined>;
  private hullG: d3.Selection<SVGGElement, unknown, null, undefined>;
  private linkPaths: Record<LinkClass, d3.Selection<SVGPathElement, unknown, null, undefined>>;
  private nodeG: d3.Selection<SVGGElement, unknown, null, undefined>;
  private nodeSel?: d3.Selection<SVGGElement, SimNode, SVGGElement, unknown>;
  private zoom: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private layout: Layout;
  // One drag behaviour for the view's life: a fresh one per render orphans an in-progress touch drag.
  private dragB: ReturnType<Layout['drag']>;
  private touch: TouchGestures;
  private clickTimer = 0;
  private events: ViewEvents;
  private graph?: EgoGraph;
  private nodes: SimNode[] = [];
  private links: SimLink[] = [];
  private byId = new Map<string, SimNode>();
  private adj = new Map<string, Set<string>>();
  private mode: Mode = 'all';
  private depth = 1;
  private hullsOn = true;
  private focusId?: string;
  private hoverId?: string;
  // A finger preview is running: the selection steps out of the highlight until it ends.
  private touchHover = false;
  private hoverTimer = 0;
  private linkShow: LinkShow = { mutual: true, following: true, follows: true };
  // Time control: 'unposted' = only accounts that never cast; ms = cast within that window; undefined = all.
  private timeKeep?: 'unposted' | number;
  private castsTimer = 0;
  // The next scope solve starts from the radial seed (a Time change outside Focus).
  private reseedNext = false;
  // Time when Focus saved its layout.
  private snapTime?: 'unposted' | number;
  private near1 = new Set<string>();
  private near2 = new Set<string>();
  private searchHits = new Set<string>();
  private scope = new Set<string>();
  private width = 1;
  private height = 1;
  private k = 1;
  // Visible-set signature: a change routes through layout.solveFit (the one recalc chokepoint).
  private hiddenSig = '';
  private snap?: ReturnType<Layout['focusSnap']>;
  private snapView?: d3.ZoomTransform;
  private handMoved = false;
  private panning = false;
  private resizeTimer = 0;
  private resizeDw = 0;
  private resizeDh = 0;
  // Stage pixels covered by a bottom sheet; fits frame the space above it.
  private coverBottom = 0;

  constructor(el: SVGSVGElement, events: ViewEvents) {
    this.events = events;
    this.svg = d3.select(el);
    this.root = this.svg.append('g').attr('class', 'root');
    this.hullG = this.root.append('g').attr('class', 'hulls');
    const linkG = this.root.append('g').attr('class', 'links');
    // "ego-in" = class "link ego tie-in"; lit links draw last, on top.
    this.linkPaths = Object.fromEntries(
      LINK_CLASSES.map((c) => {
        const [group, tie] = c.split('-');
        return [c, linkG.append('path').attr('class', tie ? `link ${group} tie-${tie}` : `link ${group}`)];
      }),
    ) as Record<LinkClass, d3.Selection<SVGPathElement, unknown, null, undefined>>;
    this.nodeG = this.root.append('g').attr('class', 'nodes');
    this.svg.append('defs').append('clipPath').attr('id', 'avatarClip').attr('clipPathUnits', 'objectBoundingBox').append('circle').attr('cx', 0.5).attr('cy', 0.5).attr('r', 0.5);

    this.zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent(ZOOM_EXTENT)
      .clickDistance(8)
      // Touch goes to TouchGestures: one finger previews, two zoom and pan.
      .touchable(() => false)
      .on('zoom', (e: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        this.root.attr('transform', e.transform.toString());
        if (!this.panning && e.sourceEvent) this.handMoved = true;
        const crossed = labelBand(e.transform.k) !== labelBand(this.k);
        this.k = e.transform.k;
        if (crossed) this.paintLabels();
        this.touch?.refresh();
      });
    this.svg.call(this.zoom).on('dblclick.zoom', null);
    this.svg.on('click', (e: MouseEvent) => {
      if (e.target === this.svg.node() && !this.touch.recent()) this.tapBackground();
    });

    this.layout = new Layout(() => this.tick(), () => this.onSettled());
    this.dragB = this.layout.drag(() => this.k);
    this.touch = new TouchGestures(el, {
      pick: (p) => this.pickAt(p),
      scrub: (id, at, lifted) => this.scrub(id, at, lifted),
      tap: (id) => {
        const n = id ? this.byId.get(id) : undefined;
        if (n) this.tapNode(n);
        else this.tapBackground();
      },
      doubleTap: (id) => {
        const n = this.byId.get(id);
        if (n) this.doubleTapNode(n);
      },
      hold: () => {
        this.svg.interrupt();
        this.panning = false;
        return d3.zoomTransform(el);
      },
      apply: (t) => {
        this.handMoved = true;
        this.svg.call(this.zoom.transform, t);
      },
      extent: ZOOM_EXTENT,
    });
    this.resize();
  }

  // Resize never moves nodes: refit an untouched camera after 150 ms, else keep the view centred.
  resize(): void {
    const r = this.svg.node()!.getBoundingClientRect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    const dw = w - this.width;
    const dh = h - this.height;
    this.width = w;
    this.height = h;
    if (!this.nodes.length || (Math.abs(dw) < 1 && Math.abs(dh) < 1)) return;
    // Debounced resizes add up; the last delta alone would leave the view off centre.
    this.resizeDw += dw;
    this.resizeDh += dh;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (!this.handMoved) this.fit(false);
      else this.svg.call(this.zoom.translateBy, this.resizeDw / 2 / this.k, this.resizeDh / 2 / this.k);
      this.resizeDw = this.resizeDh = 0;
    }, 150);
  }

  // `seedIds` (an expanded node) keep their neighbourhood warm during the local reheat.
  setGraph(graph: EgoGraph, keepPositions: boolean, seedIds: string[] = []): void {
    this.graph = graph;
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    this.nodes = graph.nodes.map((g) => {
      const old = keepPositions ? prev.get(g.id) : undefined;
      const n = Object.assign(old ?? ({} as SimNode), g) as SimNode;
      n.r = radiusOf(n);
      return n;
    });
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.links = graph.links.map((l: GLink) => ({ ...l, source: this.byId.get(l.source)!, target: this.byId.get(l.target)!, ego: l.source === graph.egoId || l.target === graph.egoId }));
    this.adj = new Map(this.nodes.map((n) => [n.id, new Set<string>()]));
    for (const l of this.links) {
      this.adj.get(l.source.id)!.add(l.target.id);
      this.adj.get(l.target.id)!.add(l.source.id);
    }
    this.assignDads();
    this.layout.setNodes(this.nodes);
    if (!keepPositions) {
      this.focusId = undefined;
      clearTimeout(this.hoverTimer);
      this.hoverId = undefined;
      this.searchHits.clear();
      this.snap = undefined;
      this.handMoved = false;
      this.hiddenSig = '';
      this.layout.seedRadial();
      // A graph shown with Time set (a load, undo or redo) solves at the share it shows.
      this.reseedNext = this.timeKeep !== undefined && this.mode !== 'focus';
    }
    this.renderNodes();
    const seeds = seedIds.map((id) => this.byId.get(id)).filter((n): n is SimNode => !!n);
    this.applyScope(keepPositions ? 'local' : 'solve', undefined, seeds);
  }

  setMode(mode: Mode): void {
    const was = this.mode;
    this.mode = mode;
    if (mode === 'focus' && was !== 'focus') {
      this.snap = this.layout.focusSnap();
      this.snapView = d3.zoomTransform(this.svg.node()!);
      this.snapTime = this.timeKeep;
    }
    this.layout.focusMode = mode === 'focus';
    // A Time change inside Focus made the saved layout stale: re-solve from the seed instead.
    if (was === 'focus' && mode !== 'focus' && this.snap && this.snapTime !== this.timeKeep) {
      this.snap = undefined;
      this.reseedNext = true;
      this.applyScope('solve');
      return;
    }
    if (was === 'focus' && mode !== 'focus' && this.snap) {
      const snap = this.snap;
      this.snap = undefined;
      this.applyScope('restore', snap);
      // The camera returns with the nodes.
      if (this.snapView) {
        this.panning = true;
        this.svg
          .transition()
          .duration(420)
          .ease(d3.easeCubicInOut)
          .call(this.zoom.transform, this.snapView)
          .on('end interrupt', () => (this.panning = false));
      }
      return;
    }
    this.applyScope('solve');
  }

  setDepth(depth: number): void {
    this.depth = depth;
    this.applyScope('solve');
  }

  setHulls(on: boolean): void {
    this.hullsOn = on;
    this.hullG.attr('display', on ? 'inline' : 'none');
    if (on) this.drawHulls();
  }

  setLinkShow(show: LinkShow): void {
    this.linkShow = { ...show };
    this.drawLinks();
  }

  // Time hides accounts and re-solves the layout around the rest, as a scope change does.
  setTimeKeep(keep: 'unposted' | number | undefined): void {
    this.timeKeep = keep;
    this.reseedNext = this.mode !== 'focus';
    this.applyScope('solve');
  }

  // Last casts arrive after the graph draws, in batches; with Time set, one re-solve after they go quiet.
  setCasts(entries: Iterable<[string, number | null]>): void {
    for (const [id, t] of entries) {
      const n = this.byId.get(id);
      if (n) n.lastCast = t;
    }
    if (this.timeKeep === undefined) return;
    clearTimeout(this.castsTimer);
    this.castsTimer = window.setTimeout(() => {
      this.reseedNext = this.mode !== 'focus';
      this.applyScope('solve');
    }, CASTS_QUIET_MS);
  }

  // Hidden by Time; the ego, the selection and an account not read yet always show.
  private aged(n: SimNode): boolean {
    const keep = this.timeKeep;
    if (keep === undefined || n.hop === 0 || n.id === this.focusId || n.lastCast === undefined) return false;
    if (keep === 'unposted') return n.lastCast !== null;
    return n.lastCast === null || Date.now() - n.lastCast > keep;
  }

  // Seen from `end` by the Links row; a link seen from neither end (the dim background) is mutual or one-way.
  private linkShown(l: SimLink, end: string | undefined): boolean {
    const show = this.linkShow;
    if (l.kind === 'mutual') return show.mutual;
    if (end === undefined) return show.following || show.follows;
    return l.target.id === end ? show.follows : show.following;
  }

  // Expanded nodes hold still (Vizster pins every expanded focus).
  pinExpanded(id: string): void {
    const n = this.byId.get(id);
    if (n && !n.pinned) this.layout.togglePin(n);
    this.paint();
  }

  // Selection is paint-only in All and Context (0 px moved); in Focus it re-scopes and re-solves.
  focus(id: string | undefined, center: boolean): void {
    this.focusId = id && this.byId.has(id) ? id : undefined;
    this.applyScope(this.mode === 'focus' ? 'solve' : 'paint');
    if (center && this.focusId && this.mode !== 'focus') this.centerOn(this.byId.get(this.focusId)!);
  }

  search(re: RegExp | null): number {
    this.searchHits.clear();
    if (re) {
      for (const n of this.nodes) {
        if (re.test(n.username) || re.test(n.displayName) || re.test(String(n.fid))) this.searchHits.add(n.id);
        if (this.searchHits.size >= SEARCH_CAP) break;
      }
    }
    this.paint();
    return this.searchHits.size;
  }

  focusFirstMatch(): void {
    const first = [...this.searchHits].map((id) => this.byId.get(id)!).sort((a, b) => a.hop - b.hop)[0];
    if (!first) return;
    this.focus(first.id, true);
    this.events.onSelect(first);
  }

  fit(animate: boolean): void {
    const pts = this.nodes.filter((n) => this.visible(n) && Number.isFinite(n.x) && Number.isFinite(n.y)).map((n) => [n.x!, n.y!, n.r] as const);
    this.fitTo(pts, animate);
    this.handMoved = false;
  }

  // fitField (P:2703-2723): margin 16, never past 1:1, skipped on a degenerate viewport.
  private fitTo(pts: ReadonlyArray<readonly [number, number, number]>, animate: boolean): void {
    if (!pts.length || this.width < 40 || this.height < 40) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y, r] of pts) {
      x0 = Math.min(x0, x - r);
      x1 = Math.max(x1, x + r);
      y0 = Math.min(y0, y - r);
      y1 = Math.max(y1, y + r);
    }
    const m = 16;
    const h = this.height - this.coverBottom;
    const k = Math.max(0.05, Math.min(1, (this.width - 2 * m) / Math.max(1, x1 - x0), (h - 2 * m) / Math.max(1, y1 - y0)));
    const t = d3.zoomIdentity.translate(this.width / 2 - (k * (x0 + x1)) / 2, h / 2 - (k * (y0 + y1)) / 2).scale(k);
    this.panning = true;
    if (animate) {
      this.svg
        .transition()
        .duration(420)
        .ease(d3.easeCubicInOut)
        .call(this.zoom.transform, t)
        .on('end interrupt', () => (this.panning = false));
    } else {
      this.svg.call(this.zoom.transform, t);
      this.panning = false;
    }
  }

  // Ball of radius `depth` (undirected hops) around each seed: Vizster's linked neighbourhood.
  private ball(seeds: string[], depth: number): Set<string> {
    const seen = new Set(seeds);
    let frontier = seeds;
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const m of this.adj.get(id) ?? []) {
          if (seen.has(m)) continue;
          seen.add(m);
          next.push(m);
        }
      frontier = next;
    }
    return seen;
  }

  // Focus hides everything outside the scope, Context grays it, All shows the ego network to ring `depth`.
  // A changed visible set solves and flies; otherwise the call paints only.
  private applyScope(how: 'solve' | 'local' | 'paint' | 'restore', snap?: ReturnType<Layout['focusSnap']>, seeds: SimNode[] = []): void {
    if (!this.graph) return;
    const egoId = this.graph.egoId;
    if (this.mode === 'all') {
      // All = the whole graph; depth shapes Focus and Context only (v3f).
      this.scope = new Set(this.nodes.map((n) => n.id));
    } else {
      const seed = this.focusId ?? egoId;
      this.scope = this.ball([seed], this.depth);
      this.scope.add(seed);
      // Focus keeps the ego as the frame of reference.
      if (this.mode === 'focus') this.scope.add(egoId);
    }
    const vis = this.nodes.filter((n) => this.visible(n));
    const vset = new Set(vis.map((n) => n.id));
    const vlinks = this.links.filter((l) => vset.has(l.source.id) && vset.has(l.target.id));
    const sig = vis.map((n) => n.id).join(',');
    const changed = sig !== this.hiddenSig;
    this.hiddenSig = sig;
    this.nodeSel?.style('display', (n) => (vset.has(n.id) ? null : 'none'));
    if (how === 'restore' && snap) this.layout.focusRestore(snap, vis, vlinks);
    else if (how === 'local') this.layout.reheatLocal(vis, vlinks, seeds);
    else if (changed) {
      const from = this.reseedNext ? new Map(this.nodes.map((n) => [n, [n.x ?? 0, n.y ?? 0] as [number, number]])) : undefined;
      if (from) this.layout.reseed(vis);
      this.layout.solveFit(vis, vlinks, (to) => this.fitTo([...to.entries()].map(([n, [x, y]]) => [x, y, n.r] as const), true), from);
    } else this.layout.bindQuiet(vis, vlinks);
    this.reseedNext = false;
    this.paint();
    // Hulls follow the scope (Context grays outside it); hover never changes them.
    if (this.hullsOn) this.drawHulls();
    this.legend();
  }

  // Discovery tree (spec section 9): hop 1 hangs off the ego; deeper nodes hang off the
  // previous-ring neighbour that brought them in (mutual first, then degree, then fid).
  private assignDads(): void {
    const ego = this.byId.get(this.graph!.egoId);
    const mutual = new Set(this.links.filter((l) => l.kind === 'mutual').map((l) => `${l.source.id}|${l.target.id}`));
    const isMutual = (a: string, b: string) => mutual.has(`${a}|${b}`) || mutual.has(`${b}|${a}`);
    for (const n of this.nodes) {
      n.kids = 0;
      n.dad = undefined;
    }
    for (const n of this.nodes) {
      if (n.hop === 0) continue;
      if (n.hop === 1) {
        n.dad = ego;
        continue;
      }
      let best: SimNode | undefined;
      for (const id of this.adj.get(n.id) ?? []) {
        const m = this.byId.get(id)!;
        if (m.hop !== n.hop - 1) continue;
        if (!best) {
          best = m;
          continue;
        }
        const mm = isMutual(m.id, n.id);
        const bm = isMutual(best.id, n.id);
        if (mm !== bm ? mm : (this.adj.get(m.id)?.size ?? 0) !== (this.adj.get(best.id)?.size ?? 0) ? (this.adj.get(m.id)?.size ?? 0) > (this.adj.get(best.id)?.size ?? 0) : m.fid < best.fid) best = m;
      }
      // Hop is capped at 3: newcomers from an expanded hop-3 node hang off that node.
      if (!best)
        for (const id of this.adj.get(n.id) ?? []) {
          const m = this.byId.get(id)!;
          if (m.hop === n.hop && m.expanded && (!best || m.fid < best.fid)) best = m;
        }
      n.dad = best;
    }
    for (const n of this.nodes) if (n.dad) n.dad.kids = (n.dad.kids ?? 0) + 1;
    for (const l of this.links) l.tree = !l.ego && (l.source.dad === l.target || l.target.dad === l.source);
  }

  private visible(n: SimNode): boolean {
    if (this.aged(n)) return false;
    if (this.mode === 'context') return true;
    return this.scope.has(n.id);
  }

  private renderNodes(): void {
    const sel = this.nodeG
      .selectAll<SVGGElement, SimNode>('g.node')
      .data(this.nodes, (d) => d.id)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'node');
        g.append('circle').attr('class', 'aura');
        g.append('circle').attr('class', 'body');
        g.append('text').attr('class', 'initials');
        g.append('image').attr('class', 'avatar').attr('clip-path', 'url(#avatarClip)').attr('preserveAspectRatio', 'xMidYMid slice');
        g.append('text').attr('class', 'label').attr('dy', '0.32em');
        return g;
      });
    sel.select<SVGCircleElement>('circle.aura').attr('r', (d) => d.r + 4);
    sel.select<SVGCircleElement>('circle.body').attr('r', (d) => d.r);
    sel.select<SVGTextElement>('text.initials').text((d) => (d.pfpUrl && d.hop <= 1 ? '' : initials(d))).style('font-size', (d) => `${Math.max(6, d.r * 0.9)}px`);
    sel
      .select<SVGImageElement>('image.avatar')
      .attr('href', (d) => (d.pfpUrl && d.hop <= 1 ? d.pfpUrl : null))
      .attr('x', (d) => -d.r)
      .attr('y', (d) => -d.r)
      .attr('width', (d) => d.r * 2)
      .attr('height', (d) => d.r * 2)
      .on('error', function () {
        d3.select(this).attr('href', null);
      });
    sel.select<SVGTextElement>('text.label').attr('x', (d) => d.r + 3).text((d) => d.displayName || d.username);

    sel
      .on('click', (e: MouseEvent, d) => {
        e.stopPropagation();
        if (!this.touch.recent()) this.tapNode(d);
      })
      .on('dblclick', (e: MouseEvent, d) => {
        e.stopPropagation();
        if (!this.touch.recent()) this.doubleTapNode(d);
      })
      .on('pointerenter', (e: PointerEvent, d) => {
        if (e.pointerType !== 'mouse') return;
        clearTimeout(this.hoverTimer);
        if (this.hoverId !== d.id) {
          this.hoverId = d.id;
          this.paint();
          this.events.onHover(d);
        }
      })
      .on('pointerleave', (e: PointerEvent) => {
        if (e.pointerType !== 'mouse') return;
        clearTimeout(this.hoverTimer);
        this.hoverTimer = window.setTimeout(() => this.endHover(), HOVER_EXIT_MS);
      });
    sel.call(this.dragB);
    this.nodeSel = sel;
  }

  private endHover(): void {
    this.hoverId = undefined;
    this.paint();
    this.events.onHover(undefined);
  }

  // The mouse on the panel: hold the hover it shows, start the exit delay, or end it now.
  keepHover(on: boolean): void {
    if (this.touchHover || !this.hoverId) return;
    clearTimeout(this.hoverTimer);
    if (!on) this.hoverTimer = window.setTimeout(() => this.endHover(), HOVER_EXIT_MS);
  }

  endHoverNow(): void {
    if (this.touchHover || !this.hoverId) return;
    clearTimeout(this.hoverTimer);
    this.endHover();
  }

  private paint(): void {
    if (!this.nodeSel || !this.graph) return;
    const lit = this.litSet();
    const ctx = this.mode === 'context';
    const color = (d: SimNode) => this.communityColor(d.community);
    // Connectivity highlight (Vizster F5): hover, else the selection, lights hop 1 and hop 2.
    const src = this.hoverId ?? this.litFocus;
    this.near1 = new Set(src ? this.adj.get(src) : []);
    this.near2 = new Set<string>();
    if (src) for (const id of this.ball([src], 2)) if (id !== src && !this.near1.has(id)) this.near2.add(id);
    const lightOn = src !== undefined || this.searchHits.size > 0;
    // Hop 2 of a dense follow graph covers nearly everything, so it fades instead of staying lit.
    const lightOf = (id: string) => id === src || lit.has(id) || this.near1.has(id);
    this.nodeSel
      .classed('focus', (d) => d.id === this.litFocus)
      .classed('hit', (d) => lit.has(d.id) || d.id === src)
      .classed('near1', (d) => this.near1.has(d.id))
      .classed('near2', (d) => this.near2.has(d.id))
      .classed('pinned', (d) => !!d.pinned)
      .classed('faint', (d) => lightOn && !lightOf(d.id) && this.near2.has(d.id) && !(ctx && !this.scope.has(d.id)))
      .classed('dim', (d) => (ctx && !this.scope.has(d.id)) || (lightOn && !lightOf(d.id) && !this.near2.has(d.id)));
    // Lit nodes draw above the rest, the ego above all.
    this.nodeSel.filter((d) => lightOf(d.id)).raise();
    this.nodeSel.filter((d) => d.hop === 0).raise();
    this.nodeSel.select<SVGCircleElement>('circle.body').attr('fill', color);
    this.paintLabels();
    this.drawLinks();
  }

  // Labels: always for ego, focus, hits, and hop 1 when zoomed in; others on deep zoom.
  private paintLabels(): void {
    if (!this.nodeSel) return;
    const lit = this.litSet();
    // Neighbour labels only for a small neighbourhood; a hub's ring of names is unreadable.
    const focus = this.litFocus;
    const around = focus ? this.adj.get(focus) : undefined;
    const near = around && around.size <= NEAR_LABEL_CAP ? around : undefined;
    this.nodeSel
      .select<SVGTextElement>('text.label')
      .style('display', (d) => (d.hop === 0 || d.id === focus || lit.has(d.id) || near?.has(d.id) || this.k >= LABEL_ZOOM * (d.hop === 1 ? 0.6 : 1.4) ? null : 'none'));
  }

  // Union of focus, hover, and search: one highlight style.
  private litSet(): Set<string> {
    const s = new Set(this.searchHits);
    if (this.litFocus) s.add(this.litFocus);
    if (this.hoverId) s.add(this.hoverId);
    return s;
  }

  // The selection as the highlight sees it: hidden while a finger previews, so only the account under it is lit.
  private get litFocus(): string | undefined {
    return this.touchHover ? undefined : this.focusId;
  }

  private legend(): void {
    const el = document.getElementById('legend');
    if (!el || !this.graph) return;
    el.replaceChildren();
    const item = (color: string, text: string) => {
      const s = document.createElement('span');
      const i = document.createElement('i');
      i.style.background = color;
      s.append(i, text);
      el.append(s);
    };
    const counts = d3.rollup(this.nodes.filter((n) => n.community >= 0), (v) => v.length, (n) => n.community);
    [...counts.entries()].sort((a, b) => a[0] - b[0]).slice(0, 8).forEach(([c, n]) => item(this.communityColor(c), `#${c + 1} · ${n}`));
  }

  // The single paint path for geometry (forces, flights, drags).
  private tick(): void {
    this.nodeSel?.filter((d) => this.visible(d)).attr('transform', (d) => `translate(${d.x},${d.y})`);
    this.drawLinks();
    if (this.hullsOn) this.drawHulls();
    this.touch.refresh();
  }

  private onSettled(): void {
    this.paint();
  }

  // One path per link class; per-link elements cost too much at ~8k links.
  private drawLinks(): void {
    const lit = this.litSet();
    const ctx = this.mode === 'context';
    const parts = Object.fromEntries(LINK_CLASSES.map((c) => [c, [] as string[]])) as Record<LinkClass, string[]>;
    // Lit links are coloured from the hovered or selected account, links to you from you.
    const centre = this.hoverId ?? this.litFocus;
    const egoId = this.graph?.egoId ?? '';
    for (const l of this.links) {
      const s = l.source;
      const t = l.target;
      if (s.x === undefined || t.x === undefined) continue;
      if (!this.visible(s) || !this.visible(t)) continue;
      if (ctx && (!this.scope.has(s.id) || !this.scope.has(t.id))) continue;
      const hot = lit.size > 0 && (lit.has(s.id) || lit.has(t.id));
      const end = hot ? (s.id === centre || t.id === centre ? centre! : lit.has(s.id) ? s.id : t.id) : l.ego ? egoId : undefined;
      if (!this.linkShown(l, end)) continue;
      const seg = `M${s.x.toFixed(1)},${s.y!.toFixed(1)}L${t.x.toFixed(1)},${t.y!.toFixed(1)}`;
      if (end === undefined) parts[l.kind].push(seg);
      else parts[`${hot ? 'hit' : 'ego'}-${tieFrom(l, end)}`].push(seg);
    }
    for (const c of LINK_CLASSES) this.linkPaths[c].attr('d', parts[c].join(''));
    const dim = lit.size > 0;
    for (const c of LINK_CLASSES) if (!c.startsWith('hit')) this.linkPaths[c].classed('dim', dim);
  }

  private drawHulls(): void {
    const groups = d3.group(
      this.nodes.filter((n) => n.community >= 0 && n.x !== undefined && this.visible(n) && (this.mode !== 'context' || this.scope.has(n.id))),
      (n) => n.community,
    );
    const data = [...groups.entries()].filter(([, v]) => v.length >= 2).map(([c, v]) => ({ c, path: hullPath(v) }));
    this.hullG
      .selectAll<SVGPathElement, { c: number; path: string }>('path.hull')
      .data(data, (d) => String(d.c))
      .join('path')
      .attr('class', 'hull')
      .attr('d', (d) => d.path)
      .attr('fill', (d) => this.communityColor(d.c))
      .attr('stroke', (d) => this.communityColor(d.c));
  }

  // Click or tap: select. The sheet opens first so a Focus re-solve frames the space above it;
  // in Focus the re-scope waits out a double tap so the node holds still under the second tap.
  private tapNode(d: SimNode): void {
    const run = () => {
      this.events.onSelect(d);
      this.focus(d.id, false);
    };
    clearTimeout(this.clickTimer);
    if (this.mode === 'focus') this.clickTimer = window.setTimeout(run, DOUBLE_TAP_MS);
    else run();
  }

  private doubleTapNode(d: SimNode): void {
    clearTimeout(this.clickTimer);
    this.events.onCenter(d);
  }

  isPinned(id: string): boolean {
    return !!this.byId.get(id)?.pinned;
  }

  // The profile's Unpin: the node rejoins the layout.
  unpin(id: string): void {
    const n = this.byId.get(id);
    if (!n?.pinned || n.hop === 0) return;
    this.layout.togglePin(n);
    this.paint();
  }

  private tapBackground(): void {
    clearTimeout(this.clickTimer);
    this.focus(undefined, false);
    this.events.onBackground();
  }

  // Nearest visible node rim to an svg-local point, within PICK_PX screen px.
  private pickAt(p: Pt): string | undefined {
    const t = d3.zoomTransform(this.svg.node()!);
    const [wx, wy] = t.invert(p);
    let best: SimNode | undefined;
    let bestD = Infinity;
    for (const n of this.nodes) {
      if (n.x === undefined || !this.visible(n)) continue;
      const d = (Math.hypot(n.x - wx, n.y! - wy) - n.r) * t.k;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best && bestD <= PICK_PX ? best.id : undefined;
  }

  // The touch scrub drives the same hover highlight as the mouse; paint only, 0 px moved.
  private scrub(id: string | undefined, at?: Pt, lifted?: boolean): void {
    clearTimeout(this.hoverTimer);
    const touching = at !== undefined;
    // A finger takes over from a mouse hover: the panel goes back to the selection first.
    if (touching && !this.touchHover && this.hoverId) this.events.onHover(undefined);
    if (this.hoverId !== id || this.touchHover !== touching) {
      this.hoverId = id;
      this.touchHover = touching;
      this.paint();
    }
    this.events.onPeek(id ? this.byId.get(id) : undefined, at, lifted);
  }

  setCoverBottom(px: number): void {
    this.coverBottom = Math.max(0, Math.min(px, this.height * 0.6));
  }

  // Camera only: lift a node that sits under an overlay (the phone-width profile sheet).
  reveal(id: string, coverTop: number): void {
    const n = this.byId.get(id);
    if (!n || n.x === undefined) return;
    const t = d3.zoomTransform(this.svg.node()!);
    const top = this.svg.node()!.getBoundingClientRect().top;
    const sy = top + t.y + t.k * n.y!;
    const want = Math.min(coverTop - 40, top + (coverTop - top) / 2);
    if (sy <= coverTop - 24) return;
    this.panning = true;
    this.svg
      .transition()
      .duration(300)
      .call(this.zoom.translateBy, 0, (want - sy) / t.k)
      .on('end interrupt', () => (this.panning = false));
  }

  // Centre within the stage space left above a bottom sheet.
  private centerOn(n: SimNode): void {
    if (n.x === undefined) return;
    const k = Math.max(this.k, 1.2);
    const t = d3.zoomIdentity.translate(this.width / 2 - k * n.x, (this.height - this.coverBottom) / 2 - k * n.y!).scale(k);
    this.svg.transition().duration(450).call(this.zoom.transform, t);
  }
}

function radiusOf(n: GNode): number {
  if (n.hop === 0) return 18;
  if (n.hop === 1) return 7 + Math.min(7, Math.sqrt(n.support) * 1.2);
  return 3.5 + Math.min(5, Math.sqrt(n.support) * 0.9);
}

function initials(n: GNode): string {
  const s = (n.displayName || n.username).replace(/[^\p{L}\p{N}]/gu, '');
  return s.slice(0, 2).toUpperCase();
}

// Community hull: Vizster corner points grown 5 px, Catmull-Rom 0.5; the 36 px round stroke pads it.
function hullPath(nodes: SimNode[]): string {
  const pts: Array<[number, number]> = [];
  for (const n of nodes) {
    const g = n.r + 5;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) pts.push([n.x! + sx * g, n.y! + sy * g]);
  }
  const hull = d3.polygonHull(pts);
  if (!hull) return '';
  return d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5))(hull) ?? '';
}
