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
        'hillshade-exaggeration': 0.45,
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
