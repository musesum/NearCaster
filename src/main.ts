import './style.css';
import { connectHost, type Host } from './host.ts';
import { crawlEgo, expandNode, pool, DEFAULT_BUDGET, type FollowSet } from './data/crawl.ts';
import { sampleProvider, SAMPLE_EGO_FID } from './data/sample.ts';
import { HttpError, snapchainProvider } from './data/snapchain.ts';
import { fidOf, idOf, type DataProvider, type EgoGraph, type GNode } from './data/types.ts';
import { GraphView, type LinkShow, type Mode } from './graph/view.ts';
import { ageStop, stepFor, AGE_STEPS } from './ui/age.ts';
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
// Graphs undo can step back through.
const HISTORY_MAX = 20;
// Last-cast cache: fids per request, and per follow-up request (the misses it reads from the hub).
const CACHE_BATCH = 500;
const CACHE_MISSES = 40;
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
  // A mouse hover previews its account in the panel; when the hover ends the panel shows what it showed before.
  let hovering = false;
  let hoverFrom: string | undefined;
  const view = new GraphView($('graph') as unknown as SVGSVGElement, {
    // A tap opens the profile with its details.
    onSelect: (node) => {
      panel.openDetails();
      select(node);
    },
    onCenter: (node) => {
      if (node.id !== state.graph?.egoId) recenterOn(node);
    },
    onBackground: () => hidePanel(),
    onHover: (node) => {
      const graph = state.graph;
      if (!graph || browseFrom) return;
      if (node) closeControls();
      if (node && !hovering) {
        hovering = true;
        hoverFrom = panel.openId;
      }
      if (!hovering) return;
      if (!node) hovering = false;
      if (node && node.id !== hoverFrom) return panel.show(node, graph, view.communityColor, true);
      const from = graph.nodes.find((x) => x.id === hoverFrom);
      if (!from) return hidePanel();
      if (panel.openId !== from.id || panel.previewing) panel.show(from, graph, view.communityColor);
    },
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
      closeControls();
      if (node.id !== peekId) {
        // One tick per node crossed, like a picker detent.
        host.haptic();
        if (panel.openId) browse(node, state.graph);
      }
      peekId = node.id;
      peek.show(node, state.graph, view.communityColor, at);
    },
  });

  // A hover or finger preview starts: the Controls menu gets out of the way.
  function closeControls(): void {
    if ($('controls').hidden) return;
    $('controls').hidden = true;
    $('menuBtn').setAttribute('aria-expanded', 'false');
  }

  function hidePanel(): void {
    hovering = false;
    hoverFrom = undefined;
    panel.hide();
    cover(0);
  }

  // The arrow row and hover previews change the sheet's height; the cover follows (it holds during a finger browse).
  new ResizeObserver(() => {
    if ($('panel').hidden || browseFrom) return;
    const top = syncCover();
    if (top !== undefined && panel.openId && !panel.previewing) view.reveal(panel.openId, top);
  }).observe($('panel'));

  // The mouse reaching the panel: with a selection, the hover ends and the selection shows;
  // without one, the preview holds (it may cover the node it shows).
  $('panel').addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || !hovering) return;
    if (hoverFrom) view.endHoverNow();
    else view.keepHover(true);
  });
  $('panel').addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') view.keepHover(false);
  });

  // The sheet fits each preview (a held height left a blank area under a short one); the cover and
  // the fit button hold until the browse ends.
  function browse(node: GNode, graph: EgoGraph): void {
    if (!browseFrom) {
      browseFrom = panel.openId;
      browseGraph = graph;
    }
    browsed = node.id;
    panel.show(node, graph, view.communityColor, true);
  }

  // Forgets a browse without touching the sheet's content.
  function dropBrowse(): void {
    browseFrom = browsed = browseGraph = undefined;
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
      void readCasts(graph);
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
    select: (n) => {
      select(n);
      view.focus(n.id, false);
    },
    viewProfile: (n) => void host.viewProfile(n.fid, n.username),
    expand: (n) => expand(n),
    recenter: (n) => recenterOn(n),
    pinned: (id) => view.isPinned(id),
    unpin: (id) => view.unpin(id),
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
    // A hover that ends after this selection keeps it.
    if (hovering) hoverFrom = node.id;
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

  // Add NearCaster: inside a client, shown until the viewer's app list holds it.
  const addBtn = $<HTMLButtonElement>('addBtn');
  let added = host.added ?? true;
  const syncAdd = () => {
    addBtn.hidden = added;
  };
  host.onAdded((v) => {
    added = v;
    syncAdd();
  });
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    try {
      const r = await host.addApp();
      if (r === 'added') {
        added = true;
        toast('NearCaster added to your apps');
      } else if (r === 'unsigned') toast(`${location.host} has no signed Farcaster manifest`);
    } catch (e) {
      toast(`Add failed: ${(e as Error).message}`);
    } finally {
      addBtn.disabled = false;
      syncAdd();
    }
  });
  syncAdd();

  const runSearch = wireControls(view, (raw) => void centerOn(raw));
  const time = wireTime(view);

  // Last casts read after the graph draws, ego first, painted in batches; a newer graph ends the read.
  // The first load's ego (the viewer, inside a client) sets Time's starting window: since its last cast.
  let timeDefaulted = false;
  // Accounts already asked, so a second read (an expand) skips them.
  const castAsked = new WeakSet<GNode>();
  // The site's last-cast cache answers until a request to it fails.
  let castCacheUp = true;
  // Rounds in a row with a failed request; two turn the cache off for the session.
  let castCacheFails = 0;
  async function readCasts(graph: EgoGraph): Promise<void> {
    const provider = state.provider;
    const todo = graph.nodes.filter((n) => n.lastCast === undefined && !castAsked.has(n)).sort((a, b) => a.hop - b.hop);
    const ready: Array<[string, number | null]> = [];
    let flushT = 0;
    const flush = () => {
      flushT = 0;
      if (state.graph === graph) view.setCasts(ready.splice(0));
    };
    const got = (n: GNode, t: number | null) => {
      n.lastCast = t;
      ready.push([n.id, t]);
      if (n.id === graph.egoId) {
        flush();
        if (!timeDefaulted) {
          timeDefaulted = true;
          time.setDefault(t === null ? AGE_STEPS : stepFor(Date.now() - t));
        }
      } else if (!flushT) flushT = window.setTimeout(flush, 250);
    };
    // The ego's own read sets Time's default, so it goes straight to the hub beside the cache rounds.
    const cached = castCacheUp && !!provider.lastCasts;
    const ego = cached ? todo.find((n) => n.id === graph.egoId) : undefined;
    if (ego) castAsked.add(ego);
    const egoRead = ego ? provider.lastCast(ego.fid).then((t) => got(ego, t), () => castAsked.delete(ego)) : undefined;
    const rest = cached ? await readCached(graph, todo.filter((n) => n !== ego), provider, got) : todo;
    await egoRead;
    if (ego && ego.lastCast === undefined) rest.push(ego);
    await pool(rest, DEFAULT_BUDGET.concurrency, async (n) => {
      // A load in flight gets the hub to itself.
      if (state.graph !== graph || state.loading || castAsked.has(n)) return;
      castAsked.add(n);
      got(n, await provider.lastCast(n.fid));
    });
    clearTimeout(flushT);
    flush();
  }

  // The site's cache answers big batches; what it leaves missing goes back in small batches it can read
  // from the hub (CACHE_MISSES each). A failing cache is dropped for the session and the hub is read directly.
  // Returns the accounts still unanswered.
  async function readCached(graph: EgoGraph, todo: GNode[], provider: DataProvider, got: (n: GNode, t: number | null) => void): Promise<GNode[]> {
    const byFid = new Map(todo.map((n) => [n.fid, n]));
    for (const n of todo) castAsked.add(n);
    let want = todo.map((n) => n.fid);
    let size = CACHE_BATCH;
    while (want.length && castCacheUp && state.graph === graph && !state.loading) {
      const parts: number[][] = [];
      for (let i = 0; i < want.length; i += size) parts.push(want.slice(i, i + size));
      const answers = await pool(parts, DEFAULT_BUDGET.concurrency, (p) => provider.lastCasts!(p));
      castCacheFails = answers.some((a) => !a) ? castCacheFails + 1 : 0;
      if (castCacheFails >= 2) castCacheUp = false;
      const next: number[] = [];
      answers.forEach((a, i) => {
        if (!a) return next.push(...parts[i]);
        for (const [fid, t] of a.casts) {
          const n = byFid.get(fid);
          if (n) got(n, t);
        }
        next.push(...a.missing);
      });
      // A follow-up round that answers under a quarter means the hub is failing: read the rest directly.
      if (next.length >= want.length || (size === CACHE_MISSES && want.length - next.length < want.length / 4)) break;
      want = next;
      size = CACHE_MISSES;
    }
    const left = want.map((f) => byFid.get(f)!).filter((n) => n.lastCast === undefined);
    for (const n of left) castAsked.delete(n);
    return left;
  }

  // Dev-only probe for harness checks.
  if (import.meta.env.DEV) (window as unknown as { __nc: unknown }).__nc = { view, state };

  function recenterOn(n: GNode): void {
    void load(n.fid, n.username.startsWith('fid:') ? undefined : { username: n.username, displayName: n.displayName, pfpUrl: n.pfpUrl });
  }

  // Undo and redo: graphs centred earlier stay in memory (up to HISTORY_MAX back) and show again without a crawl.
  type Visit = { graph: EgoGraph; follows: FollowSet; provider: DataProvider };
  const back: Visit[] = [];
  const ahead: Visit[] = [];
  const undoBtn = $<HTMLButtonElement>('undoBtn');
  const redoBtn = $<HTMLButtonElement>('redoBtn');
  const visitName = (v?: Visit) => {
    const ego = v?.graph.nodes.find((n) => n.id === v.graph.egoId);
    return ego ? handleOf(ego) : '';
  };
  const syncHistory = () => {
    undoBtn.disabled = !back.length;
    redoBtn.disabled = !ahead.length;
    undoBtn.title = back.length ? `Back to ${visitName(back[back.length - 1])}` : '';
    redoBtn.title = ahead.length ? `Forward to ${visitName(ahead[ahead.length - 1])}` : '';
  };
  function revisit(from: Visit[], to: Visit[]): void {
    if (state.loading || state.expanding || !state.graph || !state.follows || !from.length) return;
    const v = from.pop()!;
    to.push({ graph: state.graph, follows: state.follows, provider: state.provider });
    state.graph = v.graph;
    state.follows = v.follows;
    state.provider = v.provider;
    view.setGraph(v.graph, false);
    hidePanel();
    runSearch();
    sourceCaption(v.graph);
    void readCasts(v.graph);
    markUrl(fidOf(v.graph.egoId));
    syncMe();
    syncHistory();
  }
  undoBtn.addEventListener('click', () => revisit(back, ahead));
  redoBtn.addEventListener('click', () => revisit(ahead, back));

  function markUrl(fid: number): void {
    const url = new URL(location.href);
    url.searchParams.set('fid', String(fid));
    if (state.provider.name === 'sample') url.searchParams.set('source', 'sample');
    history.replaceState(null, '', url);
  }

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
      // A new centre starts a new branch of the history.
      if (state.graph && state.follows && !fellBack) {
        back.push({ graph: state.graph, follows: state.follows, provider: state.provider });
        if (back.length > HISTORY_MAX) back.shift();
        ahead.length = 0;
        syncHistory();
      }
      state.graph = graph;
      state.follows = follows;
      setStatus('');
      view.setGraph(graph, false);
      // A tap during the crawl may have opened the panel on the old graph.
      hidePanel();
      runSearch();
      sourceCaption(graph);
      // A fallback keeps the asked-for URL, so a reload retries live data.
      if (!fellBack) markUrl(fid);
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
    // Last casts read once the load is over (reads pause while one runs): the new graph's, or the kept one's.
    if (state.graph) void readCasts(state.graph);
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

// Time: unposted (never cast) at the left, a tick, then cast within 01m … 10y, then all at the right.
// A default arrives once, unless the slider was moved first.
function wireTime(view: GraphView): { setDefault(step: number): void } {
  const time = $<HTMLInputElement>('time');
  let moved = false;
  time.max = String(AGE_STEPS);
  time.parentElement!.style.setProperty('--tick', String(0.5 / AGE_STEPS));
  const stop = () => ageStop(Number(time.value));
  const label = () => {
    const s = stop();
    $('timeVal').textContent = s === 'unposted' ? '∅' : (s?.label ?? 'all');
    time.setAttribute('aria-valuetext', s === 'unposted' ? 'never cast' : s ? `cast within ${s.label}` : 'all');
  };
  const apply = () => {
    const s = stop();
    view.setTimeKeep(s === 'unposted' ? 'unposted' : s?.ms);
  };
  time.value = time.max;
  label();
  // Each value re-solves the layout, so a drag or a held key solves once it stops for 150 ms.
  let solveT = 0;
  time.addEventListener('input', () => {
    moved = true;
    label();
    clearTimeout(solveT);
    solveT = window.setTimeout(apply, 150);
  });
  return {
    setDefault(step) {
      if (moved) return;
      time.value = String(step);
      label();
      apply();
    },
  };
}

// Returns the search runner so a new or grown graph re-applies the query.
function wireControls(view: GraphView, recenter: (target: string) => void): () => void {
  const menuBtn = $('menuBtn');
  const controls = $('controls');
  menuBtn.addEventListener('click', () => {
    controls.hidden = !controls.hidden;
    menuBtn.setAttribute('aria-expanded', String(!controls.hidden));
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
  // Links row: All (its own button) turns every direction on; each direction toggles itself.
  const links = $('links');
  const linksAll = $('linksAll');
  const show: LinkShow = { mutual: true, following: true, follows: true };
  const kinds = Object.keys(show) as Array<keyof LinkShow>;
  const pressed = (b: HTMLElement, on: boolean) => {
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  };
  const applyLinks = () => {
    links.querySelectorAll('button').forEach((b) => pressed(b, show[b.dataset.links as keyof LinkShow]));
    pressed(linksAll, kinds.every((k) => show[k]));
    view.setLinkShow(show);
  };
  linksAll.addEventListener('click', () => {
    for (const k of kinds) show[k] = true;
    applyLinks();
  });
  links.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const k = b.dataset.links as keyof LinkShow;
    show[k] = !show[k];
    applyLinks();
  });

  const depth = $<HTMLInputElement>('depth');
  depth.addEventListener('input', () => {
    $('depthVal').textContent = depth.value;
    view.setDepth(Number(depth.value));
  });

  $<HTMLInputElement>('hulls').addEventListener('change', (e) => view.setHulls((e.target as HTMLInputElement).checked));

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
