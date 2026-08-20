import { formatDistance } from '../lib/format.js';

/**
 * Route elevation profile.
 *
 * Inline SVG rather than a charting library: one path, a few axis labels and the
 * steep-segment bands are all this needs, and it avoids shipping a chart bundle for
 * a single view.
 *
 * Steep stretches are shaded on the chart in the same amber as their highlight on the
 * map, so the two read as one thing.
 */
export default function ElevationProfile({ profile, vehicleLabel, gradeLimit, unavailableReason }) {
  if (unavailableReason) {
    return (
      <div className="panel-section">
        <h2>Elevation</h2>
        <p className="panel-note panel-note-dim">{unavailableReason}</p>
      </div>
    );
  }
  if (!profile) return null;

  if (profile.insufficient) {
    return (
      <div className="panel-section">
        <h2>Elevation</h2>
        <p className="panel-note panel-note-dim">
          Waiting for elevation tiles to cover the route…
        </p>
      </div>
    );
  }

  const W = 300;
  const H = 90;
  const pad = { l: 2, r: 2, t: 6, b: 12 };
  const { samples, minElevation, maxElevation, totalDistance } = profile;

  // Never let a flat route collapse to a zero-height chart.
  const range = Math.max(10, maxElevation - minElevation);
  const x = (d) => pad.l + (d / totalDistance) * (W - pad.l - pad.r);
  const y = (e) => pad.t + (1 - (e - minElevation) / range) * (H - pad.t - pad.b);

  const line = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.distance).toFixed(1)},${y(s.elevation).toFixed(1)}`).join('');
  const area = `${line}L${x(totalDistance).toFixed(1)},${H - pad.b}L${x(0).toFixed(1)},${H - pad.b}Z`;

  const overLimit = profile.steepSegments.length > 0;

  return (
    <div className="panel-section">
      <div className="section-head">
        <h2>Elevation profile</h2>
        <span className="elev-range">
          {minElevation}–{maxElevation} m
        </span>
      </div>

      {/*
        * ux-elev: preserveAspectRatio="none" so the chart FILLS its box.
        *
        * The default (xMidYMid meet) letterboxes a 300x90 viewBox inside a wide, short
        * container — the chart drew centred with dead space either side, which is why it
        * never reached the edges of the strip. Stretching is right here: both axes are
        * independent scales (distance and metres), so there is no aspect ratio to
        * preserve, and the axis labels are drawn in the same user units so they stretch
        * with it.
        */}
      <svg
        className="elev-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Route elevation profile"
      >
        <path d={area} className="elev-area" />
        {/* Steep bands behind the line so the line stays readable. */}
        {profile.steepSegments.map((seg, i) => (
          <rect
            key={i}
            className="elev-steep"
            x={x(seg.startDistance)}
            y={pad.t}
            width={Math.max(1.5, x(seg.endDistance) - x(seg.startDistance))}
            height={H - pad.t - pad.b}
          />
        ))}
        <path d={line} className="elev-line" />
        <text x={pad.l} y={H - 2} className="elev-axis">
          0
        </text>
        <text x={W - pad.r} y={H - 2} textAnchor="end" className="elev-axis">
          {formatDistance(totalDistance)}
        </text>
      </svg>

      <div className="elev-stats">
        <span className="elev-stat">
          <em>↑</em> {profile.totalGain} m
        </span>
        <span className="elev-stat">
          <em>↓</em> {profile.totalLoss} m
        </span>
        <span className={`elev-stat ${overLimit ? 'elev-stat-warn' : ''}`}>
          <em>max</em> {Math.abs(profile.maxGrade)}%
        </span>
      </div>

      {gradeLimit != null && (
        <p className={`elev-grade ${overLimit ? 'elev-grade-warn' : ''}`}>
          {overLimit ? (
            <>
              <strong>
                {profile.steepSegments.length} stretch
                {profile.steepSegments.length === 1 ? '' : 'es'} over the {gradeLimit}% limit
              </strong>{' '}
              for {vehicleLabel} — steepest {Math.abs(profile.maxGrade)}%, longest{' '}
              {formatDistance(Math.max(...profile.steepSegments.map((s) => s.lengthM)))}. Highlighted
              on the map.
            </>
          ) : (
            <>Within the {gradeLimit}% grade limit for {vehicleLabel}.</>
          )}
        </p>
      )}

      {/* The honest caveat: grade informs, it does not route. */}
      <p className="elev-caveat">
        Grade is advisory. TomTom routing has no grade parameter, so steep stretches are
        flagged for awareness — the route is not planned around them.
      </p>
    </div>
  );
}
