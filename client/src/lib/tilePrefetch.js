/**
 * Route imagery preloading.
 *
 * ── The problem, and why the strategy is what it is ───────────────────────
 * Driving guidance moves the camera into map area that has never been rendered, so
 * tiles are requested only once they are needed. At demo speed that produces a
 * visible "blur front" travelling with the vehicle: you are always driving into
 * imagery that is still resolving.
 *
 * The two obvious fixes are both wrong:
 *
 *   no preload at all   → guidance starts on blurry tiles, which is the most
 *                         damaging possible frame because it is the FIRST one
 *   preload the route   → correct-looking but far too slow. A full corridor at nav
 *                         zoom is ~900 tiles; the user stares at a progress counter
 *                         before anything happens, and most of those tiles are for
 *                         road that will not be reached for ten minutes
 *
 * So: warm a SMALL start buffer, begin immediately, and keep a rolling window ahead
 * of the vehicle. The start buffer only has to cover what the opening camera shows
 * plus a few seconds of travel; everything past that is the rolling window's job, and
 * the rolling window has the whole drive to stay ahead.
 *
 * Deliberately uses fetch() rather than new Image(): the response is the same HTTP
 * cache entry MapLibre will later use, and fetch lets us bound concurrency and abort
 * a batch if the user cancels.
 */

const lonToTileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/**
 * Hard ceiling on prefetch requests in flight — GLOBAL, not per batch.
 *
 * It has to be global because batches overlap by design: the start buffer is left
 * running in the background when guidance stops waiting for it, so it is still
 * settling when the rolling window begins. Per-batch caps stack (measured: 6 + 4 = 10
 * concurrent), and any future third caller would stack again. One shared pool means
 * the bound holds no matter how many batches are live, and MapLibre's own tile loading
 * keeps the bandwidth it needs to render what is already on screen.
 */
const MAX_IN_FLIGHT = 6;

let inFlightCount = 0;
const waiting = [];

async function acquireSlot() {
  if (inFlightCount < MAX_IN_FLIGHT) {
    inFlightCount++;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
  inFlightCount++;
}

function releaseSlot() {
  inFlightCount--;
  waiting.shift()?.();
}

/** Exposed for the acceptance tests, which assert the global bound holds. */
export const prefetchInFlight = () => inFlightCount;

/**
 * Tiles along a route LINE with a narrow buffer.
 *
 * `ring` widens the corridor by whole tiles either side. A fat bbox around the route
 * would be quadratic in route length and would mostly cover ground the camera never
 * sees; following the line keeps the count proportional to distance. ring=1 suffices
 * even though the nav camera is tilted, because the far part of a tilted view is
 * covered by the tiles for road further along the line anyway.
 */
export function corridorTiles(coordinates, { zoom, ring = 1, fromIndex = 0, toIndex = Infinity }) {
  const seen = new Set();
  const tiles = [];
  const max = 2 ** zoom;

  for (let i = Math.max(0, fromIndex); i < Math.min(coordinates.length, toIndex); i++) {
    const [lon, lat] = coordinates[i];
    const cx = lonToTileX(lon, zoom);
    const cy = latToTileY(lat, zoom);
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= max || y >= max) continue;
        const key = `${x}/${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tiles.push({ z: zoom, x, y });
      }
    }
  }
  return tiles;
}

/** Polyline index at which `meters` of route have been travelled. */
function indexAtDistance(cum, meters) {
  let i = 0;
  while (i < cum.length - 1 && cum[i] < meters) i++;
  return i;
}

/**
 * Warm a list of tiles, bounded and interruptible.
 *
 * `deadline` is what keeps the initial warm short: workers stop taking new work once
 * it passes, so a slow network shortens the batch rather than delaying the start.
 */
export async function warmTiles(
  urls,
  { concurrency = MAX_IN_FLIGHT, signal, onProgress, deadline = null } = {},
) {
  let done = 0;
  let next = 0;
  const total = urls.length;

  const worker = async () => {
    while (next < urls.length) {
      if (signal?.aborted) return;
      if (deadline != null && performance.now() > deadline) return;
      const url = urls[next++];
      // Slots come from the shared pool, so overlapping batches cannot stack.
      await acquireSlot();
      try {
        // `no-store` would defeat the point; we WANT this in the HTTP cache.
        await fetch(url, { signal, cache: 'force-cache' });
      } catch {
        /* a missed tile is not worth failing the drive over */
      } finally {
        releaseSlot();
      }
      done++;
      onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return done;
}

/** Build imagery tile URLs, carrying the active mode and capture date. */
export function imageryTileUrls(tiles, { mode = 'seamless', captureDate = null } = {}) {
  return tiles.map(({ z, x, y }) => {
    const base = `/api/imagery/${mode}/${z}/${x}/${y}.png`;
    return captureDate ? `${base}?date=${encodeURIComponent(captureDate)}` : base;
  });
}

/* ─────────────────────────────── initial warm ────────────────────────────── */

/** Start-buffer bounds. Whichever is reached first ends the warm. */
export const START_BUFFER_METERS = 800;
export const START_BUFFER_MAX_TILES = 50;
export const START_BUFFER_TIMEOUT_MS = 2500;

/**
 * Warm only what the OPENING navigation view needs, plus a short run-up.
 *
 * Three independent caps, because each covers a different failure: distance keeps the
 * work proportional to what is about to be seen, the tile count protects a dense urban
 * start where 800 m spans many tiles, and the timeout protects a slow network.
 * Guidance starts on whichever fires first, so the wait is bounded at ~2.5 s
 * regardless of route length or connection quality.
 *
 * Tiles are ordered nearest-first, so if a cap does fire, what actually got fetched is
 * exactly what the first seconds of the drive will show.
 */
export async function prefetchStartBuffer(
  coordinates,
  {
    navZoom,
    mode,
    captureDate,
    cum = null,
    bufferMeters = START_BUFFER_METERS,
    maxTiles = START_BUFFER_MAX_TILES,
    timeoutMs = START_BUFFER_TIMEOUT_MS,
    signal,
    onProgress,
  } = {},
) {
  if (!coordinates?.length) return { warmed: 0, total: 0, capped: null };

  // Only the stretch inside the buffer.
  const toIndex = cum ? indexAtDistance(cum, bufferMeters) + 1 : Math.min(coordinates.length, 40);

  const zoom = Math.round(navZoom);
  /*
   * Two zooms, both needed. The entry animation passes through a shallower zoom on its
   * way in, so without z-1 the opening frames are blurry even when the tiles for the
   * destination zoom are warm. z-1 is cheap — a quarter of the tiles.
   */
  const near = corridorTiles(coordinates, { zoom, ring: 1, toIndex });
  const wide = corridorTiles(coordinates, { zoom: zoom - 1, ring: 1, toIndex });

  // Interleave so the earliest fetches cover the start at both zooms.
  const ordered = [];
  for (let i = 0; i < Math.max(near.length, wide.length); i++) {
    if (i < near.length) ordered.push(near[i]);
    if (i < wide.length) ordered.push(wide[i]);
  }

  const cappedByCount = ordered.length > maxTiles;
  const tiles = ordered.slice(0, maxTiles);
  const urls = imageryTileUrls(tiles, { mode, captureDate });

  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  let warmed = 0;

  /*
   * The timeout has to be a RACE, not just a check inside the worker loop.
   *
   * Checking the deadline before taking new work is not enough: with six workers each
   * holding a fetch that has already started, the caller still waits deadline PLUS the
   * slowest outstanding request. Measured at 3.6 s against a 2.5 s budget on tiles that
   * take about a second each — the exact long wait this design is meant to avoid.
   *
   * So resolve at the deadline regardless. The batch is deliberately NOT aborted: those
   * fetches are already paid for and still land in the HTTP cache, arriving during the
   * entry animation where they are exactly what is needed. Guidance simply stops waiting
   * for them.
   */
  const batch = warmTiles(urls, {
    signal,
    onProgress: (d, t) => {
      warmed = d;
      onProgress?.(d, t);
    },
    deadline,
  });
  const timedOut = await Promise.race([
    batch.then(() => false),
    new Promise((r) => setTimeout(() => r(true), timeoutMs)),
  ]);

  return {
    warmed,
    total: urls.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    // Still settling in the background when we stopped waiting.
    stillWarming: timedOut,
    capped: timedOut ? 'timeout' : cappedByCount ? 'tiles' : null,
  };
}

/* ────────────────────────────── rolling window ───────────────────────────── */

export const ROLLING_AHEAD_METERS = 1500;

/**
 * Keep the road ahead warm while driving.
 *
 * Called repeatedly as the drive progresses. Three things keep it cheap enough to run
 * every couple of seconds:
 *
 *   - a `warmed` key set, so a tile is never requested twice across calls;
 *   - a zoom split: the near half of the window is fetched at full nav zoom because
 *     the vehicle reaches it within seconds, while the far half is fetched one level
 *     out — a quarter of the tiles, enough to remove blur, and refined at full zoom by
 *     a later call once it becomes the near half;
 *   - `inFlight`, which makes calls self-skipping. If the previous top-up is still
 *     running, this tick does nothing, so a slow network cannot build a backlog of
 *     overlapping batches. In-flight tiles stay bounded by the concurrency cap.
 */
export function createRollingPrefetch({ coordinates, cum, navZoom, mode, captureDate }) {
  const warmed = new Set();
  let inFlight = false;

  const takeNew = (tiles) =>
    tiles.filter((t) => {
      const k = `${t.z}/${t.x}/${t.y}`;
      if (warmed.has(k)) return false;
      warmed.add(k);
      return true;
    });

  const prefetchAhead = async function prefetchAhead(
    distanceAlong,
    { aheadMeters = ROLLING_AHEAD_METERS } = {},
  ) {
    if (inFlight || !coordinates?.length || !cum?.length) return 0;

    const from = indexAtDistance(cum, distanceAlong);
    const mid = indexAtDistance(cum, distanceAlong + aheadMeters / 2);
    const to = indexAtDistance(cum, distanceAlong + aheadMeters);
    if (to <= from) return 0;

    const zoom = Math.round(navZoom);
    const tiles = [
      // Near half: full detail, reached in seconds.
      ...takeNew(corridorTiles(coordinates, { zoom, ring: 1, fromIndex: from, toIndex: mid + 1 })),
      // Far half: one level out, refined later when it becomes the near half.
      ...takeNew(
        corridorTiles(coordinates, { zoom: zoom - 1, ring: 1, fromIndex: mid, toIndex: to + 1 }),
      ),
    ];
    if (!tiles.length) return 0;

    inFlight = true;
    try {
      return await warmTiles(imageryTileUrls(tiles, { mode, captureDate }), { concurrency: 4 });
    } finally {
      inFlight = false;
    }
  };

  /** Exposed for the acceptance tests, which assert the window stays bounded. */
  prefetchAhead.stats = () => ({ warmedCount: warmed.size, busy: inFlight });
  return prefetchAhead;
}
