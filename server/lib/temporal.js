/**
 * TemporalLayer — one time axis shared by imagery, elevation and (later) change.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS IS THE CHANGE-DETECTION SEAM. Read this before extending it.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The requirement is that imagery and elevation are modelled as TIME-STAMPED
 * CAPTURES, not as "the current layer", so that a diff between two moments can be
 * added later without touching the map or the UI.
 *
 * The model:
 *
 *   Capture {
 *     id            unique, stable
 *     kind          'imagery' | 'elevation'
 *     datetime      ISO 8601 — the single ordering key for the whole app
 *     available     can we actually RENDER this capture today?
 *     renderHint    how to render it (mode + CQL date filter for imagery)
 *     productName, cloudCoverPercent, resolutionMeters, sensor, source
 *   }
 *
 * Two properties make the seam work:
 *
 *   1. Every capture carries `datetime`, taken from the vendor's own metadata
 *      (Vantor WFS `acquisitionDate` for imagery, STAC `datetime` for the p3d
 *      elevation coverages). Nothing is synthesised.
 *
 *   2. `available` is separate from existence. Vantor's elevation coverages are
 *      real, dated, and NOT fetchable on this key (zero assets). They still appear
 *      on the time axis, marked unavailable, because "Vantor has a DSM here from
 *      2026-07-31 that we cannot stream" is exactly the fact a change-detection
 *      feature needs to reason about — and hiding it would make the axis lie.
 *
 * Imagery captures are genuinely renderable by date: the streaming layer accepts a
 * CQL filter on `acquisitionDate` (verified — filtering to a future window returns
 * an empty tile, filtering to a covered window returns imagery), so selecting a
 * capture really does change the pixels on screen.
 */

import { config } from './env.js';

const HUB = 'https://api.maxar.com';

const authHeaders = (extra = {}) => ({ 'maxar-api-key': config.vantorApiKey, ...extra });

/* -------------------------------------------------------------------------- */
/*  Capture discovery                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Imagery captures over a bbox, newest first.
 *
 * Uses WFS FinishedFeature rather than the STAC catalog because FinishedFeature
 * describes the STREAMING layer's own contents — i.e. what we can actually put on
 * screen — whereas STAC describes the orderable archive.
 *
 * NOTE on the query form: `bbox` and `cql_filter` as separate parameters return
 * HTTP 500 from this service. BBOX() must go inside cql_filter, and the coordinate
 * order must be lat,lon to match srsName EPSG:4326.
 */
async function imageryCaptures(bbox, { limit = 40, timeoutMs = 12_000 } = {}) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const params = new URLSearchParams({
    service: 'WFS',
    request: 'GetFeature',
    version: '2.0.0',
    srsName: 'EPSG:4326',
    typeNames: 'Maxar:FinishedFeature',
    outputFormat: 'application/json',
    cql_filter: `BBOX(featureGeometry,${minLat},${minLon},${maxLat},${maxLon})`,
    sortBy: 'acquisitionDate D',
    count: String(limit),
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HUB}/streaming/v1/ogc/wfs?${params}`, {
      headers: authHeaders({ accept: 'application/json' }),
      signal: ctl.signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.features || [])
      .map((f) => f.properties || {})
      .filter((p) => p.acquisitionDate)
      .map((p) => ({
        id: `imagery:${p.legacyIdentifier || p.featureId || p.acquisitionDate}`,
        kind: 'imagery',
        datetime: p.acquisitionDate,
        available: true,
        productName: p.productName || null,
        legacyIdentifier: p.legacyIdentifier || null,
        cloudCoverPercent: typeof p.cloudCover === 'number' ? p.cloudCover : null,
        resolutionMeters: p.groundSampleDistance ?? null,
        sensor: p.sensorName || p.source || null,
        source: 'vantor-streaming',
        /*
         * How the map renders THIS capture. The date window is what the imagery
         * tile route turns into a CQL filter, so choosing a capture on the time
         * control genuinely re-renders the tiles rather than just relabelling them.
         */
        renderHint: { type: 'imagery-date', date: p.acquisitionDate },
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Elevation captures over a bbox, from the Vantor p3d coverage collections.
 *
 * These are dated and real but carry no assets on this key, so they are reported
 * with `available: false`. They belong on the time axis anyway — see the note at
 * the top of this file.
 */
async function elevationCaptures(bbox, { timeoutMs = 12_000 } = {}) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const params = new URLSearchParams({
    collections: 'p3d-dsm,p3d-dtm,p3d-dsmdtm',
    bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
    limit: '10',
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HUB}/discovery/v1/search?${params}`, {
      headers: authHeaders({ accept: 'application/json' }),
      signal: ctl.signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.features || [])
      .filter((f) => f.properties?.datetime)
      .map((f) => {
        const assetCount = Object.keys(f.assets || {}).length;
        return {
          id: `elevation:${f.id}`,
          kind: 'elevation',
          datetime: f.properties.datetime,
          // Zero assets = coverage footprint only, nothing to stream.
          available: assetCount > 0,
          unavailableReason:
            assetCount > 0
              ? null
              : 'Vantor coverage footprint with no downloadable asset — orderable, not streamable.',
          productName: f.collection || null,
          resolutionMeters: null,
          sensor: null,
          source: 'vantor-p3d',
          renderHint: { type: 'elevation-stac', collection: f.collection, itemId: f.id },
        };
      });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/*  The TemporalLayer                                                         */
/* -------------------------------------------------------------------------- */

/**
 * All captures over an AOI on one time axis.
 *
 * @param {[number,number,number,number]} bbox [minLon, minLat, maxLon, maxLat]
 */
export async function listCaptures(bbox) {
  const [imagery, elevation] = await Promise.all([
    imageryCaptures(bbox),
    elevationCaptures(bbox),
  ]);

  const captures = [...imagery, ...elevation].sort(
    (a, b) => new Date(b.datetime) - new Date(a.datetime),
  );

  // Deduplicate identical product+date pairs: the mosaic appears once per tile it
  // covers, and a time axis with six identical entries is noise.
  const seen = new Set();
  const unique = [];
  for (const c of captures) {
    const key = `${c.kind}|${c.productName}|${c.datetime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  const dates = unique.map((c) => c.datetime).sort();
  return {
    aoi: bbox,
    captures: unique,
    byKind: {
      imagery: unique.filter((c) => c.kind === 'imagery').length,
      elevation: unique.filter((c) => c.kind === 'elevation').length,
    },
    timeRange: dates.length ? { earliest: dates[0], latest: dates[dates.length - 1] } : null,
    renderableCount: unique.filter((c) => c.available).length,
  };
}

/* -------------------------------------------------------------------------- */
/*  CHANGE DETECTION SEAM — stubbed on purpose                                */
/* -------------------------------------------------------------------------- */

/**
 * The interface a real implementation must satisfy.
 *
 *   detectChange(aoi, fromTime, toTime) -> ChangeResult
 *
 *   ChangeResult {
 *     implemented   false today
 *     aoi           [minLon, minLat, maxLon, maxLat]
 *     from, to      the two captures being compared
 *     summary       human-readable
 *     features      GeoJSON FeatureCollection of changed areas — the map layer
 *                   already knows how to render a FeatureCollection, so a real
 *                   implementation needs no map or UI change
 *     raster        optional { tiles: [...] } for a difference raster overlay
 *   }
 *
 * A real version could be dropped in behind this signature using Vantor analytics,
 * a raster difference over two dated imagery captures, or a DSM height delta. The
 * important part is that the CALLER — routes/temporal.js and the UI control — is
 * already written against this shape, so implementing it touches only this
 * function.
 *
 * Deliberately returns a well-formed "not implemented" result rather than throwing,
 * so the UI can show a real, honest response from a real endpoint.
 */
export async function detectChange(aoi, fromTime, toTime) {
  return {
    implemented: false,
    aoi,
    from: fromTime || null,
    to: toTime || null,
    summary:
      'Change detection is not implemented. The temporal model, the two selected ' +
      'captures and this interface are in place; a diff implementation can be added ' +
      'behind detectChange() in server/lib/temporal.js without touching the map or UI.',
    features: { type: 'FeatureCollection', features: [] },
    raster: null,
    candidateApproaches: [
      'Vantor Monitoring API (entitled on this key: GET /monitoring/v1/monitors returns 200, POST returns 400 not 403, so writes are permitted)',
      'Raster difference over two dated imagery captures via cql_filter on acquisitionDate',
      'DSM height delta once a fetchable Vantor elevation asset is entitled (needs mgp:3D_TILES)',
    ],
  };
}
