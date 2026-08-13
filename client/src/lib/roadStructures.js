import maplibregl from 'maplibre-gl';
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

/**
 * Below this zoom, only structures that matter at a glance are drawn.
 *
 * Showing every bridge from z12 up was right for the Alps and wrong for a canal city:
 * one Utrecht view holds several hundred short bridges and the map became a pink rash.
 * A motorway tunnel and a 15 m footbridge are both "a structure", so zoom alone cannot
 * separate them — size and road class can.
 */
export const ALL_STRUCTURES_ZOOM = 13.5;

/** True for structures worth drawing at a wide view. */
const IS_MAJOR = [
  'any',
  ['match', ['get', 'category'], ['motorway', 'trunk', 'primary'], true, false],
  ['>=', ['coalesce', ['get', 'length_m'], 0], 200],
];

/**
 * Opacity that fades minor structures in only once close enough.
 *
 * Done with opacity rather than a filter so there is one layer per kind instead of two,
 * and so the appearance is a fade rather than a pop as you cross the threshold.
 */
const significanceOpacity = (full) => [
  'interpolate',
  ['linear'],
  ['zoom'],
  STRUCTURE_MINZOOM,
  ['case', IS_MAJOR, full, 0],
  ALL_STRUCTURES_ZOOM,
  full,
];

const BASEMAP_SOURCE = 'vectorTiles';

export const STRUCTURE_LAYERS = {
  bridgeGlow: 'struct-bridge-glow',
  tunnelGlow: 'struct-tunnel-glow',
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

  /*
   * Weighted for the LOW end of the range, not the high end.
   *
   * The previous ramp gave 0.8x width at z13, which meant that at the very zoom where
   * these first become available they were hairlines over a busy basemap — visible only
   * if you already knew where to look. Since z12 is a hard floor (see STRUCTURE_MINZOOM)
   * the first two levels are the ones that matter most, so the ramp now starts ABOVE 1x
   * and eases down as the roads themselves get wider and carry the shape anyway.
   */
  const width = (base) => [
    'interpolate',
    ['linear'],
    ['zoom'],
    12,
    base * 1.5,
    14,
    base * 1.25,
    16,
    base,
    18,
    base * 1.4,
  ];

  /*
   * A soft glow under each line. At z12-13 a 5px line competes with road casings of a
   * similar weight; the glow gives it a halo so it separates from the basemap without
   * having to make the line itself fat enough to obscure the road it sits on.
   */
  const glow = (base, color) => ({
    'line-color': color,
    /*
     * Kept deliberately tight. A 2.6x halo was tried and reverted: in a canal city like
     * Utrecht there are several hundred short bridges in one z12 view, and a wide blurred
     * halo around each merges them into pink fuzz rather than reading as crossings. The
     * line itself carries the visibility; the halo only has to separate it from the road
     * casing underneath.
     */
    'line-width': width(base * 1.9),
    'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, ['case', IS_MAJOR, 0.3, 0], 13.5, 0.3, 15, 0.16],
    'line-blur': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 2],
  });

  map.addLayer(
    {
      id: STRUCTURE_LAYERS.bridgeGlow,
      type: 'line',
      source: BASEMAP_SOURCE,
      'source-layer': 'roads',
      minzoom: STRUCTURE_MINZOOM,
      filter: ['==', ['get', 'bridge'], true],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: glow(4.5, BRIDGE_COLOR),
    },
    beforeId,
  );

  map.addLayer(
    {
      id: STRUCTURE_LAYERS.tunnelGlow,
      type: 'line',
      source: BASEMAP_SOURCE,
      'source-layer': 'roads',
      minzoom: STRUCTURE_MINZOOM,
      filter: ['==', ['get', 'tunnel'], true],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: glow(4, TUNNEL_COLOR),
    },
    beforeId,
  );

  map.addLayer(
    {
      id: STRUCTURE_LAYERS.bridgeCasing,
      type: 'line',
      source: BASEMAP_SOURCE,
      'source-layer': 'roads',
      minzoom: STRUCTURE_MINZOOM,
      filter: ['==', ['get', 'bridge'], true],
      layout: { visibility: 'none', 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': '#0b1016', 'line-width': width(9), 'line-opacity': significanceOpacity(0.7) },
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
      paint: { 'line-color': BRIDGE_COLOR, 'line-width': width(4.5), 'line-opacity': significanceOpacity(1) },
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
        'line-opacity': significanceOpacity(0.98),
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
export function findRouteStructures(map, coordinates, cum, { sampleEveryM = 25 } = {}) {
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
      /*
       * A TIGHT box, and the NEAREST feature wins.
       *
       * This was ±6px with "tunnel if any feature in the box is a tunnel", which at z13
       * is a ~50 m window in a dense city centre — so it picked up parallel and crossing
       * roads and reported them as structures on the route. Central Rotterdam came back
       * with a dozen spurious tunnels named after adjacent streets.
       *
       * Now the box is small and the kind is taken from the single closest feature rather
       * than from an any-match, so a tunnel beside the route no longer makes the route
       * look like a tunnel.
       */
      feats = map.queryRenderedFeatures(
        [
          [pt.x - 3, pt.y - 3],
          [pt.x + 3, pt.y + 3],
        ],
        { layers: [STRUCTURE_LAYERS.bridge, STRUCTURE_LAYERS.tunnel].filter((l) => map.getLayer(l)) },
      );
    } catch {
      continue;
    }
    if (!feats.length) continue;

    /*
     * Closest feature by distance to its nearest SEGMENT, not its nearest vertex.
     *
     * Vertex distance was tried and is wrong: a long straight span like the Erasmusbrug
     * is encoded with vertices only where it bends, so a sample in the middle of the deck
     * can be 300 m from any vertex while sitting exactly on the line. Those samples were
     * rejected by the 25 m test, which punched gaps into the run and fragmented one bridge
     * into five entries. Point-to-segment distance is the predicate that actually answers
     * "is this road under my sample".
     */
    const mPerDegLon = Math.cos((lngLat[1] * Math.PI) / 180) * 111320;
    const toLocal = (c) => [(c[0] - lngLat[0]) * mPerDegLon, (c[1] - lngLat[1]) * 110540];

    let best = null;
    let bestD = Infinity;
    for (const f of feats) {
      const g = f.geometry;
      const parts = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates || []];
      for (const part of parts) {
        for (let k = 1; k < part.length; k++) {
          const [ax, ay] = toLocal(part[k - 1]);
          const [bx, by] = toLocal(part[k]);
          const vx = bx - ax;
          const vy = by - ay;
          const len2 = vx * vx + vy * vy;
          // Project the sample (which is the local origin) onto the segment.
          const tt = len2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0;
          const px = ax + vx * tt;
          const py = ay + vy * tt;
          const sq = px * px + py * py;
          if (sq < bestD) {
            bestD = sq;
            best = f;
          }
        }
        // Degenerate single-point part: fall back to the point itself.
        if (part.length === 1) {
          const [ax, ay] = toLocal(part[0]);
          const sq = ax * ax + ay * ay;
          if (sq < bestD) {
            bestD = sq;
            best = f;
          }
        }
      }
    }
    if (!best) continue;
    // Beyond ~25 m it is a different road, not the one we are driving.
    if (Math.sqrt(bestD) > 25) continue;

    hits.push({
      distance: d,
      coord: lngLat,
      kind: best.layer.id === STRUCTURE_LAYERS.tunnel ? 'tunnel' : 'bridge',
      name: best.properties?.name || best.properties?.road_number || null,
    });
  }

  /*
   * Merge consecutive samples into one structure — but only when they are plausibly the
   * SAME structure.
   *
   * The first version merged on kind alone within 2.5 sample steps, which conflated
   * genuinely separate structures: two bridges 100 m apart became one entry whose
   * reported length spanned both, which is how a 796 m "tunnel" appeared in the list.
   * Requiring the name to match as well keeps distinct crossings distinct.
   *
   * Length is the extent of the samples that hit, so its resolution is the sample step.
   * The caller reports it as approximate rather than implying survey precision.
   */
  const merged = [];
  const norm = (n) => (n || '').toLowerCase();
  for (const h of hits) {
    const last = merged[merged.length - 1];
    const sameRun =
      last &&
      last.kind === h.kind &&
      norm(last.name) === norm(h.name) &&
      h.distance - last.endDistance <= sampleEveryM * 2;
    if (sameRun) {
      last.endDistance = h.distance;
      last.lengthM = last.endDistance - last.startDistance;
      continue;
    }
    merged.push({
      kind: h.kind,
      name: h.name,
      startDistance: h.distance,
      endDistance: h.distance,
      lengthM: 0,
      coord: h.coord,
      // So the UI can say "about", and can omit a length it cannot actually resolve.
      resolutionM: sampleEveryM,
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

/* ────────────────────────── click to inspect a structure ─────────────────── */

const R_EARTH = 6371000;
function metresBetween([lo1, la1], [lo2, la2]) {
  const dLa = ((la2 - la1) * Math.PI) / 180;
  const dLo = ((lo2 - lo1) * Math.PI) / 180;
  const m1 = (la1 * Math.PI) / 180;
  const m2 = (la2 * Math.PI) / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(m1) * Math.cos(m2) * Math.sin(dLo / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

function geometryLength(geometry) {
  const parts =
    geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates || []];
  let total = 0;
  for (const part of parts) {
    for (let i = 1; i < part.length; i++) total += metresBetween(part[i - 1], part[i]);
  }
  return total;
}

/** Human labels for the road classes TomTom uses. */
const ROAD_CLASS = {
  motorway: 'Motorway',
  trunk: 'Trunk road',
  primary: 'Primary road',
  secondary: 'Secondary road',
  tertiary: 'Minor road',
  street: 'Street',
  service: 'Service road',
  track: 'Track',
  path: 'Path',
  pedestrian: 'Pedestrian way',
  bus: 'Bus road',
  railway: 'Railway',
};

/**
 * Everything we can honestly say about one structure.
 *
 * ── What is NOT here, and why ─────────────────────────────────────────────
 * There is no clearance, weight limit, width or axle rating. Not omitted for brevity —
 * those fields do not exist. Every property present on bridge/tunnel features was
 * dumped across five cities and the complete set is: bridge, tunnel, name, name_en,
 * category, subcategory, display_class, z_level, route_number/route_shield_*, toll,
 * covered, service, access, unpaved, under_construction, grade. Nothing dimensional.
 *
 * So this reports what the map actually knows, and says plainly that limits are not in
 * the data rather than inventing a number a convoy planner might act on.
 *
 * Length IS real: computed from the feature geometry. Vector tiles clip features at
 * tile edges, so a long span arrives in pieces; pieces of the same named road are summed
 * to get the whole structure, and the result is reported as approximate because tile
 * buffers overlap very slightly.
 */
export function describeStructure(map, feature) {
  const p = feature.properties || {};
  const kind = p.tunnel === true ? 'tunnel' : 'bridge';
  const name = p.name || p.name_en || null;

  // Sum every loaded piece of the same named structure, not just the clicked fragment.
  let lengthM = geometryLength(feature.geometry);
  let pieces = 1;
  if (name) {
    try {
      const all = map
        .querySourceFeatures(BASEMAP_SOURCE, { sourceLayer: feature.sourceLayer || 'roads' })
        .filter(
          (f) =>
            (f.properties?.name || f.properties?.name_en) === name &&
            (kind === 'tunnel' ? f.properties?.tunnel === true : f.properties?.bridge === true),
        );
      if (all.length) {
        lengthM = all.reduce((sum, f) => sum + geometryLength(f.geometry), 0);
        pieces = all.length;
      }
    } catch {
      /* fall back to the clicked fragment */
    }
  }

  const routeNumber = p.route_number || p.route_shield_text || p.route_shield_text_1 || null;

  return {
    kind,
    name,
    routeNumber,
    roadClass: ROAD_CLASS[p.category] || p.category || null,
    subcategory: p.subcategory || null,
    lengthM,
    pieces,
    // z_level is how many levels this sits above (or below) the surrounding ground.
    level: typeof p.z_level === 'number' ? p.z_level : null,
    toll: p.toll === true,
    covered: p.covered === true,
    unpaved: p.unpaved === true,
    underConstruction: p.under_construction === true,
    access: p.access || null,
  };
}

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

export function structurePopupHTML(info, { profileLabel = null, onRoute = false } = {}) {
  const title = info.name || (info.kind === 'tunnel' ? 'Tunnel' : 'Bridge');
  const rows = [];

  if (info.roadClass) {
    rows.push(['Road', info.routeNumber ? `${info.roadClass} · ${info.routeNumber}` : info.roadClass]);
  } else if (info.routeNumber) {
    rows.push(['Road', info.routeNumber]);
  }
  if (info.lengthM >= 20) {
    const len =
      info.lengthM >= 1000
        ? `${(info.lengthM / 1000).toFixed(1)} km`
        : `${Math.round(info.lengthM / 10) * 10} m`;
    rows.push(['Length', `~${len}`]);
  }
  if (info.level) {
    rows.push(['Level', info.level > 0 ? `${info.level} above ground` : `${-info.level} below ground`]);
  }
  const flags = [
    info.toll && 'Toll',
    info.covered && 'Covered',
    info.unpaved && 'Unpaved',
    info.underConstruction && 'Under construction',
  ].filter(Boolean);
  if (flags.length) rows.push(['Notes', flags.join(' · ')]);

  /*
   * The clearance line is the point of this popup for a convoy planner, so it is stated
   * rather than left as an absence. When the structure is on the active route we can say
   * something genuinely useful: the route was calculated WITH the vehicle's height and
   * weight, so TomTom's routing engine already rejected anything the vehicle cannot pass.
   * That is a real guarantee. Off-route we can only say the data does not carry limits.
   */
  const clearance = onRoute
    ? `<p class="struct-note struct-note-ok">Checked for <strong>${esc(profileLabel || 'your vehicle')}</strong> — TomTom routed with your height and weight, so this is passable.</p>`
    : `<p class="struct-note">No clearance or weight limit in the map data. Plan a route with your vehicle profile to have it checked.</p>`;

  return `
    <div class="struct-popup struct-popup-${info.kind}">
      <div class="struct-head">
        <span class="struct-badge">${info.kind === 'tunnel' ? 'TUNNEL' : 'BRIDGE'}</span>
        <strong>${esc(title)}</strong>
      </div>
      ${rows.length ? `<dl class="struct-rows">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      ${clearance}
    </div>`;
}

/**
 * Click a bridge or tunnel to inspect it.
 *
 * Bound to the two line layers only. A POI symbol sitting on top of a bridge wins —
 * the place card is the more specific intent, and two panels opening from one click is
 * worse than either. `onRouteAt` lets the caller say whether this point is on the active
 * route, which changes the clearance line from "unknown" to "already checked".
 */
export function bindStructureClicks(map, { onRouteAt = null, profileLabel = null } = {}) {
  let popup = null;
  const layers = [STRUCTURE_LAYERS.bridge, STRUCTURE_LAYERS.tunnel];

  const onClick = (e) => {
    const f = e.features?.[0];
    if (!f) return;

    // Defer to a POI if one is under the cursor.
    const poiLayers = ['infra-poi-icon', 'infra-poi-dot'].filter((l) => map.getLayer(l));
    if (poiLayers.length && map.queryRenderedFeatures(e.point, { layers: poiLayers }).length) return;

    const info = describeStructure(map, f);
    const onRoute = onRouteAt ? onRouteAt([e.lngLat.lng, e.lngLat.lat]) : false;
    popup?.remove();
    popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
      .setLngLat(e.lngLat)
      .setHTML(structurePopupHTML(info, { profileLabel, onRoute }))
      .addTo(map);
  };

  const enter = () => {
    map.getCanvas().style.cursor = 'pointer';
  };
  const leave = () => {
    map.getCanvas().style.cursor = '';
  };

  for (const l of layers) {
    if (!map.getLayer(l)) continue;
    map.on('click', l, onClick);
    map.on('mouseenter', l, enter);
    map.on('mouseleave', l, leave);
  }

  return () => {
    for (const l of layers) {
      if (!map.getLayer(l)) continue;
      map.off('click', l, onClick);
      map.off('mouseenter', l, enter);
      map.off('mouseleave', l, leave);
    }
    popup?.remove();
  };
}

/* ─────────── regional zoom: structures extracted server-side ─────────── */

const EXTRACTED_SOURCE = 'struct-extracted-src';
export const EXTRACTED_LAYERS = {
  glow: 'struct-x-glow',
  casing: 'struct-x-casing',
  bridge: 'struct-x-bridge',
  tunnel: 'struct-x-tunnel',
};

/** The zoom below which the server route refuses (too many source tiles). */
export const EXTRACTED_MIN_ZOOM = 10;

/**
 * Layers for the GeoJSON that /api/structures returns.
 *
 * Styled to match the native vector-tile layers exactly, and capped at maxzoom
 * STRUCTURE_MINZOOM so the two never draw at once: below z12 these are the only source,
 * at z12 and above the tiles carry the attributes and the free path takes over.
 */
export function ensureExtractedLayers(map) {
  if (map.getLayer(EXTRACTED_LAYERS.bridge)) return;
  if (!map.getSource(EXTRACTED_SOURCE)) {
    map.addSource(EXTRACTED_SOURCE, { type: 'geojson', data: EMPTY });
  }

  let beforeId;
  for (const l of map.getStyle().layers || []) {
    if (l.type === 'symbol') {
      beforeId = l.id;
      break;
    }
  }

  // At regional zoom lines must be a touch heavier to read at all.
  const w = (base) => ['interpolate', ['linear'], ['zoom'], 10, base * 1.5, 12, base * 1.6];
  const max = STRUCTURE_MINZOOM;

  const add = (id, paint, extra = {}) =>
    map.addLayer(
      {
        id,
        type: 'line',
        source: EXTRACTED_SOURCE,
        maxzoom: max,
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint,
        ...extra,
      },
      beforeId,
    );

  add(
    EXTRACTED_LAYERS.glow,
    {
      'line-color': ['match', ['get', 'kind'], 'tunnel', TUNNEL_COLOR, BRIDGE_COLOR],
      'line-width': w(8),
      'line-opacity': 0.32,
      'line-blur': 3,
    },
    { filter: IS_MAJOR },
  );
  add(
    EXTRACTED_LAYERS.casing,
    { 'line-color': '#0b1016', 'line-width': w(5.5), 'line-opacity': 0.65 },
    { filter: IS_MAJOR },
  );
  // Regional zoom shows only what reads at that scale — see ALL_STRUCTURES_ZOOM.
  add(
    EXTRACTED_LAYERS.bridge,
    { 'line-color': BRIDGE_COLOR, 'line-width': w(3), 'line-opacity': 1 },
    { filter: ['all', ['==', ['get', 'kind'], 'bridge'], IS_MAJOR] },
  );
  add(
    EXTRACTED_LAYERS.tunnel,
    {
      'line-color': TUNNEL_COLOR,
      'line-width': w(2.8),
      'line-opacity': 0.98,
      'line-dasharray': [1.6, 1.1],
    },
    { filter: ['all', ['==', ['get', 'kind'], 'tunnel'], IS_MAJOR] },
  );
}

export function setExtractedStructures(map, fc) {
  map.getSource(EXTRACTED_SOURCE)?.setData(fc || EMPTY);
}

export function setExtractedVisible(map, visible) {
  for (const id of Object.values(EXTRACTED_LAYERS)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/* ──────── structures along the active route, visible at ANY zoom ──────── */

const ROUTE_LINE_SOURCE = 'struct-route-src';
export const ROUTE_STRUCT_LAYERS = {
  glow: 'struct-r-glow',
  casing: 'struct-r-casing',
  bridge: 'struct-r-bridge',
  tunnel: 'struct-r-tunnel',
};

/**
 * Layers for /api/structures/along-route.
 *
 * Deliberately have NO maxzoom, unlike the viewport-extracted layers. A route corridor
 * costs tiles proportional to its length rather than to how far the camera is zoomed out,
 * so there is no reason to hide the tunnels on the road you are about to drive just
 * because you are looking at the whole country.
 *
 * They still respect the significance rule, so a wide view shows the motorway tunnels
 * rather than every farm-track culvert the route passes.
 */
export function ensureRouteStructureLayers(map) {
  if (map.getLayer(ROUTE_STRUCT_LAYERS.bridge)) return;
  if (!map.getSource(ROUTE_LINE_SOURCE)) {
    map.addSource(ROUTE_LINE_SOURCE, { type: 'geojson', data: EMPTY });
  }

  let beforeId;
  for (const l of map.getStyle().layers || []) {
    if (l.type === 'symbol') {
      beforeId = l.id;
      break;
    }
  }

  // Slightly heavier than the basemap versions: these are the ones that matter.
  const w = (base) => ['interpolate', ['linear'], ['zoom'], 8, base * 1.2, 11, base * 1.6, 15, base];

  const add = (id, paint, filter) =>
    map.addLayer(
      {
        id,
        type: 'line',
        source: ROUTE_LINE_SOURCE,
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint,
        ...(filter ? { filter } : {}),
      },
      beforeId,
    );

  add(ROUTE_STRUCT_LAYERS.glow, {
    'line-color': ['match', ['get', 'kind'], 'tunnel', TUNNEL_COLOR, BRIDGE_COLOR],
    'line-width': w(9),
    'line-opacity': significanceOpacity(0.3),
    'line-blur': 3,
  });
  add(ROUTE_STRUCT_LAYERS.casing, {
    'line-color': '#0b1016',
    'line-width': w(6),
    'line-opacity': significanceOpacity(0.6),
  });
  add(
    ROUTE_STRUCT_LAYERS.bridge,
    { 'line-color': BRIDGE_COLOR, 'line-width': w(3.4), 'line-opacity': significanceOpacity(1) },
    ['==', ['get', 'kind'], 'bridge'],
  );
  add(
    ROUTE_STRUCT_LAYERS.tunnel,
    {
      'line-color': TUNNEL_COLOR,
      'line-width': w(3.2),
      'line-opacity': significanceOpacity(1),
      'line-dasharray': [1.6, 1.1],
    },
    ['==', ['get', 'kind'], 'tunnel'],
  );
}

export function setRouteStructureLines(map, fc) {
  map.getSource(ROUTE_LINE_SOURCE)?.setData(fc || EMPTY);
}

export function setRouteStructureLinesVisible(map, visible) {
  for (const id of Object.values(ROUTE_STRUCT_LAYERS)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}
