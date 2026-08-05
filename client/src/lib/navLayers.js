import maplibregl from 'maplibre-gl';

/**
 * Navigation-mode map layers: the travelled/ahead split and the vehicle puck.
 *
 * Kept separate from routeLayers.js because these only exist while navigating, and
 * they sit above the ordinary route lines.
 */

export const NAV_SOURCES = { travelled: 'nav-travelled', ahead: 'nav-ahead' };
export const NAV_LAYERS = {
  travelled: 'nav-travelled-line',
  aheadCasing: 'nav-ahead-casing',
  ahead: 'nav-ahead-line',
};

const EMPTY = { type: 'FeatureCollection', features: [] };
const line = (coords) =>
  coords && coords.length > 1
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] }
    : EMPTY;

export function ensureNavLayers(map) {
  if (map.getLayer(NAV_LAYERS.ahead)) return;

  for (const id of Object.values(NAV_SOURCES)) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
  }

  // Behind: dimmed, so it reads as "done" without disappearing entirely.
  map.addLayer({
    id: NAV_LAYERS.travelled,
    type: 'line',
    source: NAV_SOURCES.travelled,
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#5b6673', 'line-width': 7, 'line-opacity': 0.55 },
  });

  // Ahead: bright and thick — the thing the driver is following.
  map.addLayer({
    id: NAV_LAYERS.aheadCasing,
    type: 'line',
    source: NAV_SOURCES.ahead,
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#0b1016', 'line-width': 14, 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: NAV_LAYERS.ahead,
    type: 'line',
    source: NAV_SOURCES.ahead,
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#38bdf8', 'line-width': 9 },
  });
}

export function setNavProgress(map, { travelled, ahead }) {
  map.getSource(NAV_SOURCES.travelled)?.setData(line(travelled));
  map.getSource(NAV_SOURCES.ahead)?.setData(line(ahead));
}

export function setNavVisible(map, visible) {
  for (const id of Object.values(NAV_LAYERS)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/**
 * The vehicle puck.
 *
 * A DOM marker rather than a symbol layer so it can be rotated with a CSS transform
 * on every animation frame — cheaper than pushing GeoJSON updates at 60fps.
 */
export function createVehicleMarker() {
  const el = document.createElement('div');
  el.className = 'vehicle-puck';
  el.innerHTML = '<span class="vehicle-puck-arrow"></span>';
  return new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' });
}
