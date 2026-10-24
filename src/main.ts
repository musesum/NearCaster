import './style.css';
import { connectHost, type Host } from './host.ts';
import { crawlEgo, expandNode, DEFAULT_BUDGET, type FollowSet } from './data/crawl.ts';
import { sampleProvider, SAMPLE_EGO_FID } from './data/sample.ts';
import { HttpError, snapchainProvider } from './data/snapchain.ts';
import { idOf, type DataProvider, type EgoGraph, type GNode } from './data/types.ts';
import { GraphView, type LinkShow, type Mode, type Xray } from './graph/view.ts';
import { Panel } from './ui/panel.ts';
import { Peek } from './ui/peek.ts';
import { parseCenter } from './ui/center.ts';

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
  // Inside a client the handshake can take a few seconds after a reload.
  setStatus('Connecting…', 0);
  const host = await connectHost();
  applyInsets(host);
  // Splash off as soon as the shell paints; crawl progress shows in-app.
  await host.ready().catch((e) => console.warn('[host] ready failed', e));

  const params = new URLSearchParams(location.search);
  const wantSample = params.get('source') === 'sample';
  const provider = wantSample ? sampleProvider() : snapchainProvider({ base: import.meta.env.VITE_HUB_URL || undefined });
  const state: State = { host, provider, loading: false, expanding: false };

  const peek = new Peek($('peek'), $('stage'));
  let peekId: string | undefined;
  // An open profile sheet follows the finger: the account it showed before, the last one it browsed, and the graph.
  let browseFrom: string | undefined;
  let browsed: string | undefined;
  let browseGraph: EgoGraph | undefined;
  const view = new GraphView($('graph') as unknown as SVGSVGElement, {
    onSelect: (node) => select(node),
    onExpand: (node) => void expand(node),
    onBackground: () => hidePanel(),
    onPeek: (node, at, lifted) => {
      if (!at) {
        peek.hide();
        peekId = undefined;
        endBrowse(lifted === true);
        return;
      }
      if (!node || !state.graph) {
        peek.hide();
        peekId = undefined;
        return;
      }
      if (node.id !== peekId) {
        // One tick per node crossed, like a picker detent.
        host.haptic();
        if (panel.openId) browse(node, state.graph);
      }
      peekId = node.id;
      peek.show(node, state.graph, view.communityColor, at);
    },
  });

  function hidePanel(): void {
    panel.hide();
    cover(0);
  }

  // The sheet's height holds while browsing (a longer profile scrolls), so its edge, the cover and the fit button stay put.
  function browse(node: GNode, graph: EgoGraph): void {
    if (!browseFrom) {
      browseFrom = panel.openId;
      browseGraph = graph;
      $('panel').style.height = `${$('panel').offsetHeight}px`;
    }
    browsed = node.id;
    panel.show(node, graph, view.communityColor);
  }

  // Forgets a browse without touching the sheet's content.
  function dropBrowse(): void {
    browseFrom = browsed = browseGraph = undefined;
    $('panel').style.height = '';
  }

  // A clean lift selects the account the sheet shows; a second finger or a cancel puts the sheet back.
  // A sheet closed, or a graph replaced, during the browse is left as it is.
  function endBrowse(lifted: boolean): void {
    const from = browseFrom;
    const last = browsed;
    const graph = browseGraph;
    dropBrowse();
    if (!from || !panel.openId || graph !== state.graph) return;
    const id = lifted ? last : from;
    const pick = state.graph?.nodes.find((x) => x.id === id);
    if (!pick || !state.graph) return hidePanel();
    if (id === from) {
      panel.show(pick, state.graph, view.communityColor);
      syncCover();
      return;
    }
    select(pick);
    view.focus(pick.id, false);
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
    // A selection from elsewhere (an expand landing, a Focus tap) ends a browse in progress.
    dropBrowse();
    panel.show(node, state.graph, view.communityColor);
    const top = syncCover();
    if (top !== undefined) view.reveal(node.id, top);
  }

  // Phone-width bottom sheet: covers the stage from its top edge (returned); the side panel covers nothing.
  function syncCover(): number | undefined {
    const sheet = $('panel').getBoundingClientRect();
    const isSheet = sheet.width >= window.innerWidth - 40;
    cover(isSheet ? $('stage').getBoundingClientRect().bottom - sheet.top : 0);
    return isSheet ? sheet.top : undefined;
  }

  // Center on: a fid, or a username resolved through the data source.
  async function centerOn(raw: string): Promise<void> {
    if (state.loading) return;
    const t = parseCenter(raw);
    if (!t) {
      toast('Enter a fid or a @username');
      return;
    }
    if ('fid' in t) return load(t.fid);
    try {
      const fid = await state.provider.fidByName(t.name);
      if (fid) await load(fid);
      else toast(`No Farcaster account named @${t.name}`);
    } catch (e) {
      toast(`Lookup failed: ${(e as Error).message}`);
    }
  }

  // My network: back to the signed-in account; shown only while the graph is centred on someone else.
  const meBtn = $('meBtn');
  const syncMe = () => {
    const me = host.user;
    meBtn.hidden = !me || !state.graph || state.provider.name === 'sample' || state.graph.egoId === idOf(me.fid);
  };
  meBtn.addEventListener('click', () => {
    if (host.user) void load(host.user.fid, host.user);
  });

  const runSearch = wireControls(view, (raw) => void centerOn(raw));
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
      syncMe();
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
  $('source').textContent = `${friends} in your circle · ${fof} friends of friends · ${g.links.length} links · ${comms} communities · source ${g.provider}${g.truncated.length ? ` · ${g.truncated.join('; ')}` : ''}`;
}

// Returns the search runner so a new or grown graph re-applies the query.
function wireControls(view: GraphView, recenter: (target: string) => void): () => void {
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
  // Links row: All turns every direction on; each direction toggles itself.
  const links = $('links');
  const show: LinkShow = { mutual: true, following: true, follows: true };
  const kinds = Object.keys(show) as Array<keyof LinkShow>;
  links.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const k = b.dataset.links as keyof LinkShow | 'all';
    if (k === 'all') for (const x of kinds) show[x] = true;
    else show[k] = !show[k];
    links.querySelectorAll('button').forEach((x) => {
      const v = x.dataset.links as keyof LinkShow | 'all';
      const on = v === 'all' ? kinds.every((y) => show[y]) : show[v];
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
    });
    view.setLinkShow(show);
  });

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
    recenter($<HTMLInputElement>('fid').value);
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
