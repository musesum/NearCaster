# NearCaster

A Farcaster mini app that draws the viewer's friends-of-friends graph in D3. It takes its interaction model from Jeffrey Heer and danah boyd's Vizster (Friendster, InfoVis 2005). Its layout physics come from DeepMuse LeafGraph (MuMenu `flod3-embed.html`, BUILD_TOKEN `flod3-v4e0`).

TypeScript 7, Vite 8, D3 7.9, `@farcaster/miniapp-sdk` 0.3.0. No native code.

## Run

```bash
npm install
npm run dev          # http://localhost:5188/?fid=3   (live, any fid)
                     # http://localhost:5188/?source=sample   (offline synthetic network)
npm test             # node --test: Louvain, FollowSet, crawl + expand, layout (solve, Focus restore, guards)
npm run build        # tsc --noEmit + vite build
```

The ego is chosen in this order:
- inside a Farcaster client, the viewer from `sdk.context.user.fid`;
- otherwise `?fid=`;
- otherwise fid 3.

If live data fails on the first load, the app falls back to the sample network and says so. The URL keeps the asked-for fid, so a reload retries live data.

## Data

The live data source is the public Snapchain HTTP API at `https://snap.farcaster.xyz:3381`. It needs no key and answers with `Access-Control-Allow-Origin: *`, so the browser calls it directly.

| Need | Endpoint |
|---|---|
| following | `/v1/linksByFid?fid=&link_type=follow` |
| followers | `/v1/linksByTargetFid?target_fid=&link_type=follow` |
| profiles | `/v1/userDataByFid?fid=` |

How the crawl works (`src/data/crawl.ts`, budget `DEFAULT_BUDGET`):
1. Read the ego's follows. Keep up to 60 friends, mutuals first.
2. Read each friend's follows: one page of 500.
3. Keep the friends-of-friends followed by at least 2 friends, ranked by that count, up to 300 nodes in total.
4. Fetch profiles.

Every cap the crawl hits is listed in the Controls caption.

Cost: one load for fid 3 (dwr) took about 6 to 13 s and about 16 MB. The links are uncompressed (about 490 B each), which is the main mobile cost.

## Mini app publishing

1. Tunnel: `cloudflared tunnel --url http://localhost:5188`. Vite already allows `*.trycloudflare.com` and ngrok hosts. Open the tunnel URL once in a browser tab.
2. Preview: `https://farcaster.xyz/~/developers/mini-apps/preview?url=<encoded tunnel URL>`. Developer Mode must be on.
3. Manifest and embed:
   - Copy `.env.example` to `.env` and set `NEARCASTER_URL` to the https origin.
   - Sign `accountAssociation` in the Manifest tool for that exact domain and paste the three values.
   - The Vite plugin then serves and emits `/.well-known/farcaster.json` and injects the `fc:miniapp` meta tag.
4. Images: `node tools/make-images.mjs` regenerates `public/icon.png` (1024², no alpha), `splash.png` (200²) and `embed.png` (1200×800, 3:2).

`sdk.actions.ready({ disableNativeGestures: true })` is called as soon as the shell paints. Crawl progress then shows in the app. Disabling native gestures keeps graph drag and pinch from triggering the client's swipe-to-dismiss.

## What comes from where

| Vizster (Heer & boyd 2005) | NearCaster |
|---|---|
| Egocentric start, grow on demand | ego + follows + friends-of-friends; double-click (or Expand) reads a node's network and pins it |
| Connectivity highlight on hover | hover (mouse) or tap: hop 1 orange ring, hop 2 faded, the rest dimmed; 500 ms exit hysteresis |
| Community blobs (Newman CNM) | Louvain over the undirected follow graph, ego excluded; hulls with Vizster corner growth 5 px |
| Keyword search with auras | regex search over name, username and fid; Enter selects the first hit |
| Profile panel | panel with bio, ring, follow-back, "also followed by N of your follows", View profile, Expand, Center here, Cast |
| X-ray attribute coloring | Color: Community / Hop / Reach (links in the graph) / Mutual |

| LeafGraph (flod3-embed.html) | NearCaster `src/graph/layout.ts` |
|---|---|
| `solveFit` chokepoint, settle then 420 ms flight, `fitField` (never past 1:1) | `Layout.solveFit`: sync settle from alpha 0.3, cubic ease-in-out flight, camera fit |
| Calm: highlight and selection move 0 px | paint-only paths; measured 0.000 px on select and on Context |
| No-op rebuild guard (visible ids + link wires) | signature guard in `reheatLocal` / `bindQuiet` |
| `reheatAlpha` (alphaTarget 0.12 for 300 ms), `freezeFar`, `thawWhenCold` | the same, used by Expand and the community-pull slider |
| Forces guardIn, charge −50/240/θ0.9, link (tree 2.4, edges 0.8 ÷ min degree, 3 iterations, cap 2.6), voro, polar, guardOut | the same order; plus community pull 0.08 and radial bands |
| Voronoi capsule separation instead of forceCollide | Delaunay-neighbour circle separation; drag moves only contact neighbours |
| v3e guards: VEL_MAX 10000, non-finite repair, guards at both ends | `guardForce()` registered first and last |
| Focus / Context / All, depth ball | Focus hides and re-solves; Context grays in place; All shows everything; Focus exit restores positions, polar base and camera exactly (0 px); pins made or released inside Focus stand |
| Drag pins on drop | the same; a press that travels under 8 screen px is a tap and moves nothing; double-click a pinned node to release it |

Addition beyond both sources: **radial bands**. A dense follow graph (mean degree about 55) collapses into one blob that drifts off the pinned ego. To prevent that, each hop holds a band around the ego, and better-connected accounts sit nearer the inside of their band.

## Layout of the code

```
src/main.ts            boot, provider choice + fallback, wiring
src/host.ts            mini-app SDK seam (browser fallback outside a client)
src/data/              types, Snapchain + sample providers, crawl/expand
src/graph/community.ts Louvain
src/graph/layout.ts    LeafGraph physics port
src/graph/view.ts      SVG render, scope modes, highlight, search, camera
src/ui/panel.ts        profile panel
vite.config.ts         manifest + embed plugin, tunnel hosts
```
