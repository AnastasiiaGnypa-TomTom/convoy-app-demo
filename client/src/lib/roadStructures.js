/**
 * Bridges and tunnels, from TomTom's ROAD data rather than POIs.
 *
 * ── Why the source changed ────────────────────────────────────────────────
 * These were previously sourced from the TomTom POI categories Bridge/Tunnel/Dam,
 * which sit under IMPORTANT_TOURIST_ATTRACTION. That only ever returns notable
 * landmarks — four features over a whole city — because a POI database catalogues
 * places people visit, not every structure a convoy has to cross.
 *
 * The Orbis vector tiles carry it properly. Verified in the style's own filters:
 *
 *   source-layer "roads",   ["==", ["get","bridge"], true]
 *   source-layer "roads",   ["==", ["get","tunnel"], true]
 *   source-layer "transit", ["==", ["get","tunnel"], true]   (rail tunnels)
 *
 * So every road bridge and tunnel is already in the tiles the basemap loads; it just
 * was not being drawn as its own layer. This renders them as LINE features on the
 * roads, which also means:
 *   - no extra network requests at all — same tiles, extra layers;
 *   - viewport scoping is automatic, because vector tiles only load for the view.
 * It stays entirely TomTom-sourced, so no OSM fallback is needed.
 *
 * ── Colour choice ─────────────────────────────────────────────────────────
 * Constrained by what is already on screen: the alternative routes are violet
 * (#8b5cf6) and the selected route is sky blue (#38bdf8), so violet and cyan are
 * both unusable here — at line width, a violet bridge is indistinguishable from an
 * alternative route. Pink (bridges, solid) and lime (tunnels, dashed) appear nowhere
 * in the Orbis palette or the route layers. Dash vs solid carries the same
 * distinction independently of hue, so it survives colour-blindness too.
 */
const BRIDGE_COLOR = '#ec4899';
const TUNNEL_COLOR = '#a3e635';

/*
 * Zoom floor, and the one real coverage gap.
 *
 * TomTom strips these attributes from the tiles below z12. Measured, not assumed: at
 * z11 the loaded tiles held 29,220 road features and NOT ONE carried a `bridge` key
 * at all, while the same view at z12 held 918 bridges and 192 tunnels. So this is a
 * property of the vendor's tile generalisation — no filter or source setting can
 * recover it.
 *
 * Declared as an explicit minzoom so the behaviour is intentional rather than
 * accidental: nothing is silently missing, the layer simply has a floor, and no work
 * is done below it. z12 is roughly city-district scale, which is also the point below
 * which an individual bridge would be sub-pixel anyway.
 */
export const STRUCTURE_MINZOOM = 12;

const BASEMAP_SOURCE = 'vectorTiles';

export const STRUCTURE_LAYERS = {
  bridgeCasing: 'struct-bridge-casing',
  bridge: 'struct-bridge',
  tunnel: 'struct-tunnel',
  railTunnel: 'struct-rail-tunnel',
  routeStructures: 'struct-on-route',
};

const ROUTE_STRUCT_SOURCE = 'struct-on-route-src';
const EMPTY = { type: 'FeatureCollection', features: [] };

/** Does this style expose the road attributes we need? */
export function hasRoadStructureData(map) {
  try {
    return Boolean(map?.getSource?.(BASEMAP_SOURCE));
  } catch {
    return false;
  }
}

/**
 * Add the bridge and tunnel layers.
 *
 * Bridges read as solid raised decks with a dark casing; tunnels as dashed, since a
 * tunnel is road you cannot see. Inserted above the basemap roads but below labels
 * and below the route, so guidance always wins.
 */
export function ensureStructureLayers(map) {
  if (!hasRoadStructureData(map) || map.getLayer(STRUCTURE_LAYERS.bridge)) return false;

  // Put these under the first symbol layer so labels stay on top.
  let beforeId;
  for (const l of map.getStyle().layers || []) {
    if (l.type === 'symbol') {
      beforeId = l.id;
      break;
    }
  }

  const width = (base) => [
    'interpolate',
    ['linear'],
    ['zoom'],
    10,
    base * 0.5,
    13,
    base * 0.8,
    16,
    base,
    18,
    base * 1.4,
  ];

  map.addLayer(
    {
      id: STRUCTURE_LAYERS.bridgeCasing,
      type: 'line',
      source: BASEMAP_SOURCE,
      'source-layer': 'roads',
      minzoom: STRUCTURE_MINZOOM,
      filter: ['==', ['get', 'bridge'], true],
      layout: { visibility: 'none', 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': '#0b1016', 'line-width': width(9), 'line-opacity': 0.7 },
    },
    beforeId,
  );

  map.addLayer(
    {
      id: STRUCTURE_LAYERS.bridge,
      type: 'line',
      source: BASEMAP_SOURCE,
      'source-layer': 'roads',
      minzoom: STRUCTURE_MINZOOM,
      filter: ['==', ['get', 'bridge'], true],
      layout: { visibility: 'none', 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': BRIDGE_COLOR, 'line-width': width(4.5), 'line-opacity': 0.95 },
    },
    beforeId,
  );

  map.addLayer(
    {
      id: STRUCTURE_LAYERS.tunnel,
      type: 'line',
      source: BASEMAP_SOURCE,
      'source-layer': 'roads',
      minzoom: STRUCTURE_MINZOOM,
      filter: ['==', ['get', 'tunnel'], true],
      layout: { visibility: 'none', 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': TUNNEL_COLOR,
        'line-width': width(4),
        'line-opacity': 0.9,
        // Dashed: a tunnel is road you cannot see.
        'line-dasharray': [1.6, 1.1],
      },
    },
    beforeId,
  );

  // Rail tunnels live on a different source-layer.
  map.addLayer(
    {
      id: STRUCTURE_LAYERS.railTunnel,
      type: 'line',
      source: BASEMAP_SOURCE,
      'source-layer': 'transit',
      minzoom: STRUCTURE_MINZOOM,
      filter: ['all', ['==', ['get', 'tunnel'], true], ['==', ['get', 'category'], 'railway']],
      layout: { visibility: 'none', 'line-cap': 'butt' },
      paint: {
        'line-color': TUNNEL_COLOR,
        'line-width': width(2.4),
        'line-opacity': 0.65,
        'line-dasharray': [2, 2],
      },
    },
    beforeId,
  );

  // Structures ON the route, drawn last so they sit above everything.
  if (!map.getSource(ROUTE_STRUCT_SOURCE)) {
    map.addSource(ROUTE_STRUCT_SOURCE, { type: 'geojson', data: EMPTY });
  }
  map.addLayer({
    id: STRUCTURE_LAYERS.routeStructures,
    type: 'circle',
    source: ROUTE_STRUCT_SOURCE,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 8],
      'circle-color': ['match', ['get', 'kind'], 'tunnel', TUNNEL_COLOR, BRIDGE_COLOR],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#0b1016',
    },
  });

  return true;
}

export function setStructuresVisible(map, visible) {
  for (const id of Object.values(STRUCTURE_LAYERS)) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}

export function setRouteStructures(map, fc) {
  map.getSource(ROUTE_STRUCT_SOURCE)?.setData(fc || EMPTY);
}

/**
 * Find bridges and tunnels ON the active route.
 *
 * Works by projecting sampled route points to screen and asking MapLibre what road
 * features are rendered there. Consecutive hits are merged into one structure, so a
 * 400 m bridge is reported once rather than as eight samples.
 *
 * HONEST LIMITATION: queryRenderedFeatures only sees what is currently rendered, so
 * this finds structures on the visible portion of the route. Panning along the route
 * reveals the rest. Detecting the whole route regardless of viewport would need the
 * geometry server-side, and TomTom routing cannot supply it — `sectionType=bridge` is
 * rejected outright (400 "Invalid section type value") and `sectionType=tunnel`
 * returned no sections on test corridors.
 */
export function findRouteStructures(map, coordinates, cum, { sampleEveryM = 60 } = {}) {
  if (!map || !coordinates?.length || !cum?.length) return [];

  const total = cum[cum.length - 1] || 0;
  if (total <= 0) return [];
  const steps = Math.min(600, Math.max(2, Math.round(total / sampleEveryM)));

  const hits = [];
  for (let i = 0; i < steps; i++) {
    const d = (total * i) / (steps - 1);
    let seg = 1;
    while (seg < cum.length - 1 && cum[seg] < d) seg++;
    const t = (d - cum[seg - 1]) / (cum[seg] - cum[seg - 1] || 1);
    const [x1, y1] = coordinates[seg - 1];
    const [x2, y2] = coordinates[seg];
    const lngLat = [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];

    let pt;
    try {
      pt = map.project(lngLat);
    } catch {
      continue;
    }
    // Off-screen points cannot be queried; skip rather than guess.
    const c = map.getCanvas();
    if (pt.x < 0 || pt.y < 0 || pt.x > c.clientWidth || pt.y > c.clientHeight) continue;

    let feats = [];
    try {
      feats = map.queryRenderedFeatures(
        [
          [pt.x - 6, pt.y - 6],
          [pt.x + 6, pt.y + 6],
        ],
        { layers: [STRUCTURE_LAYERS.bridge, STRUCTURE_LAYERS.tunnel].filter((l) => map.getLayer(l)) },
      );
    } catch {
      continue;
    }
    if (!feats.length) continue;

    const isTunnel = feats.some((f) => f.layer.id === STRUCTURE_LAYERS.tunnel);
    hits.push({
      distance: d,
      coord: lngLat,
      kind: isTunnel ? 'tunnel' : 'bridge',
      name: feats[0].properties?.name || feats[0].properties?.road_number || null,
    });
  }

  // Merge consecutive samples of the same kind into one structure.
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && last.kind === h.kind && h.distance - last.endDistance < sampleEveryM * 2.5) {
      last.endDistance = h.distance;
      last.lengthM = last.endDistance - last.startDistance;
      if (!last.name && h.name) last.name = h.name;
      continue;
    }
    merged.push({
      kind: h.kind,
      name: h.name,
      startDistance: h.distance,
      endDistance: h.distance,
      lengthM: 0,
      coord: h.coord,
    });
  }
  return merged;
}

export function routeStructuresToGeoJSON(structures) {
  return {
    type: 'FeatureCollection',
    features: (structures || []).map((s, i) => ({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: s.coord },
      properties: {
        kind: s.kind,
        name: s.name || (s.kind === 'tunnel' ? 'Tunnel' : 'Bridge'),
        lengthM: Math.round(s.lengthM),
      },
    })),
  };
}
