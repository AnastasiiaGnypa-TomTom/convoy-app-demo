# Convoy App

Constraint-aware convoy routing on satellite imagery — a joint **TomTom × Vantor** demo.

TomTom supplies the basemap, routing, and live traffic; Vantor (Maxar Hub) supplies the
satellite imagery backdrop. The routing and traffic layers deliberately sit on top of the
imagery, because making TomTom's contribution visible over Vantor's is the point of the demo.

Single-screen, responsive, no authentication — one URL anyone can open.

---

## What it does

1. **Pick a fleet profile** — light vehicle, van, heavy truck, oversized/heavy convoy, or a
   custom vehicle exposing weight, axle weight, length, width, and height.
2. **Set start and destination** — your own location (with permission), typed search with
   autocomplete, or by clicking the map twice.
3. **Get a constraint-aware route** with selectable alternatives. Heavier and taller vehicles
   are pushed off restricted roads, so the route visibly changes with the profile.
4. **Toggle Vantor imagery** beneath TomTom's roads and labels.
5. **Toggle live traffic** — flow tiles, incidents, and congestion highlighted on the chosen route.
6. **Toggle 2D/3D** — the route drapes over terrain elevation.

---

## Run locally

```bash
cp .env.example .env      # then fill in the two keys
npm install
npm run build             # builds the React app into server/public
npm start                 # serves the app + API on http://localhost:8080
```

`npm run build` must be run before `npm start`, otherwise the server serves a placeholder page
explaining that the frontend has not been built. The API works either way.

### Frontend dev server (hot reload)

```bash
npm start                 # terminal 1 — API on :8080
npm --prefix client run dev   # terminal 2 — Vite on :5173, proxies /api to :8080
```

---

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `TOMTOM_API_KEY` | yes | Orbis basemap, routing, search/geocoding, traffic |
| `VANTOR_API_KEY` | yes | Vantor Hub imagery (sent as a `maxar-api-key` header) |
| `PORT` | no | Listen port. Defaults to `8080`. Azure sets this itself. |

Real process environment always wins over `.env`, so local dev and Azure read config through the
same accessor with no code change. `.env` is git-ignored and must never be committed.

### Check the keys are actually live

`/api/health` only reports whether a key is *present*, which cannot catch a revoked or rotated
key — the failure that turns a live demo into a blank map. This makes one cheap `HEAD` request per
vendor and reports the verdict:

```bash
curl localhost:8080/api/health/keys
```

```json
{ "ok": true,
  "tomtom": { "configured": true, "valid": true, "status": 200, "detail": "key accepted by TomTom" },
  "vantor": { "configured": true, "valid": true, "status": 200, "detail": "key accepted by Vantor Hub" } }
```

The same check runs at startup and prints a `[keys]` line per vendor. Worth running before a
meeting. It never returns key material, and results are cached for 30 s so it can be polled safely.

---

## Imagery modes: Seamless vs Latest

Two named modes, because seamlessness and freshness genuinely conflict and no single layer
satisfies both. Toggle sits next to the Imagery button; the default is **Seamless**.

| Mode | What it renders | Reads as |
| --- | --- | --- |
| **Seamless** (default) | Pinned to the `VIVID_STANDARD_30` mosaic via `cql_filter` on `productName`, newest-first sort **deliberately dropped** | `Vivid Standard 30 · Q2 2026 · seamless mosaic` |
| **Latest** | Unfiltered, `sortBy=acquisitionDate D` — freshest capture wins | `Daily Take · 1 Jul 2026 · <1% cloud · 36 cm · single capture` |

Sorting is dropped in Seamless on purpose: re-sorting by date lets a fresher single-pass strip win
in places and reintroduces exactly the seams the mode exists to remove.

Latest is genuinely more current — over Amsterdam it was **1 Jul 2026 versus Q2 2026 for the
mosaic**, roughly seven weeks fresher — but it composites many passes with different sun angles and
sensors, so **visible strip edges are normal**. The readout says "single capture" so those edges
read as recent single-pass imagery rather than as a rendering fault.

**Changing the default** is one line: `DEFAULT_IMAGERY_MODE` in
[`server/lib/vantor.js`](server/lib/vantor.js). That is independent of the UI toggle, which
overrides it for the session only and persists nothing.

**Fallback.** If no mosaic covers the viewport, Seamless falls back to Latest rather than rendering
nothing — an empty overlay in a live demo reads as a broken app. The readout then says *"No seamless
mosaic covers this area — showing latest capture instead."* Verified over Antarctica, which has no
mosaic but does have a 2024 daily take. In practice this is rare: `VIVID_STANDARD_30` rendered
non-blank everywhere tested, including rural Friesland, the Sahara and Greenland.

### What was discovered, not assumed (2026-07-30)

- Only **three** `productName` values exist on this account: `VIVID_STANDARD_30` (id 256),
  `VIVID_ADVANCED_15` (458), `DAILY_TAKE` (233/234).
- **`cql_filter` is honoured on WMTS `GetTile`** — a bogus product returns a 1,670-byte blank tile.
- `Maxar:Imagery` + `cql_filter productName='VIVID_STANDARD_30'` is **byte-identical** to the
  dedicated `Maxar:VividStandard` layer, so either route works; CQL keeps it to one code path.
- `VIVID_ADVANCED_15` is 15 cm but **city-only** (blank in rural NL and Tyrol), so it is not a safe
  default — a good manual swap for an urban demo though.
- `Maxar:VividBasic` and `Maxar:EnhancedImagery` return blank even over Amsterdam: not entitled.
- **WFS gotcha:** `bbox` and `cql_filter` as separate parameters return HTTP 500. The working form
  puts `BBOX(featureGeometry, minLat, minLon, maxLat, maxLon)` *inside* `cql_filter`, and lat/lon
  order matters — lon/lat silently returns zero features.

---

## ⚠ Imagery zoom is capped at 14, on purpose

**Streaming Vantor imagery beyond zoom 14 is billable**, and this app is deliberately public with
no authentication — so an uncapped overlay would be an unmetered tap on the Vantor account that
anyone with the link could run up.

Evidence for the cap: Maxar's own `mgp-streaming-search` sample ships a "Free" switch that is **on
by default** and calls `map.setMaxZoom(14)`; switching it off raises the cap and immediately warns
*"Warning: You are now incurring costs."* Verified independently — the Hub serves tiles at every
level from z10 to z20 with HTTP 200 and no watermark, so **the vendor imposes no limit of its own.**

How it is enforced:

- `IMAGERY_MAX_ZOOM` in [`server/lib/vantor.js`](server/lib/vantor.js) — the single constant.
- Advertised to MapLibre as the raster source `maxzoom`, so the client stops requesting deeper tiles.
- Enforced again **server-side** in [`server/routes/imagery.js`](server/routes/imagery.js), which
  returns `403` above the cap. The tile endpoint is public, so the client-side limit alone would be
  bypassable by a hand-crafted request.

Behaviour past the cap is graceful, not blank: MapLibre upsamples the z14 tile, so imagery stays
visible and simply softens, and the UI says *"Upsampled beyond zoom 14 — deeper streaming is
billable."*

**Raising this costs money.** Change the one constant, and only with the account owner's agreement.

### Keys never reach the browser

Both keys live only in the Express proxy. The React app calls `/api/*` and the proxy calls the
vendors. TomTom embeds its key directly in the style's tile, sprite, and glyph URLs, so all three
are rewritten to proxy paths (`/api/basemap/{tile,sprite,glyphs}`) before the style reaches the
client.

To verify after any change:

```bash
grep -r "$(grep '^TOMTOM_API_KEY=' .env | cut -d= -f2)" server/public/   # must return nothing
grep -r "api.tomtom.com\|api.maxar.com" server/public/                   # must return nothing
```

---

## Deploy to Azure App Service

One Linux Node App Service serves both the API and the built frontend — one app, one URL.

### From VS Code (Azure App Service extension)

1. Create an App Service: **Linux**, runtime **Node 20 LTS** (or 22).
2. Right-click the project root → **Deploy to Web App…** → select the app.
3. When prompted to update the workspace config for faster deploys, accept.
4. Add the application settings below, then restart the app.

### Application settings

Set these in **Configuration → Application settings** (or `az webapp config appsettings set`):

| Name | Value | Why |
| --- | --- | --- |
| `TOMTOM_API_KEY` | *your key* | TomTom APIs |
| `VANTOR_API_KEY` | *your key* | Vantor Hub |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | Runs `npm install` + `npm run build` on the server, so `server/public` is produced during deploy |
| `WEBSITE_NODE_DEFAULT_VERSION` | `~20` | Only needed if the runtime stack is not already pinned |

Do **not** set `PORT` — App Service injects it.

**Startup command:** leave blank. App Service runs `npm start`, which is what this app expects.

### Notes

- `server/public/` and `node_modules/` are git-ignored. The build runs on the server, which is why
  `SCM_DO_BUILD_DURING_DEPLOYMENT=true` matters. If you would rather ship a prebuilt frontend,
  run `npm run build` locally and remove `server/public/` from `.gitignore`.
- Geolocation needs a secure context. It works on the App Service HTTPS URL and on `localhost`,
  but not over plain HTTP. Without it the app simply asks the user to click a start point.
- No authentication by design — anyone with the link can use it.

---

## Vendor integration notes

Everything below was established by probing the live APIs, not from documentation. Re-run
`npm run probe:vantor` after any Vantor account change.

### TomTom

| Capability | Endpoint | Notes |
| --- | --- | --- |
| Basemap | Orbis `assets/styles/0.*/style.json`, `apiVersion=1` | Style `basic_street-light`. Tiles/sprite/glyphs proxied. |
| Routing | **Classic Routing v1** | See below — Orbis Routing cannot carry the convoy constraints. |
| Geocoding | Search v2 `search/2/search` | Orbis `places/geocode` returns 401 on this key. |
| Traffic flow | `traffic/map/4/tile/flow/relative0/…` | Orbis traffic tile path rejects the v4 style names. |
| Traffic incidents | `traffic/services/5/incidentDetails` | Fetched for the visible bbox, cached 60 s. |

**Why routing is not on Orbis.** Orbis Routing (`apiVersion=2`) does not support the vehicle
constraints this demo exists to show. `travelMode` accepts only `car`; `vehicleLength`,
`vehicleWidth`, `vehicleHeight`, and `vehicleAxleWeight` all return
`400 "parameter not supported"` — as query parameters and as a POST body. Only `vehicleWeight`,
`vehicleMaxSpeed`, and `vehicleEngineType` are accepted. Classic Routing v1 accepts the full set,
so routing runs there. The swap-back point is documented at the top of
[`server/lib/profiles.js`](server/lib/profiles.js).

Also worth knowing: Orbis Routing rejects `apiVersion=1` with *"This API version is no longer
available"* — it needs `apiVersion=2`.

### Vantor (Maxar Hub)

| Capability | Status | Notes |
| --- | --- | --- |
| Auth | working | API key in a `maxar-api-key` header. No OAuth2 flow needed. (`?maxar_api_key=` also works, but a header keeps keys out of logs.) |
| STAC catalog | working | 68 collections visible. |
| Imagery | working | WMTS `GetTile`, layer `Maxar:Imagery`, tile matrix set `EPSG:3857` — maps 1:1 onto MapLibre `{z}/{x}/{y}`. **Capped at z14, see above.** |
| Provenance | working | WFS `Maxar:FinishedFeature` — describes the streaming layer itself, so it can honestly state the date/quality of imagery on screen. |
| Monitoring | working, unused | `GET /monitoring/v1/monitors` → 200; `POST` → 400 not 403, i.e. **writes are permitted**. Nothing calls it; see the change-detection seam in [`server/index.js`](server/index.js). |
| Terrain | **gap** | See below. |

**Imagery sorting.** Newest-first is already the service default (verified: an explicit
`sortBy=acquisitionDate D` returns byte-identical output to no sort), so the overlay shows the most
recent available imagery without asking. Maxar's sort suffixes are `A`/`D`; standard WFS `DESC`
returns HTTP 400.

**A caution if you ever add CQL filtering.** A misspelled property returns **HTTP 200 with a blank
tile**, not an error — Maxar's own CQL sample documents a field (`sunAngle`) that does not exist.
Validate against `GET /streaming/v1/ogc/ows?service=WFS&request=DescribeFeatureType&version=2.0.0`.
The property-name differences between the STAC and WFS/CQL vocabularies are tabulated in the seam
comments in [`server/index.js`](server/index.js).

**Why 3D terrain uses an open DEM.** Vantor 3D is not usable as a MapLibre terrain source on this
account, for two independent reasons:

1. `streaming/v1/3d/{layer}/latest/tileset.json` returns
   `403 — JWT does not contain expected claim mdsUser.mdsClientRoles.mgp:3D_TILES`. The key lacks
   the 3D Tiles role.
2. The `p3d-dsm` / `p3d-dtm` / `p3d-dsmdtm` collections do return items over an AOI, but every
   item has **zero assets** — they are coverage footprints advertising orderable 3D data, not
   fetchable elevation.

Even fully entitled, Vantor 3D is **Cesium 3D Tiles** (b3dm/glTF mesh) while MapLibre terrain
requires a `raster-dem` source (Terrarium or terrain-RGB), so it would need server-side
re-encoding regardless.

3D therefore runs on AWS Terrain Tiles (Terrarium). **To swap Vantor terrain in later, edit only
[`server/lib/terrain.js`](server/lib/terrain.js)** — point `tiles` at the Vantor raster-dem
endpoint and set the matching `encoding`. No other file needs changing.

---

## Project layout

```
server/
  index.js              Express app: serves server/public + /api/*
  lib/
    env.js              Config loading (process env wins over .env)
    tomtom.js           TomTom adapter — the only place the TomTom key is attached
    vantor.js           Vantor adapter — the only place the Vantor key is attached
    profiles.js         Fleet profiles → TomTom constraint parameters
    terrain.js          Terrain source — single swap point for Vantor terrain
    cache.js            Small TTL cache (the keys are rate-limited)
  routes/
    basemap.js          Orbis style + tile/sprite/glyph proxy
    route.js            Constraint-aware routing + alternatives
    geocode.js          Autocomplete + reverse geocoding
    traffic.js          Flow tiles + incidents
    imagery.js          Vantor WMTS tile proxy
    capabilities.js     What this deployment can actually do
  scripts/
    probe-vantor.js     Vantor capability probe (npm run probe:vantor)
client/
  src/
    App.jsx             State and layout
    components/         MapView, RoutePanel, PlaceInput, MapControls
    lib/
      routeLayers.js    Route/alternative/congestion layers, camera framing
      overlays.js       Imagery, traffic flow, incident layers + stacking order
      locate.js         Browser geolocation (best-effort)
```

### API endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness |
| `GET /api/health/keys` | Are both vendor keys actually accepted right now |
| `GET /api/config` | Non-secret map + terrain config |
| `GET /api/capabilities` | Which vendor features are live |
| `GET /api/basemap/style.json` | Orbis style, URLs rewritten to this proxy |
| `GET /api/basemap/tile/:z/:x/:y.pbf` | Vector tiles |
| `GET /api/basemap/sprite[@2x].{json,png}` | Sprite sheet |
| `GET /api/basemap/glyphs/:fontstack/:range.pbf` | Glyph ranges |
| `GET /api/route/profiles` | Fleet presets + custom-field bounds |
| `POST /api/route` | Route + alternatives for a vehicle profile |
| `GET /api/geocode?q=` | Autocomplete |
| `GET /api/geocode/reverse?lat=&lon=` | Reverse geocode (map clicks) |
| `GET /api/traffic/meta` | Flow tile source definition |
| `GET /api/traffic/tile/:z/:x/:y.png` | Traffic flow tiles |
| `GET /api/traffic/incidents?bbox=` | Incidents as GeoJSON |
| `GET /api/imagery/meta` | Per-mode source definitions, default mode, cost-guard values |
| `GET /api/imagery/:mode/:z/:x/:y.png` | Vantor imagery tiles per mode (403 above the zoom cap) |
| `GET /api/imagery/provenance?bbox=&mode=` | What imagery is on screen, plus the effective mode after any fallback |

---

## Out of scope

Change-detection rerouting, ATAK export, offline packages, authentication. Nothing is implemented,
but the attachment points in [`server/index.js`](server/index.js) now carry everything needed to
build them without re-deriving it: the three-call Monitoring → Discovery → WMS change-detection
flow, the monitor-creation body, the STAC-vs-CQL property vocabulary table, and a caution that
Maxar's `SHA256(apiKey)` tenancy trick does **not** work behind a shared server key on an
unauthenticated app.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Placeholder page instead of the app | `npm run build` has not run — `server/public` is missing. |
| Header shows "Fallback basemap" | Orbis style returned non-200 (usually the key lost the Maps entitlement). The app stays usable on a keyless OSM basemap. |
| Imagery button disabled | `VANTOR_API_KEY` not set on the server. |
| Imagery looks soft when zoomed right in | Expected — the z14 cost cap, upsampled. See the cap section above. |
| Blank map tiles, 502s in the log | Vendor rejected the key — run `curl localhost:8080/api/health/keys`, then check the server log (it redacts keys but reports vendor status codes). |
| "Imagery on screen" readout missing | No streamed imagery covers the current view, or the WFS call failed — the overlay still works, the readout just degrades to nothing. |
| Location not offered | Not a secure context (plain HTTP), or the user denied permission. |
