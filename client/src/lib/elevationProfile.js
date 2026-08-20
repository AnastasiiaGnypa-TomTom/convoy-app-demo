/**
 * Route elevation profile and grade analysis.
 *
 * Elevation comes from MapLibre's own `queryTerrainElevation`, which reads the
 * loaded raster-dem tiles. That means no extra service, no server-side PNG decoding
 * and no second source of truth: what the profile reports is exactly the terrain the
 * map is drawing.
 *
 * The consequence, stated plainly: it only works once terrain is set and the DEM
 * tiles covering the route have loaded. The caller samples after terrain is active
 * and re-samples if coverage was incomplete.
 *
 * Grade is used for SITUATIONAL AWARENESS only. TomTom routing has no grade
 * parameter, so a steep segment is flagged, never avoided — the UI says so rather
 * than implying the route was planned around it.
 */

import { distanceBetween } from './navigation.js';

/** Target spacing between samples. Fine enough for grade, coarse enough to stay cheap. */
const SAMPLE_SPACING_M = 100;
const MAX_SAMPLES = 400;

/**
 * Sample elevation along a route.
 *
 * @returns {null|{samples, totalGain, totalLoss, maxGrade, steepSegments, coverage}}
 */
export function sampleRouteElevation(map, coordinates, { maxGradePercent } = {}) {
  if (!map?.queryTerrainElevation || !coordinates?.length) return null;

  // Cumulative distance so samples are evenly spaced by ground distance, not by
  // vertex index — route vertices bunch up at junctions.
  const cum = [0];
  for (let i = 1; i < coordinates.length; i++) {
    cum.push(cum[i - 1] + distanceBetween(coordinates[i - 1], coordinates[i]));
  }
  const total = cum[cum.length - 1];
  if (total <= 0) return null;

  const count = Math.min(MAX_SAMPLES, Math.max(2, Math.round(total / SAMPLE_SPACING_M)));
  const samples = [];
  let missing = 0;

  for (let i = 0; i < count; i++) {
    const d = (total * i) / (count - 1);
    // Walk to the segment containing d.
    let seg = 1;
    while (seg < cum.length - 1 && cum[seg] < d) seg++;
    const segLen = cum[seg] - cum[seg - 1] || 1;
    const t = (d - cum[seg - 1]) / segLen;
    const [x1, y1] = coordinates[seg - 1];
    const [x2, y2] = coordinates[seg];
    const lng = x1 + (x2 - x1) * t;
    const lat = y1 + (y2 - y1) * t;

    let elevation = null;
    try {
      // exaggerated:false so the profile reports TRUE elevation regardless of the
      // visual terrain-exaggeration slider (otherwise e.g. 2.5x inflates every number).
      elevation = map.queryTerrainElevation({ lng, lat }, { exaggerated: false });
    } catch {
      elevation = null;
    }
    if (elevation == null || Number.isNaN(elevation)) missing++;
    samples.push({ distance: d, elevation, coord: [lng, lat] });
  }

  // If most samples came back empty the DEM has not loaded (or does not cover the
  // route) — report rather than presenting a flat line as fact.
  const coverage = 1 - missing / samples.length;
  if (coverage < 0.5) return { samples, coverage, insufficient: true };

  // Fill isolated gaps by linear interpolation so the chart has no holes.
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].elevation != null) continue;
    let prev = i - 1;
    while (prev >= 0 && samples[prev].elevation == null) prev--;
    let next = i + 1;
    while (next < samples.length && samples[next].elevation == null) next++;
    if (prev >= 0 && next < samples.length) {
      const f = (i - prev) / (next - prev);
      samples[i].elevation =
        samples[prev].elevation + (samples[next].elevation - samples[prev].elevation) * f;
    } else {
      samples[i].elevation = samples[prev >= 0 ? prev : next]?.elevation ?? 0;
    }
  }

  /* --------------------------------------------------------- smooth noise */
  // queryTerrainElevation reads whatever DEM tiles are currently loaded; when only
  // part of a long route is in view, or at tile/LOD boundaries, single samples jump
  // by tens of metres. Unsmoothed, that produces impossible grades (140%+) and hugely
  // inflated gain/loss. A short moving average (~5 samples ≈ 500 m) removes the noise
  // while keeping real hills. Applied to elevation so the chart and analysis agree.
  {
    const raw = samples.map((s) => s.elevation);
    const H = 2; // half-window
    for (let i = 0; i < samples.length; i++) {
      let sum = 0;
      let n = 0;
      for (let k = i - H; k <= i + H; k++) {
        if (k >= 0 && k < raw.length && raw[k] != null) {
          sum += raw[k];
          n++;
        }
      }
      if (n) samples[i].elevation = sum / n;
    }
  }

  /* ------------------------------------------------------------- analysis */
  let totalGain = 0;
  let totalLoss = 0;
  let maxGrade = 0;
  let maxGradeAt = null;
  const graded = [];

  for (let i = 1; i < samples.length; i++) {
    const rise = samples[i].elevation - samples[i - 1].elevation;
    const run = samples[i].distance - samples[i - 1].distance;
    // 0.5 m dead-band: ignore residual sub-metre DEM jitter so gain/loss is not
    // inflated by noise (a flat city route was reporting thousands of metres).
    if (rise > 0.5) totalGain += rise;
    else if (rise < -0.5) totalLoss -= rise;

    // Signed grade as a percentage; run is ~100 m so this is a real slope.
    const grade = run > 0 ? (rise / run) * 100 : 0;
    samples[i].grade = grade;
    // Cap consideration at a physically plausible road grade; anything above ~45%
    // is residual DEM noise, not a real slope (was reporting 142%).
    if (Math.abs(grade) <= 45 && Math.abs(grade) > Math.abs(maxGrade)) {
      maxGrade = grade;
      maxGradeAt = samples[i].distance;
    }
    graded.push({ index: i, grade });
  }
  if (samples.length) samples[0].grade = samples[1]?.grade ?? 0;

  /* ---------------------------------------- segments over the vehicle limit */
  const limit = Number(maxGradePercent) || null;
  const steepSegments = [];
  if (limit) {
    let open = null;
    for (let i = 1; i < samples.length; i++) {
      const over = Math.abs(samples[i].grade) > limit;
      if (over && !open) open = { startIndex: i - 1, startDistance: samples[i - 1].distance, peak: 0 };
      if (open) open.peak = Math.max(open.peak, Math.abs(samples[i].grade));
      if ((!over || i === samples.length - 1) && open) {
        open.endIndex = i;
        open.endDistance = samples[i].distance;
        open.lengthM = open.endDistance - open.startDistance;
        // Ignore single-sample spikes: DEM noise, not a hill.
        if (open.lengthM >= SAMPLE_SPACING_M) steepSegments.push(open);
        open = null;
      }
    }
  }

  const elevations = samples.map((s) => s.elevation);
  return {
    samples,
    coverage,
    insufficient: false,
    totalGain: Math.round(totalGain),
    totalLoss: Math.round(totalLoss),
    minElevation: Math.round(Math.min(...elevations)),
    maxElevation: Math.round(Math.max(...elevations)),
    maxGrade: Number(maxGrade.toFixed(1)),
    maxGradeAt,
    gradeLimit: limit,
    steepSegments,
    totalDistance: total,
  };
}

/** GeoJSON for the steep stretches, so they can be highlighted on the map. */
export function steepSegmentsToGeoJSON(profile) {
  if (!profile?.steepSegments?.length) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: profile.steepSegments.map((seg) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: profile.samples
          .slice(seg.startIndex, seg.endIndex + 1)
          .map((s) => s.coord),
      },
      properties: {
        peakGrade: Number(seg.peak.toFixed(1)),
        lengthM: Math.round(seg.lengthM),
      },
    })),
  };
}
