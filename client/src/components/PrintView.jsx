import { formatDistance, formatDuration, formatVehicleSpec } from '../lib/format.js';

/*
 * task 10a: printable route output.
 *
 * A plain document, not a styled dashboard: the point is a page someone can hand over or
 * file. Everything here already exists in the app's state, so nothing is recomputed and
 * nothing can disagree with what is on screen.
 *
 * Deliberately NOT included: sharing links, sync, permissions. Those are separate tasks,
 * and a half-built share is worse than none.
 */

const pct = (n) => (n == null ? '—' : `${Math.abs(Math.round(n * 10) / 10)}%`);

export default function PrintView({
  route,
  profileLabel,
  profileSpec,
  origin,
  destination,
  elevProfile,
  gradeLimit,
  structures,
  roundabouts,
  composition,
  pois,
  poiLayers,
  timing,
  avoidApplied,
  mapSnapshot,
  onClose,
  onPrint,
}) {
  const p = route?.properties || {};
  const overLimit = gradeLimit != null && elevProfile && Math.abs(elevProfile.maxGrade) > gradeLimit;

  // POIs grouped by layer, so the list is readable rather than 100 undifferentiated rows.
  const byLayer = new Map();
  for (const f of pois?.features || []) {
    const id = f.properties?.layer;
    if (!byLayer.has(id)) byLayer.set(id, []);
    byLayer.get(id).push(f.properties?.name || 'Unnamed');
  }
  const layerLabel = (id) => poiLayers?.find((l) => l.id === id)?.label || id;

  return (
    <div className="print-view">
      {/* Screen-only controls; `print-hide` keeps them off the paper. */}
      <div className="print-bar print-hide">
        <button type="button" className="btn-primary" onClick={onPrint}>
          Print / Save as PDF
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>
          Back to map
        </button>
        <span className="print-hint">
          Use your browser&apos;s print dialogue — choose &ldquo;Save as PDF&rdquo; for a file.
        </span>
      </div>

      <article className="print-doc">
        <header className="print-head">
          <h1>Convoy route plan</h1>
          <p className="print-sub">
            TomTom routing &amp; traffic × Vantor imagery ·{' '}
            {new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
        </header>

        <section className="print-sec">
          <h2>Route</h2>
          <dl className="print-grid">
            <dt>From</dt>
            <dd>{origin || '—'}</dd>
            <dt>To</dt>
            <dd>{destination || '—'}</dd>
            <dt>Vehicle</dt>
            <dd>
              {profileLabel || '—'}
              {/*
                * formatVehicleSpec, not the raw object: `spec` is
                * {weightKg, heightM, ...}, which interpolated straight into JSX printed
                * "[object Object]" on the page.
                */}
              {profileSpec ? ` — ${formatVehicleSpec(profileSpec)}` : ''}
            </dd>
            <dt>Distance</dt>
            <dd>{formatDistance(p.lengthMeters)}</dd>
            <dt>Travel time</dt>
            <dd>{formatDuration(p.travelTimeSeconds)}</dd>
            <dt>Departure</dt>
            <dd>
              {p.departureTime
                ? new Date(p.departureTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
                : '—'}
              {timing && !timing.liveTraffic ? ' (typical traffic for this time)' : ' (live traffic)'}
            </dd>
            <dt>Arrival</dt>
            <dd>
              {p.arrivalTime
                ? new Date(p.arrivalTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
                : '—'}
            </dd>
            <dt>Max grade</dt>
            <dd>
              {elevProfile ? pct(elevProfile.maxGrade) : 'No elevation data'}
              {overLimit ? ` — over the ${gradeLimit}% limit for this vehicle` : ''}
            </dd>
            {avoidApplied?.length > 0 && (
              <>
                <dt>Avoiding</dt>
                <dd>{avoidApplied.join(', ')}</dd>
              </>
            )}
          </dl>
        </section>

        {mapSnapshot && (
          <section className="print-sec print-map-sec">
            <h2>Map</h2>
            {/*
              * A static snapshot taken from the live canvas, so the paper shows exactly
              * what was on screen. An interactive map cannot print.
              */}
            <img className="print-map" src={mapSnapshot} alt="Route map" />
          </section>
        )}

        <section className="print-sec">
          <h2>Bridges &amp; tunnels on the route ({structures?.length || 0})</h2>
          {structures?.length ? (
            <table className="print-table">
              <thead>
                <tr>
                  <th>At</th>
                  <th>Type</th>
                  <th>Name</th>
                  <th>Length</th>
                </tr>
              </thead>
              <tbody>
                {structures.map((s, i) => (
                  <tr key={`${s.kind}-${i}`}>
                    <td>
                      {s.startDistance < 1000
                        ? `${Math.round(s.startDistance / 10) * 10} m`
                        : `${(s.startDistance / 1000).toFixed(1)} km`}
                    </td>
                    <td>{s.kind === 'tunnel' ? 'Tunnel' : 'Bridge'}</td>
                    <td>{s.name || '—'}</td>
                    <td>
                      {s.lengthM > (s.resolutionM || 25) * 2
                        ? `~${Math.round(s.lengthM / 50) * 50} m`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="print-none">None detected on this route.</p>
          )}
          {/* The same caveat the app shows, carried onto paper. */}
          <p className="print-note">
            No clearance or weight limits exist in this map data. The route was calculated with
            this vehicle&apos;s height and weight, so TomTom rejected anything it cannot pass.
          </p>
        </section>

        {composition?.types?.length > 0 && (
          <section className="print-sec">
            <h2>Road types</h2>
            <table className="print-table">
              <tbody>
                {composition.types.map((t) => (
                  <tr key={t.type}>
                    <td>{t.label}</td>
                    <td>
                      {t.percent}% · {(t.meters / 1000).toFixed(1)} km
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="print-note">{composition.note}</p>
          </section>
        )}

        {roundabouts && (
          <section className="print-sec">
            <h2>Roundabouts ({roundabouts.count})</h2>
            {roundabouts.count ? (
              <table className="print-table">
                <tbody>
                  {roundabouts.items.map((r, i) => (
                    <tr key={i}>
                      <td>
                        {r.distanceMeters < 1000
                          ? `${Math.round(r.distanceMeters / 10) * 10} m`
                          : `${(r.distanceMeters / 1000).toFixed(1)} km`}
                      </td>
                      <td>{r.street || 'Roundabout'}</td>
                      <td>{r.exit != null ? `exit ${r.exit}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="print-none">None on this route.</p>
            )}
            <p className="print-note">Railroad crossings: pending data source — not included.</p>
          </section>
        )}

        <section className="print-sec">
          <h2>Points of interest near the route ({pois?.features?.length || 0})</h2>
          {byLayer.size ? (
            [...byLayer.entries()].map(([id, names]) => (
              <div key={id} className="print-poi-group">
                <h3>
                  {layerLabel(id)} ({names.length})
                </h3>
                <p className="print-poi-names">{names.slice(0, 40).join(' · ')}</p>
                {names.length > 40 && (
                  <p className="print-note">
                    Showing the first 40 of {names.length}.
                  </p>
                )}
              </div>
            ))
          ) : (
            <p className="print-none">No POI layers were switched on.</p>
          )}
        </section>

        <footer className="print-foot">
          Routing, traffic, roads and places: TomTom. Imagery: Vantor / Maxar. Elevation: AWS
          Terrain Tiles / Mapzen. This is a planning aid, not an authorised abnormal-load permit
          route.
        </footer>
      </article>
    </div>
  );
}
