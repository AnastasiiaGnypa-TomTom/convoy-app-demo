/**
 * POI layer allowlist — the single source of truth for what may appear in a layer.
 *
 * ── Why this is not what the spec literally asked for ─────────────────────
 * The spec said to browse categories via a `poiCategories` parameter carrying
 * UPPER_SNAKE_CASE codes. Verified against the live API on 2026-07-30, that
 * parameter DOES NOT EXIST and is silently ignored:
 *
 *   nearbySearch (no filter)                 → CAFE_PUB, SHOP, RESTAURANT
 *   nearbySearch &poiCategories=GAS_STATION  → CAFE_PUB, SHOP, RESTAURANT  (identical)
 *   nearbySearch &poiCategories=NONSENSE_XYZ → CAFE_PUB, SHOP, RESTAURANT  (identical)
 *   nearbySearch &categorySet=7311           → PETROL_STATION              (filters)
 *
 * Using `poiCategories` would therefore have put cafés and restaurants into every
 * defence layer — a worse version of the bug this rewrite exists to fix. Only the
 * numeric `categorySet` parameter filters, and it rejects code strings outright
 * ("'GAS_STATION' is not a valid integer").
 *
 * So the intent is honoured by three mechanisms instead of one:
 *   1. Codes below are the canonical allowlist, written by hand. Never derived
 *      from layer display names at runtime.
 *   2. A BUILD-TIME step (server/scripts/verify-poi-categories.js) resolves each
 *      code to the numeric id the API needs, and proves the resolution by reading
 *      the classification code back out of live results. Unresolvable codes are
 *      dropped and logged; they are never replaced by a text search.
 *   3. A RUNTIME assertion re-checks the classification code on every single
 *      result and drops anything outside the layer's allowlist. This is a stronger
 *      guarantee than a request parameter, because it validates what actually came
 *      back rather than what we asked for.
 *
 * Free-text `query` is used for exactly one thing: the user typing a place name in
 * the search box (/api/geocode). It is never used to populate a layer.
 */

/**
 * Layers with a real TomTom source.
 *
 * `codes` are TomTom classification codes as they appear in
 * result.poi.classifications[].code. `nameHints` exist only so the build-time
 * verifier can find the matching numeric category id — they are documentation for
 * the resolver, never used to query.
 */
export const POI_LAYERS = [
  {
    id: 'military',
    label: 'Military bases & installations',
    color: '#ef4444',
    glyph: '★',
    /*
     * ── An explicit, documented exception to the code-based assertion ──────
     *
     * TomTom's "Military Installation" category (9388) filters correctly — it
     * returns NATO Command and Control Centre of Excellence, Kromhout Kazerne,
     * Ramstein Air Base, Camp New Amsterdam, Camp Allen. But every one of its
     * results is classified `SCHOOL`: 212 of 212 across Utrecht, Ramstein and
     * Norfolk (verified 2026-07-30). That is a defect in TomTom's data.
     *
     * Allowlisting the code SCHOOL would let real schools into a military layer —
     * the exact false-positive class this rewrite removed. So this layer asserts on
     * the CATEGORY ID returned with each result instead: every result must carry
     * categorySet id 9388. Verified that results do carry it (20/20, no omissions),
     * which makes this a genuine check rather than a bypass — arguably stronger
     * than the code check, since the id is what actually did the filtering.
     *
     * Residual risk, stated plainly: if TomTom mis-files a non-military site into
     * category 9388, it will appear here. We cannot detect that from the data.
     */
    assertBy: 'categoryId',
    categoryIds: [9388],
    // Recorded for display only — this is what TomTom reports, not what we trust.
    codes: ['SCHOOL'],
    nameHints: { SCHOOL: ['Military Installation'] },
    caveat:
      'Category 9388. Includes recruiting offices, gates, admin buildings and base lodging alongside major installations, so it is military-related sites rather than a base list. TomTom mis-classifies every entry as SCHOOL, so this layer is validated on the category id instead.',
    lowerConfidence: true,
  },
  {
    id: 'fuel',
    label: 'Fuel stations',
    color: '#eab308',
    glyph: 'F',
    defaultOn: true,
    codes: ['PETROL_STATION'],
    // Spec said GAS_STATION; the API returns PETROL_STATION for category 7311.
    nameHints: { PETROL_STATION: ['Gas Station'] },
  },
  {
    id: 'medical',
    label: 'Hospitals & emergency services',
    color: '#f87171',
    glyph: '✚',
    defaultOn: true,
    codes: [
      'HOSPITAL_POLYCLINIC',
      'EMERGENCY_ROOM',
      'EMERGENCY_MEDICAL_SERVICE',
      'POLICE_STATION',
      'FIRE_STATION_BRIGADE',
    ],
    nameHints: {
      HOSPITAL_POLYCLINIC: ['Hospital'],
      EMERGENCY_ROOM: ['EmergencyRoom'],
      EMERGENCY_MEDICAL_SERVICE: ['Emergency Medical Service'],
      POLICE_STATION: ['Police Station'],
      FIRE_STATION_BRIGADE: ['Fire Station'],
    },
  },
  {
    id: 'government',
    label: 'Government & diplomatic',
    color: '#e879f9',
    glyph: 'G',
    codes: ['GOVERNMENT_OFFICE', 'EMBASSY'],
    nameHints: { GOVERNMENT_OFFICE: ['Government Office'], EMBASSY: ['Embassy'] },
  },
  {
    id: 'airfields',
    label: 'Airfields & aviation',
    color: '#38bdf8',
    glyph: '✈',
    /*
     * MILITARY_AIRPORT / AIRFIELD / PUBLIC_AIRPORT are not distinct classification
     * codes — those category ids all report AIRPORT. They are still queried via
     * extraIds (so military airfields and small strips are included), and every
     * result must still classify as AIRPORT to be accepted.
     */
    codes: ['AIRPORT', 'HELIPAD_HELICOPTER_LANDING'],
    nameHints: { AIRPORT: ['Airport'], HELIPAD_HELICOPTER_LANDING: ['Helipad'] },
    extraIds: [7383004, 7383005, 7383002, 7383003],
  },
  {
    id: 'maritime',
    label: 'Ports & maritime',
    color: '#0ea5e9',
    glyph: '⚓',
    codes: ['PORT_WAREHOUSE_FACILITY', 'FERRY_TERMINAL'],
    nameHints: {
      PORT_WAREHOUSE_FACILITY: ['Port/Warehouse Facility'],
      FERRY_TERMINAL: ['Ferry Terminal'],
    },
  },
  {
    id: 'border',
    label: 'Border crossings',
    color: '#fb7185',
    glyph: 'B',
    codes: ['FRONTIER_CROSSING'],
    nameHints: { FRONTIER_CROSSING: ['Frontier Crossing'] },
  },
  {
    id: 'ev',
    label: 'EV charging',
    color: '#34d399',
    glyph: '⚡',
    codes: ['ELECTRIC_VEHICLE_STATION'],
    nameHints: { ELECTRIC_VEHICLE_STATION: ['Electric Vehicle Charging Station'] },
  },
  {
    id: 'logistics',
    label: 'Logistics & truck stops',
    color: '#22c55e',
    glyph: '▣',
    codes: ['TRUCK_STOP', 'REST_AREA', 'IMPORT_EXPORT_AND_DISTRIBUTION', 'TRANSPORT_COMPANY'],
    nameHints: {
      TRUCK_STOP: ['Truck Stop'],
      REST_AREA: ['Rest Area'],
      IMPORT_EXPORT_AND_DISTRIBUTION: ['Import/Export and Distribution'],
      TRANSPORT_COMPANY: ['Transport Company'],
    },
  },
  {
    id: 'industrial',
    label: 'Industrial sites',
    color: '#94a3b8',
    glyph: 'I',
    // Deliberately NOT called "defence industrial base": TomTom has no such
    // classification. This layer is industrial premises and says so.
    codes: ['INDUSTRIAL_BUILDING', 'WHOLESALE_CLUB'],
    nameHints: { INDUSTRIAL_BUILDING: ['Industrial Building'], WHOLESALE_CLUB: ['Wholesale Club'] },
  },
  {
    id: 'parking',
    label: 'Parking garages',
    color: '#818cf8',
    glyph: 'P',
    codes: ['PARKING_GARAGE'],
    nameHints: { PARKING_GARAGE: ['Parking Garage'] },
  },
  {
    id: 'rail',
    label: 'Rail stations',
    color: '#a78bfa',
    glyph: '≡',
    // Category is NAMED "Railroad Station" but classifies as RAILWAY_STATION.
    // Verified empirically — the name is not the code.
    codes: ['RAILWAY_STATION'],
    nameHints: { RAILWAY_STATION: ['Railroad Station'] },
  },
  {
    id: 'comms',
    label: 'Telecom sites',
    color: '#2dd4bf',
    glyph: '▲',
    codes: ['TELECOMMUNICATIONS', 'CABLE_TELEPHONE_COMPANY'],
    nameHints: {
      TELECOMMUNICATIONS: ['Telecommunications'],
      CABLE_TELEPHONE_COMPANY: ['Cable & Telephone Company'],
    },
    caveat: 'TomTom classifies telecom retailers here too, so expect shops alongside operators.',
  },
  {
    id: 'commercial',
    label: 'Commercial (food, lodging, retail)',
    color: '#fbbf24',
    glyph: 'S',
    // Resolved at build time from the category list rather than hard-coded, per spec.
    resolveAtBuild: ['restaurant', 'hotel'],
    /*
     * "Convenience store" resolves to a category that classifies as SHOP — far too
     * broad to allow, since SHOP would admit any retailer. Dropped rather than
     * widened. Hotel classifies as HOTEL_MOTEL, not HOTEL.
     */
    codes: [],
    codeAliases: { HOTEL: 'HOTEL_MOTEL' },
    caveat: 'Crew support only. Never merged into any other layer.',
  },
];

/**
 * Layers the convoy picture wants but TomTom cannot supply.
 *
 * These render a toggle and an explicit "no data source connected" state. They are
 * NEVER approximated with a keyword search or by borrowing a loosely-related
 * category — that approximation is precisely what produced the jewellery-studio
 * -as-defence-industry bug.
 */
export const NO_SOURCE_LAYERS = [
  { id: 'c3isr', label: 'C3ISR nodes', color: '#f97316', glyph: '◈', reason: 'No C3ISR classification exists in any commercial POI dataset.' },
  { id: 'defense_industrial_base', label: 'Defence industrial base', color: '#a3a3a3', glyph: 'D', reason: 'TomTom cannot distinguish a defence supplier from any other manufacturer. This is the exact source of the jewellery-store false positive.' },
  { id: 'cbrn_hazmat', label: 'Nuclear / CBRN / hazmat', color: '#facc15', glyph: '⚠', reason: 'No nuclear, biological, radiological or hazmat-storage classification exists. "Chemical Company" is not a substitute.' },
  { id: 'energy_infrastructure', label: 'Energy infrastructure', color: '#f59e0b', glyph: '⚡', reason: 'No power generation, substation, grid or pipeline categories. Retail fuel is a separate layer and is not the same thing.' },
  /*
   * Bridges & tunnels used to be a POI layer sourced from the Bridge/Tunnel/Dam
   * category ids. Those ids classify as IMPORTANT_TOURIST_ATTRACTION, so the layer
   * only ever returned notable landmarks — four features for a whole city — while
   * every ordinary road bridge and tunnel was missing. It now comes from the Orbis
   * vector road data instead (client/src/lib/roadStructures.js), which carries
   * `bridge` and `tunnel` as boolean attributes on the `roads` source-layer and so
   * covers all of them. DAMS have no equivalent road attribute and were dropped
   * rather than kept as a landmark-only layer.
   */
  { id: 'dams', label: 'Dams', color: '#60a5fa', glyph: '⌓', reason: 'Only reachable via the tourist-attraction POI category, which returns notable dams only. Bridges and tunnels moved to the road-data layer; dams have no road-data equivalent.' },
  { id: 'water_infrastructure', label: 'Water infrastructure', color: '#60a5fa', glyph: '≈', reason: 'No treatment plants or pumping stations.' },
  { id: 'cyber', label: 'Cyber infrastructure', color: '#14b8a6', glyph: '⌗', reason: 'No data-centre, IXP or network-node classification.' },
  { id: 'population_nodes', label: 'Population centres & shelters', color: '#fbbf24', glyph: 'U', reason: 'No shelter or emergency-accommodation classification. Population centres are basemap geography, not POIs.' },
];

export const ALL_LAYER_IDS = [...POI_LAYERS, ...NO_SOURCE_LAYERS].map((l) => l.id);

export function getLayer(id) {
  return POI_LAYERS.find((l) => l.id === id) || null;
}

export function getNoSourceLayer(id) {
  return NO_SOURCE_LAYERS.find((l) => l.id === id) || null;
}
