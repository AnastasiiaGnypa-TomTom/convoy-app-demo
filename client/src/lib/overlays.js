/**
 * Overlay layers: Vantor imagery, TomTom traffic flow, traffic incidents.
 *
 * ── Layer order is the whole design ───────────────────────────────────────
 * The demo has to make TomTom's contribution visible ON TOP of Vantor's imagery,
 * so the stack from bottom to top is:
 *
 *   Orbis basemap fills (land, water, landuse)
 *   Vantor imagery            ← inserted above fills, BELOW roads and labels
 *   Orbis roads + labels      ← stays legible over the imagery
 *   TomTom traffic flow
 *   Route alternatives, then the selected route
 *   Congestion along the route
 *   Traffic incidents         ← topmost, clickable
 *
 * Putting imagery above the fills but below the roads is what makes it read as a
 * backdrop rather than a blanket that hides the routing.
 */

/*
 * One source + layer per imagery mode (seamless / latest). Both are added once
 * and only one is ever visible, so switching mid-demo is instant and the hidden
 * layer costs no tile requests — MapLibre does not fetch tiles for a layer with
 * visibility 'none'.
 */
export const imagerySourceId = (modeId) => `vantor-imagery-${modeId}`;
export const imageryLayerId = (modeId) => `vantor-imagery-${modeId}-layer`;
export const TRAFFIC_SOURCE = 'tomtom-traffic-flow';
export const TRAFFIC_LAYER = 'tomtom-traffic-flow-layer';
export const INCIDENT_SOURCE = 'tomtom-incidents';
export const INCIDENT_LAYERS = {
  line: 'incident-line',
  point: 'incident-point',
  icon: 'incident-icon',
};

const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * First road/label layer in the basemap. Imagery is inserted before it so TomTom's
 * network draws on top. Falls back to undefined (= append on top) if the style has
 * no such layer, which would only happen with the raster fallback basemap.
 */
function firstRoadOrLabelLayer(map) {
  for (const layer of map.getStyle().layers || []) {
    if (layer.type === 'line' || layer.type === 'symbol') return layer.id;
  }
  return undefined;
}

/** Resolve a relative tile URL against the current origin. */
function absolutise(source) {
  return {
    ...source,
    tiles: source.tiles.map((t) => (t.startsWith('http') ? t : `${window.location.origin}${t}`)),
  };
}

/* ------------------------------------------------------------------ imagery */

/**
 * Basemap fill layers that end up ABOVE the imagery.
 *
 * Imagery is inserted before the first road line so TomTom's network stays on top,
 * but the Orbis style also draws some fills after that point — water and landuse
 * in particular. Left visible they paint flat vector colour over the satellite
 * view (bright cyan canals over real water), which looks like a rendering fault.
 * These get hidden while imagery is on and restored when it is off.
 */
function fillsAboveImagery(map, referenceLayerId) {
  const layers = map.getStyle().layers || [];
  const imageryIndex = layers.findIndex((l) => l.id === referenceLayerId);
  if (imageryIndex === -1) return [];
  return layers
    .slice(imageryIndex + 1)
    .filter((l) => (l.type === 'fill' || l.type === 'fill-extrusion') && l.id !== 'background')
    .map((l) => l.id);
}

let hiddenFills = [];
let knownModes = [];

/**
 * Add one hidden raster layer per imagery mode.
 * @param {Array<{id: string, source: object}>} modes from /api/imagery/meta
 */
export function ensureImageryLayers(map, modes) {
  knownModes = modes.map((m) => m.id);

  for (const mode of modes) {
    const layerId = imageryLayerId(mode.id);
    const sourceId = imagerySourceId(mode.id);
    if (map.getLayer(layerId)) continue;
    if (!map.getSource(sourceId)) map.addSource(sourceId, absolutise(mode.source));

    map.addLayer(
      {
        id: layerId,
        type: 'raster',
        source: sourceId,
        layout: { visibility: 'none' },
        paint: {
          'raster-opacity': 0.92,
          // A touch of contrast keeps satellite detail readable once TomTom's roads
          // and labels are drawn over the top.
          'raster-contrast': 0.06,
          'raster-fade-duration': 250,
        },
      },
      firstRoadOrLabelLayer(map),
    );
  }

  // All imagery layers insert at the same point, so any one is a valid reference.
  if (knownModes.length) hiddenFills = fillsAboveImagery(map, imageryLayerId(knownModes[0]));
}

/* ------------------------------------------------------------------ traffic */

export function ensureTrafficLayer(map, sourceDef, beforeId) {
  if (map.getLayer(TRAFFIC_LAYER)) return;
  if (!map.getSource(TRAFFIC_SOURCE)) {
    map.addSource(TRAFFIC_SOURCE, absolutise(sourceDef));
  }
  map.addLayer(
    {
      id: TRAFFIC_LAYER,
      type: 'raster',
      source: TRAFFIC_SOURCE,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 200 },
    },
    map.getLayer(beforeId) ? beforeId : undefined,
  );
}

/* ---------------------------------------------------------------- incidents */

/** TomTom magnitudeOfDelay: 0 unknown, 1 minor, 2 moderate, 3 major, 4 closure. */
const DELAY_COLOR = [
  'match',
  ['get', 'magnitudeOfDelay'],
  1,
  '#eab308',
  2,
  '#f97316',
  3,
  '#ef4444',
  4,
  '#b91c1c',
  '#94a3b8',
];

export function ensureIncidentLayers(map) {
  if (map.getLayer(INCIDENT_LAYERS.point)) return;
  if (!map.getSource(INCIDENT_SOURCE)) {
    map.addSource(INCIDENT_SOURCE, { type: 'geojson', data: EMPTY });
  }

  // Jams and closures arrive as LineStrings; everything else as points.
  map.addLayer({
    id: INCIDENT_LAYERS.line,
    type: 'line',
    source: INCIDENT_SOURCE,
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { visibility: 'none', 'line-cap': 'round' },
    paint: {
      'line-color': DELAY_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 14, 5],
      'line-opacity': 0.95,
    },
  });

  map.addLayer({
    id: INCIDENT_LAYERS.point,
    type: 'circle',
    source: INCIDENT_SOURCE,
    filter: ['==', ['geometry-type'], 'Point'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 6.5],
      'circle-color': DELAY_COLOR,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#0b1016',
    },
  });
}

export function setIncidentData(map, featureCollection) {
  const source = map.getSource(INCIDENT_SOURCE);
  if (source) source.setData(featureCollection || EMPTY);
}

/* ------------------------------------------------------------- visibility  */

export function setLayerVisible(map, layerId, visible) {
  if (map.getLayer(layerId)) {
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
}

/**
 * Show exactly one imagery mode, or none.
 *
 * `activeModeId` is the EFFECTIVE mode, not necessarily the requested one — in
 * seamless mode with no mosaic coverage the server reports a fallback to latest,
 * and rendering must follow that so the overlay is never blank.
 */
export function setImageryMode(map, activeModeId, visible) {
  // If the mode has not resolved yet, show the first known one rather than
  // nothing — otherwise toggling imagery on early would appear to do nothing.
  const active = knownModes.includes(activeModeId) ? activeModeId : knownModes[0];
  for (const id of knownModes) {
    setLayerVisible(map, imageryLayerId(id), visible && id === active);
  }
  // Vector fills above the imagery would otherwise cover it with flat colour.
  for (const id of hiddenFills) setLayerVisible(map, id, !visible);
}

export function setTrafficVisible(map, visible) {
  setLayerVisible(map, TRAFFIC_LAYER, visible);
  for (const id of Object.values(INCIDENT_LAYERS)) setLayerVisible(map, id, visible);
}
