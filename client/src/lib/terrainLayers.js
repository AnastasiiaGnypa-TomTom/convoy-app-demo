/**
 * Terrain-derived map layers: hillshade, and the steep-segment highlight.
 *
 * Hillshade comes from the same raster-dem source as 3D terrain, so it works in 2D
 * as well — relief is situational awareness whether or not the camera is tilted.
 */

export const DEM_SOURCE_ID = 'terrain-dem';
export const HILLSHADE_LAYER = 'terrain-hillshade';
export const STEEP_SOURCE = 'route-steep';
export const STEEP_LAYER = 'route-steep-line';

const EMPTY = { type: 'FeatureCollection', features: [] };

/** Add the DEM once. Terrain and hillshade share it — two sources would double fetches. */
export function ensureDemSource(map, source) {
  if (!map.getSource(DEM_SOURCE_ID)) map.addSource(DEM_SOURCE_ID, source);
}

/**
 * Hillshade, inserted low in the stack.
 *
 * Placed before the first line/symbol layer so relief sits under roads and labels
 * rather than washing them out, and kept subtle — it is context, not the subject.
 */
export function ensureHillshade(map) {
  if (map.getLayer(HILLSHADE_LAYER)) return;
  if (!map.getSource(DEM_SOURCE_ID)) return;

  let beforeId;
  for (const l of map.getStyle().layers || []) {
    if (l.type === 'line' || l.type === 'symbol') {
      beforeId = l.id;
      break;
    }
  }

  map.addLayer(
    {
      id: HILLSHADE_LAYER,
      type: 'hillshade',
      source: DEM_SOURCE_ID,
      layout: { visibility: 'none' },
      paint: {
        'hillshade-exaggeration': 0.68,
        'hillshade-shadow-color': 'rgba(10,14,20,0.55)',
        'hillshade-highlight-color': 'rgba(255,255,255,0.18)',
        'hillshade-accent-color': 'rgba(0,0,0,0)',
      },
    },
    beforeId,
  );
}

/** Steep stretches over the vehicle's grade limit, drawn above the route. */
export function ensureSteepLayer(map) {
  if (map.getLayer(STEEP_LAYER)) return;
  if (!map.getSource(STEEP_SOURCE)) map.addSource(STEEP_SOURCE, { type: 'geojson', data: EMPTY });

  map.addLayer({
    id: STEEP_LAYER,
    type: 'line',
    source: STEEP_SOURCE,
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      // Amber to match the chart bands, and wider than the route so it reads as a
      // marking ON the route rather than a different road.
      'line-color': '#f59e0b',
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 6, 16, 12],
      'line-opacity': 0.85,
    },
  });
}

export function setSteepData(map, fc) {
  map.getSource(STEEP_SOURCE)?.setData(fc || EMPTY);
}

export function setLayerVisibility(map, id, visible) {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
}

/**
 * Zoom-compensated exaggeration.
 *
 * ── The problem this solves ───────────────────────────────────────────────
 * Terrain was working at every zoom — measured in the Alps, the DEM samples a
 * 55..4723 m spread even at z7. But you could not SEE it until you were zoomed
 * right in, and that is geometry, not a bug: at z8 the view spans about 150 km, so
 * 4 km of relief is under 3% of the frame. At z13 the view spans 5 km and the same
 * relief is nearly half the frame, which is why it suddenly "appears".
 *
 * A single exaggeration number therefore cannot look right at both ends. This scales
 * the user's chosen value up as the view widens, so the shape of the ground stays
 * readable while zooming out instead of flattening away.
 *
 * The boost is deliberately far below what strict proportion would demand — matching
 * pixel-for-pixel relief from z13 to z8 would need roughly 30x, which turns mountains
 * into spikes because the terrain mesh is coarse at low zoom. These values were chosen
 * to keep ridgelines and valleys legible while still looking like terrain.
 */
const ZOOM_BOOST = [
  [6, 5.5],
  [8, 4.0],
  [10, 2.6],
  [12, 1.6],
  [13.5, 1.1],
  [15, 1.0],
];

/** Highest effective value we will hand MapLibre, whatever the user picks. */
export const MAX_EFFECTIVE_EXAGGERATION = 8;

export function zoomBoost(zoom) {
  if (!Number.isFinite(zoom)) return 1;
  if (zoom <= ZOOM_BOOST[0][0]) return ZOOM_BOOST[0][1];
  const last = ZOOM_BOOST[ZOOM_BOOST.length - 1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < ZOOM_BOOST.length; i++) {
    const [z1, b1] = ZOOM_BOOST[i - 1];
    const [z2, b2] = ZOOM_BOOST[i];
    if (zoom <= z2) {
      const t = (zoom - z1) / (z2 - z1);
      return b1 + (b2 - b1) * t;
    }
  }
  return 1;
}

export function effectiveExaggeration(base, zoom) {
  const b = Number.isFinite(base) ? base : 1;
  return Math.min(MAX_EFFECTIVE_EXAGGERATION, b * zoomBoost(zoom));
}
