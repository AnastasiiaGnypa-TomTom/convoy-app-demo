/**
 * Fleet / vehicle profiles and their mapping to TomTom routing constraints.
 *
 * ── Which routing API, and why ─────────────────────────────────────────────
 * The spec called for Orbis Routing. Probed live 2026-07-29, Orbis Routing
 * (apiVersion=2) does NOT support the convoy constraints this demo exists to
 * show: travelMode accepts only `car`, and vehicleLength / vehicleWidth /
 * vehicleHeight / vehicleAxleWeight all return
 *   400 "Invalid request: parameter [vehicleLength] not supported"
 * (also as a POST body: "Unknown JSON field '.vehicleLength'"). Only
 * vehicleWeight, vehicleMaxSpeed and vehicleEngineType are accepted.
 *
 * Classic Routing v1 accepts the full set — truck/van/bus travel modes plus
 * weight, axle weight, length, width, height, commercial and load type — so
 * routing runs on v1. The Orbis basemap is unaffected and still used for tiles.
 * To move routing back to Orbis once it gains constraint support, change
 * ROUTING_ENDPOINT and re-check the parameter names below.
 */

export const ROUTING_ENDPOINT = {
  vendor: 'tomtom-routing-v1',
  path: '/routing/1/calculateRoute',
  detail:
    'Classic Routing v1 — carries the full convoy constraint set. Orbis Routing v2 ' +
    'rejects vehicleLength/Width/Height/AxleWeight and only allows travelMode=car.',
};

/**
 * Presets. `constraints` are TomTom parameter names exactly as the API accepts
 * them, so the proxy can forward them without a second translation layer.
 */
export const FLEET_PROFILES = [
  {
    id: 'light-vehicle',
    label: 'Light vehicle',
    description: 'Car or light 4×4 — no dimensional restrictions',
    icon: 'car',
    constraints: { travelMode: 'car' },
    spec: { weightKg: 2000, lengthM: 4.8, widthM: 1.9, heightM: 1.8, axleWeightKg: 1000 , maxGradePercent: 20},
  },
  {
    id: 'van',
    label: 'Van / light truck',
    description: '3.5 t panel van',
    icon: 'van',
    constraints: {
      travelMode: 'van',
      vehicleWeight: 3500,
      vehicleLength: 6,
      vehicleWidth: 2.1,
      vehicleHeight: 2.6,
      vehicleAxleWeight: 1800,
    },
    spec: { weightKg: 3500, lengthM: 6, widthM: 2.1, heightM: 2.6, axleWeightKg: 1800 , maxGradePercent: 16},
  },
  {
    id: 'heavy-truck',
    label: 'Heavy truck',
    description: '40 t articulated — standard HGV limits',
    icon: 'truck',
    constraints: {
      travelMode: 'truck',
      vehicleCommercial: 'true',
      vehicleWeight: 40000,
      vehicleAxleWeight: 11500,
      vehicleLength: 16.5,
      vehicleWidth: 2.55,
      vehicleHeight: 4,
      vehicleMaxSpeed: 85,
    },
    spec: { weightKg: 40000, lengthM: 16.5, widthM: 2.55, heightM: 4, axleWeightKg: 11500 , maxGradePercent: 8},
  },
  {
    id: 'oversized-convoy',
    label: 'Oversized / heavy convoy',
    description: '60 t abnormal load — 4.8 m high, 4 m wide',
    icon: 'convoy',
    constraints: {
      travelMode: 'truck',
      vehicleCommercial: 'true',
      vehicleWeight: 60000,
      vehicleAxleWeight: 12000,
      vehicleLength: 25,
      vehicleWidth: 4,
      vehicleHeight: 4.8,
      vehicleMaxSpeed: 80,
    },
    spec: { weightKg: 60000, lengthM: 25, widthM: 4, heightM: 4.8, axleWeightKg: 12000 , maxGradePercent: 6},
  },
];

/** Bounds for the custom profile — clamped server-side, not trusted from the client. */
export const CUSTOM_LIMITS = {
  weightKg: { min: 500, max: 200000, step: 500, label: 'Gross weight', unit: 'kg' },
  axleWeightKg: { min: 500, max: 30000, step: 250, label: 'Max axle weight', unit: 'kg' },
  lengthM: { min: 2, max: 50, step: 0.5, label: 'Length', unit: 'm' },
  widthM: { min: 1, max: 8, step: 0.1, label: 'Width', unit: 'm' },
  heightM: { min: 1, max: 8, step: 0.1, label: 'Height', unit: 'm' },
};

/**
 * Coerce then clamp. Uses an explicit finite check rather than `||` so that a
 * legitimate 0 clamps up to the minimum instead of silently taking the default.
 */
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (v, { min, max }) => Math.min(max, Math.max(min, v));

/**
 * Turn a client request into TomTom constraint parameters.
 * Unknown profile ids fall back to the light vehicle rather than erroring, so a
 * stale client can never break routing mid-demo.
 */
export function resolveConstraints({ profileId, custom }) {
  if (profileId === 'custom' && custom) {
    const weightKg = clamp(num(custom.weightKg, 40000), CUSTOM_LIMITS.weightKg);
    const axleWeightKg = clamp(num(custom.axleWeightKg, 11500), CUSTOM_LIMITS.axleWeightKg);
    const lengthM = clamp(num(custom.lengthM, 16.5), CUSTOM_LIMITS.lengthM);
    const widthM = clamp(num(custom.widthM, 2.55), CUSTOM_LIMITS.widthM);
    const heightM = clamp(num(custom.heightM, 4), CUSTOM_LIMITS.heightM);

    // Anything at or above 3.5 t is routed as a commercial truck; below that the
    // truck network rules would over-restrict a large car or minibus.
    const isTruck = weightKg >= 3500;
    /*
     * Grade limit for the custom profile, interpolated from gross weight.
     *
     * Heavier vehicles lose gradeability: a 60 t abnormal load struggles above
     * about 6%, a light 4x4 handles 20%. Used only to FLAG steep route segments for
     * situational awareness — TomTom routing has no grade parameter, so this does
     * not influence the route itself, and the UI says so.
     */
    const maxGradePercent = weightKg >= 55000 ? 6 : weightKg >= 30000 ? 8 : weightKg >= 3500 ? 16 : 20;
    return {
      label: 'Custom vehicle',
      spec: { weightKg, axleWeightKg, lengthM, widthM, heightM, maxGradePercent },
      constraints: {
        travelMode: isTruck ? 'truck' : 'car',
        ...(isTruck ? { vehicleCommercial: 'true' } : {}),
        vehicleWeight: weightKg,
        vehicleAxleWeight: axleWeightKg,
        vehicleLength: lengthM,
        vehicleWidth: widthM,
        vehicleHeight: heightM,
      },
    };
  }

  const profile =
    FLEET_PROFILES.find((p) => p.id === profileId) ||
    FLEET_PROFILES.find((p) => p.id === 'light-vehicle');
  return { label: profile.label, spec: profile.spec, constraints: profile.constraints };
}

/** Client-facing profile list — no secrets, safe to serve. */
export function publicProfiles() {
  return {
    profiles: FLEET_PROFILES.map(({ id, label, description, icon, spec }) => ({
      id,
      label,
      description,
      icon,
      spec,
    })),
    customLimits: CUSTOM_LIMITS,
  };
}
