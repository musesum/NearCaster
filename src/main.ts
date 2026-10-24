import './style.css';
import { connectHost, type Host } from './host.ts';
import { crawlEgo, expandNode, DEFAULT_BUDGET, type FollowSet } from './data/crawl.ts';
import { sampleProvider, SAMPLE_EGO_FID } from './data/sample.ts';
import { HttpError, snapchainProvider } from './data/snapchain.ts';
import type { DataProvider, EgoGraph, GNode } from './data/types.ts';
import { GraphView, type LinkFilter, type Mode, type Xray } from './graph/view.ts';
import { Panel } from './ui/panel.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type State = {
  host: Host;
  provider: DataProvider;
  graph?: EgoGraph;
  follows?: FollowSet;
  loading: boolean;
  expanding: boolean;
};

// The account exists but there is nothing to draw; not a data-source failure.
class EmptyGraphError extends Error {}

// A username stub ("fid:N") is not a real mention or profile path.
const handleOf = (n: GNode) => (n.username.startsWith('fid:') ? `fid ${n.fid}` : `@${n.username}`);

async function boot(): Promise<void> {
  const host = await connectHost();
  applyInsets(host);
  // Splash off as soon as the shell paints; crawl progress shows in-app.
  await host.ready().catch((e) => console.warn('[host] ready failed', e));

  const params = new URLSearchParams(location.search);
  const wantSample = params.get('source') === 'sample';
  const provider = wantSample ? sampleProvider() : snapchainProvider({ base: import.meta.env.VITE_HUB_URL || undefined });
  const state: State = { host, provider, loading: false, expanding: false };

  const view = new GraphView($('graph') as unknown as SVGSVGElement, {
    onSelect: (node) => select(node),
    onExpand: (node) => void expand(node),
    onBackground: () => hidePanel(),
  });

  function hidePanel(): void {
    panel.hide();
    cover(0);
  }

  // Stage pixels under the bottom sheet: fits frame above it, the fit button rides above it.
  function cover(px: number): void {
    view.setCoverBottom(px);
    $('stage').style.setProperty('--cover', `${px}px`);
  }

  // Vizster F3: expanding reads the node's follows, links them in, and pins the node.
  async function expand(picked: GNode): Promise<void> {
    // The view hands back its own node copy; the crawl mutates the graph's record.
    const n = state.graph?.nodes.find((x) => x.id === picked.id);
    if (!state.graph || !state.follows || !n || n.expanded || state.expanding || state.loading) return;
    const graph = state.graph;
    state.expanding = true;
    setStatus(`Expanding ${handleOf(n)}…`);
    try {
      const r = await expandNode(state.provider, graph, state.follows, n, DEFAULT_BUDGET);
      // A recenter during the fetch replaced the graph; this result belongs to the old one.
      if (state.graph !== graph) return;
      view.setGraph(state.graph, true, [n.id]);
      view.pinExpanded(n.id);
      runSearch();
      view.focus(n.id, false);
      // A load in flight replaces this graph; its panel would describe the old one.
      if (!state.loading) select(n);
      setStatus('');
      toast(`+${r.added} people, +${Math.max(0, r.linked)} links via ${handleOf(n)}`);
      sourceCaption(state.graph);
    } catch (e) {
      setStatus('');
      toast(`Expand failed: ${(e as Error).message}`);
    } finally {
      state.expanding = false;
    }
  }

  const panel = new Panel($('panel'), {
    focus: (id) => {
      view.focus(id, true);
      const n = state.graph?.nodes.find((x) => x.id === id);
      if (n) select(n);
    },
    viewProfile: (n) => void host.viewProfile(n.fid, n.username),
    expand: (n) => expand(n),
    recenter: (n) => void load(n.fid, n.username.startsWith('fid:') ? undefined : { username: n.username, displayName: n.displayName, pfpUrl: n.pfpUrl }),
    cast: (n) => void host.composeCast(`Found ${handleOf(n)} in my NearCaster circle`, [location.origin + location.pathname]),
    close: () => {
      hidePanel();
      view.focus(undefined, false);
    },
  });

  function select(node: GNode | undefined): void {
    if (!node || !state.graph) {
      hidePanel();
      return;
    }
    host.haptic();
    panel.show(node, state.graph, view.communityColor);
    const sheet = $('panel').getBoundingClientRect();
    const isSheet = sheet.width >= window.innerWidth - 40;
    cover(isSheet ? $('stage').getBoundingClientRect().bottom - sheet.top : 0);
    if (isSheet) view.reveal(node.id, sheet.top);
  }

  const runSearch = wireControls(view, (fid) => void load(fid));
  // Dev-only probe for harness checks.
  if (import.meta.env.DEV) (window as unknown as { __nc: unknown }).__nc = { view, state };

  // Errors keep the current graph. Only a failing live source on the first load falls back to the sample.
  async function load(fid: number, hint?: Partial<GNode>): Promise<void> {
    if (state.loading || !Number.isInteger(fid) || fid <= 0) return;
    state.loading = true;
    hidePanel();
    setStatus('Connecting…', 0);
    try {
      let crawled;
      let fellBack = false;
      try {
        crawled = await crawlEgo(state.provider, fid, DEFAULT_BUDGET, setStatus, hint);
        if (crawled.graph.nodes.length <= 1) throw new EmptyGraphError(`fid ${fid} follows no one we can read`);
      } catch (e) {
        const sourceDown = !(e instanceof EmptyGraphError) && !(e instanceof HttpError && e.status < 500);
        if (!sourceDown || state.graph || state.provider.name === 'sample') throw e;
        console.error('[load] live source failed', e);
        setStatus(`Live data failed (${(e as Error).message}). Showing a sample network.`);
        await new Promise((r) => setTimeout(r, 1200));
        state.provider = sampleProvider();
        fellBack = true;
        fid = SAMPLE_EGO_FID;
        crawled = await crawlEgo(state.provider, fid, DEFAULT_BUDGET, setStatus);
      }
      const { graph, follows } = crawled;
      state.graph = graph;
      state.follows = follows;
      setStatus('');
      view.setGraph(graph, false);
      // A tap during the crawl may have opened the panel on the old graph.
      hidePanel();
      runSearch();
      sourceCaption(graph);
      // A fallback keeps the asked-for URL, so a reload retries live data.
      if (!fellBack) {
        const url = new URL(location.href);
        url.searchParams.set('fid', String(fid));
        if (state.provider.name === 'sample') url.searchParams.set('source', 'sample');
        history.replaceState(null, '', url);
      }
    } catch (e) {
      console.error('[load]', e);
      const msg = `Could not load fid ${fid}: ${(e as Error).message}`;
      if (state.graph) {
        setStatus('');
        toast(msg);
      } else setStatus(msg, undefined, true);
    } finally {
      state.loading = false;
    }
  }

  const urlFid = Number(params.get('fid'));
  const egoFid = wantSample ? (urlFid > 0 ? urlFid : SAMPLE_EGO_FID) : (host.user?.fid ?? (urlFid > 0 ? urlFid : 3));
  // The host's profile describes the viewer only; it never names another ego.
  await load(egoFid, !wantSample && egoFid === host.user?.fid ? host.user : undefined);
}

// Client-supplied insets win inside a mini app; a plain page keeps the CSS env() defaults.
function applyInsets(host: Host): void {
  if (!host.inMiniApp) return;
  const s = document.documentElement.style;
  for (const k of ['top', 'bottom', 'left', 'right'] as const) s.setProperty(`--safe-${k}`, `${host.insets[k] ?? 0}px`);
}

function setStatus(text: string, frac?: number, error = false): void {
  const el = $('status');
  el.classList.toggle('error', error);
  el.replaceChildren();
  if (!text) return;
  el.append(text);
  if (frac !== undefined) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const i = document.createElement('i');
    i.style.width = `${Math.round(frac * 100)}%`;
    bar.append(i);
    el.append(bar);
  }
}

let toastTimer = 0;
function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 4000);
}

function sourceCaption(g: EgoGraph): void {
  const friends = g.nodes.filter((n) => n.hop === 1).length;
  const fof = g.nodes.filter((n) => n.hop >= 2).length;
  const comms = new Set(g.nodes.map((n) => n.community).filter((c) => c >= 0)).size;
  $('source').textContent = `${friends} follows · ${fof} friends of friends · ${g.links.length} links · ${comms} communities · source ${g.provider}${g.truncated.length ? ` · ${g.truncated.join('; ')}` : ''}`;
}

// Returns the search runner so a new or grown graph re-applies the query.
function wireControls(view: GraphView, recenter: (fid: number) => void): () => void {
  const menuBtn = $('menuBtn');
  const controls = $('controls');
  menuBtn.addEventListener('click', () => {
    controls.hidden = !controls.hidden;
    menuBtn.setAttribute('aria-expanded', String(!controls.hidden));
    requestAnimationFrame(() => view.resize());
  });

  const seg = (id: string, attr: string, run: (v: string) => void) => {
    const root = $(id);
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      root.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      run(b.dataset[attr]!);
    });
  };
  seg('mode', 'mode', (v) => view.setMode(v as Mode));
  seg('xray', 'xray', (v) => view.setXray(v as Xray));
  seg('links', 'links', (v) => view.setLinkFilter(v as LinkFilter));

  const depth = $<HTMLInputElement>('depth');
  depth.addEventListener('input', () => {
    $('depthVal').textContent = depth.value;
    view.setDepth(Number(depth.value));
  });

  $<HTMLInputElement>('hulls').addEventListener('change', (e) => view.setHulls((e.target as HTMLInputElement).checked));

  const pull = $<HTMLInputElement>('pull');
  pull.value = String(view.pull);
  $('pullVal').textContent = view.pull.toFixed(2);
  pull.addEventListener('input', () => {
    $('pullVal').textContent = Number(pull.value).toFixed(2);
    view.setPull(Number(pull.value));
  });

  $('fidForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const fid = Number($<HTMLInputElement>('fid').value);
    if (Number.isInteger(fid) && fid > 0) recenter(fid);
    else toast('A fid is a whole number above 0');
  });

  const search = $<HTMLInputElement>('search');
  const runSearch = () => {
    const q = search.value.trim();
    if (!q) {
      search.classList.remove('bad');
      view.search(null);
      $('count').textContent = '';
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(q, 'i');
      search.classList.remove('bad');
    } catch {
      search.classList.add('bad');
      return;
    }
    const n = view.search(re);
    $('count').textContent = `${n} match${n === 1 ? '' : 'es'}`;
  };
  let t = 0;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = window.setTimeout(runSearch, 200);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Enter inside the debounce runs the query now.
      clearTimeout(t);
      runSearch();
      view.focusFirstMatch();
    }
    if (e.key === 'Escape') {
      search.value = '';
      search.dispatchEvent(new Event('input'));
    }
  });

  $('fitBtn').addEventListener('click', () => view.fit(true));
  new ResizeObserver(() => view.resize()).observe($('stage'));
  return runSearch;
}

void boot();
