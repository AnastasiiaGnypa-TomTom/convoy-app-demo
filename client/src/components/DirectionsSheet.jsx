import PlaceInput from './PlaceInput.jsx';
import { formatDelay, formatDistance, formatDuration, formatVehicleSpec } from '../lib/format.js';
import { START_COLOR, END_COLOR } from './RoutePanel.jsx';

/**
 * Directions review: origin, destination, vehicle profile, and the alternatives.
 *
 * The vehicle-profile selector stays visible here on purpose — it is the whole point
 * of this app. Changing it re-routes, and the cards below show how much the
 * constraint cost you versus the fastest option.
 */
export default function DirectionsSheet({
  origin,
  destination,
  profiles,
  customLimits,
  profileId,
  custom,
  routes,
  selectedIndex,
  loading,
  error,
  mapCenter,
  onOriginChange,
  onDestinationChange,
  onProfileChange,
  onCustomChange,
  onSelectRoute,
  onSwap,
  onGo,
  onClose,
}) {
  const features = routes?.features || [];
  const activeProfile = profiles?.find((p) => p.id === profileId);
  // Fastest of the returned set, used to express what the constraint cost.
  const fastest = features.reduce(
    (best, f) => (!best || f.properties.travelTimeSeconds < best.properties.travelTimeSeconds ? f : best),
    null,
  );

  return (
    <section className="sheet directions-sheet" aria-label="Directions">
      <div className="sheet-grip" aria-hidden="true" />

      <header className="sheet-head">
        <h2>Directions</h2>
        <button type="button" className="sheet-close" onClick={onClose} aria-label="Close directions">
          ×
        </button>
      </header>

      <div className="dir-endpoints">
        <PlaceInput
          label="From"
          accent={START_COLOR}
          value={origin}
          placeholder="Choose a start"
          mapCenter={mapCenter}
          onSelect={onOriginChange}
          onPickOnMap={() => {}}
          isPicking={false}
        />
        <PlaceInput
          label="To"
          accent={END_COLOR}
          value={destination}
          placeholder="Choose a destination"
          mapCenter={mapCenter}
          onSelect={onDestinationChange}
          onPickOnMap={() => {}}
          isPicking={false}
        />
        <button type="button" className="dir-swap" onClick={onSwap} title="Swap origin and destination">
          ⇅
        </button>
      </div>

      <div className="dir-profile">
        <select
          className="profile-select"
          value={profileId}
          onChange={(e) => onProfileChange(e.target.value)}
          aria-label="Vehicle profile"
        >
          {(profiles || []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom vehicle…</option>
        </select>
        {profileId !== 'custom' && activeProfile && (
          <p className="dir-profile-spec">{formatVehicleSpec(activeProfile.spec)}</p>
        )}
      </div>

      {profileId === 'custom' && customLimits && (
        <div className="custom-grid">
          {Object.entries(customLimits).map(([key, lim]) => (
            <label key={key} className="custom-field">
              <span>
                {lim.label} <em>({lim.unit})</em>
              </span>
              <input
                type="number"
                min={lim.min}
                max={lim.max}
                step={lim.step}
                value={custom[key] ?? ''}
                onChange={(e) => onCustomChange(key, e.target.value)}
              />
            </label>
          ))}
        </div>
      )}

      {loading && <p className="panel-note">Calculating routes…</p>}
      {error && !loading && <p className="dir-error">{error}</p>}

      {!loading && features.length > 0 && (
        <ul className="route-cards">
          {features.map((f) => {
            const p = f.properties;
            const isSelected = p.index === selectedIndex;
            const delay = formatDelay(p.trafficDelaySeconds);
            // "Detour" here means slower than the best option returned for this
            // profile — i.e. what choosing this alternative costs.
            const slowerBy =
              fastest && p.travelTimeSeconds > fastest.properties.travelTimeSeconds
                ? p.travelTimeSeconds - fastest.properties.travelTimeSeconds
                : 0;
            return (
              <li key={p.index}>
                <button
                  type="button"
                  className={`route-card ${isSelected ? 'route-card-selected' : ''}`}
                  onClick={() => onSelectRoute(p.index)}
                  aria-pressed={isSelected}
                >
                  <span className="route-card-main">
                    <strong>{formatDuration(p.travelTimeSeconds)}</strong>
                    <span className="route-card-dist">{formatDistance(p.lengthMeters)}</span>
                  </span>
                  <span className="route-card-meta">
                    {p.index === 0 ? 'Fastest' : `Alternative ${p.index}`}
                    {delay ? ` · ${delay}` : ''}
                    {slowerBy ? ` · +${Math.round(slowerBy / 60)} min slower` : ''}
                  </span>
                  {p.maneuverCount != null && (
                    <span className="route-card-meta">{p.maneuverCount} turns</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="dir-actions">
        <button
          type="button"
          className="btn-primary btn-go"
          onClick={onGo}
          disabled={!features.length || loading}
        >
          Go
        </button>
      </div>
    </section>
  );
}
