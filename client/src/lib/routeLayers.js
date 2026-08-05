import maplibregl from 'maplibre-gl';

/**
 * MapLibre layer management for routes and endpoint markers.
 *
 * Kept out of the React component so the map stays the single source of truth for
 * what is drawn: React owns the data, these functions reconcile the map to it.
 *
 * Alternatives are drawn beneath the selected route so the chosen line always
 * reads as the primary one, and each line has a dark casing to stay legible over
 * both the light Orbis basemap and (from Step 6) satellite imagery.
 */

export const ROUTE_SOURCE = 'convoy-routes';
export const CONGESTION_SOURCE = 'convoy-route-congestion';
export const LAYERS = {
  altCasing: 'route-alt-casing',
  alt: 'route-alt',
  selectedCasing: 'route-selected-casing',
  selected: 'route-selected',
  congestion: 'route-congestion',
};

const EMPTY = { type: 'FeatureCollection', features: [] };

const CASING_COLOR = '#0b1016';
/*
 * Violet, not grey. A neutral grey alternative is indistinguishable from the
 * Orbis basemap's own road casings (~#98a7b5) — the lines render, but nobody can
 * see them. Violet appears nowhere in the basemap palette, so alternatives read
 * as route options while staying subordinate to the brighter selected line.
 */
const ALT_COLOR = '#8b5cf6';
const SELECTED_COLOR = '#38bdf8';

/** Create the source and the four line layers once, after style load. */
export function ensureRouteLayers(map) {
  if (map.getSource(ROUTE_SOURCE)) return;

  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: EMPTY });

  // Width grows with zoom so the route stays prominent when zoomed out and
  // proportionate when zoomed in.
  const width = (base) => [
    'interpolate',
    ['linear'],
    ['zoom'],
    8,
    base * 0.6,
    12,
    base,
    16,
    base * 1.5,
  ];

  map.addLayer({
    id: LAYERS.altCasing,
    type: 'line',
    source: ROUTE_SOURCE,
    filter: ['==', ['get', 'index'], -1],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': CASING_COLOR, 'line-width': width(7), 'line-opacity': 0.55 },
  });

  map.addLayer({
    id: LAYERS.alt,
    type: 'line',
    source: ROUTE_SOURCE,
    filter: ['==', ['get', 'index'], -1],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ALT_COLOR,
      'line-width': width(3.5),
      'line-opacity': 0.9,
      'line-dasharray': [2, 1.2],
    },
  });

  map.addLayer({
    id: LAYERS.selectedCasing,
    type: 'line',
    source: ROUTE_SOURCE,
    filter: ['==', ['get', 'index'], -1],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': CASING_COLOR, 'line-width': width(11), 'line-opacity': 0.8 },
  });

  map.addLayer({
    id: LAYERS.selected,
    type: 'line',
    source: ROUTE_SOURCE,
    filter: ['==', ['get', 'index'], -1],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': SELECTED_COLOR, 'line-width': width(5.5) },
  });

  /*
   * Congestion along the selected route, drawn on top of it. The geometry comes
   * from the routing response's own traffic sections — no second vendor call —
   * so what is highlighted is congestion on the road the convoy would actually
   * take, rather than generic area-wide traffic.
   */
  map.addSource(CONGESTION_SOURCE, { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: LAYERS.congestion,
    type: 'line',
    source: CONGESTION_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': [
        'match',
        ['get', 'magnitude'],
        1,
        '#eab308',
        2,
        '#f97316',
        3,
        '#ef4444',
        4,
        '#b91c1c',
        '#f97316',
      ],
      'line-width': width(6.5),
      'line-opacity': 0.95,
    },
  });
}

/**
 * Build congestion segments for the selected route.
 *
 * TomTom returns traffic sections as index ranges into the route's flattened point
 * array, so each one is sliced out of the geometry we already hold.
 */
export function setCongestion(map, routeFeature) {
  const source = map.getSource(CONGESTION_SOURCE);
  if (!source) return 0;

  const coords = routeFeature?.geometry?.coordinates || [];
  const sections = routeFeature?.properties?.trafficSections || [];

  const features = [];
  for (const s of sections) {
    const from = Math.max(0, Number(s.startPointIndex) || 0);
    const to = Math.min(coords.length - 1, Number(s.endPointIndex) || 0);
    if (!(to > from)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords.slice(from, to + 1) },
      properties: {
        magnitude: s.magnitude ?? 0,
        delaySeconds: s.delaySeconds ?? null,
        category: s.category || 'TRAFFIC',
      },
    });
  }

  source.setData({ type: 'FeatureCollection', features });
  return features.length;
}

/** Push new route geometry into the source. */
export function setRouteData(map, featureCollection) {
  const source = map.getSource(ROUTE_SOURCE);
  if (source) source.setData(featureCollection || EMPTY);
}

/** Show `selectedIndex` as the primary line and everything else as an alternative. */
export function setSelectedRoute(map, selectedIndex) {
  if (!map.getLayer(LAYERS.selected)) return;
  const isSelected = ['==', ['get', 'index'], selectedIndex];
  const isOther = ['!=', ['get', 'index'], selectedIndex];
  map.setFilter(LAYERS.altCasing, isOther);
  map.setFilter(LAYERS.alt, isOther);
  map.setFilter(LAYERS.selectedCasing, isSelected);
  map.setFilter(LAYERS.selected, isSelected);
}

/** Clicking an alternative promotes it. Returns a cleanup function. */
export function bindAlternativeClicks(map, onSelect) {
  const clickable = [LAYERS.alt, LAYERS.altCasing];

  const onClick = (e) => {
    const index = e.features?.[0]?.properties?.index;
    if (index != null) onSelect(Number(index));
  };
  const onEnter = () => {
    map.getCanvas().style.cursor = 'pointer';
  };
  const onLeave = () => {
    map.getCanvas().style.cursor = '';
  };

  for (const layer of clickable) {
    map.on('click', layer, onClick);
    map.on('mouseenter', layer, onEnter);
    map.on('mouseleave', layer, onLeave);
  }

  return () => {
    for (const layer of clickable) {
      map.off('click', layer, onClick);
      map.off('mouseenter', layer, onEnter);
      map.off('mouseleave', layer, onLeave);
    }
  };
}

/** A labelled pin for the start or destination. */
export function createEndpointMarker({ color, title }) {
  const el = document.createElement('div');
  el.className = 'endpoint-marker';
  el.style.setProperty('--marker-color', color);
  el.title = title;
  return new maplibregl.Marker({ element: el, anchor: 'bottom' });
}

/**
 * Frame the whole route, leaving room for the panel and controls.
 *
 * Pitch-aware on purpose. `cameraForBounds` solves for a top-down camera, so
 * applying pitch afterwards drops the far end of the route out of frame — badly
 * on a phone, where the camera can end up at street level. Pulling the zoom back
 * when pitched keeps the route framed in both 2D and 3D.
 */
export function fitToRoute(map, featureCollection, { padding, pitch, bearing, duration = 700 } = {}) {
  const features = featureCollection?.features || [];
  if (!features.length) return;

  const bounds = new maplibregl.LngLatBounds();
  for (const f of features) {
    for (const c of f.geometry.coordinates) bounds.extend(c);
  }
  if (bounds.isEmpty()) return;

  const targetPitch = pitch ?? map.getPitch();
  const camera = map.cameraForBounds(bounds, {
    padding: padding ?? { top: 60, bottom: 60, left: 60, right: 60 },
    maxZoom: 15,
  });
  if (!camera) return;

  map.easeTo({
    center: camera.center,
    zoom: targetPitch > 30 ? Math.max(0, camera.zoom - 1.15) : camera.zoom,
    pitch: targetPitch,
    bearing: bearing ?? map.getBearing(),
    duration,
  });
}
