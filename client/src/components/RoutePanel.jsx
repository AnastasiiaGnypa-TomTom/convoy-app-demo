import PlaceInput from './PlaceInput.jsx';
import { formatDelay, formatDistance, formatDuration, formatVehicleSpec } from '../lib/format.js';

export const START_COLOR = '#3fb950';
export const END_COLOR = '#f85149';
/** Kept in step with ALT_COLOR / SELECTED_COLOR in lib/routeLayers.js. */
export const ALT_SWATCH = '#8b5cf6';
export const SELECTED_SWATCH = '#38bdf8';

/**
 * The demo's primary control surface: pick a fleet profile, set start and end,
 * then compare the returned alternatives. Deliberately the densest, most
 * interactive part of the UI — TomTom's routing is what this demo is selling.
 */
export default function RoutePanel({
  profiles,
  customLimits,
  profileId,
  custom,
  start,
  end,
  routeData,
  selectedIndex,
  loading,
  picking,
  mapCenter,
  onProfileChange,
  onCustomChange,
  onStartChange,
  onEndChange,
  onPick,
  onSelectRoute,
  onSwap,
  onClear,
  onUseMyLocation,
  locating,
  canLocate,
}) {
  const activeProfile = profiles.find((p) => p.id === profileId);
  const features = routeData?.routes?.features || [];

  return (
    <>
      {/* ------------------------------------------------ fleet profile ---- */}
      <div className="panel-section">
        <h2>Fleet profile</h2>
        <select
          className="profile-select"
          value={profileId}
          onChange={(e) => onProfileChange(e.target.value)}
          aria-label="Vehicle profile"
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom vehicle…</option>
        </select>

        {profileId !== 'custom' && activeProfile && (
          <p className="profile-detail">
            {activeProfile.description}
            <span className="profile-spec">{formatVehicleSpec(activeProfile.spec)}</span>
          </p>
        )}

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
            <p className="custom-note">
              Vehicles at or above 3.5&nbsp;t route on the commercial road network.
            </p>
          </div>
        )}
      </div>

      {/* ---------------------------------------------------- endpoints ---- */}
      <div className="panel-section">
        <div className="section-head">
          <h2>Start &amp; destination</h2>
          <span className="section-actions">
            <button
              type="button"
              className="link-btn"
              onClick={onSwap}
              disabled={!start || !end}
              title="Swap start and destination"
            >
              Swap
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={onClear}
              disabled={!start && !end}
              title="Clear both points and start over"
            >
              Clear
            </button>
          </span>
        </div>

        {canLocate && (
          <button type="button" className="locate-btn" onClick={onUseMyLocation} disabled={locating}>
            {locating ? 'Locating…' : 'Use my location as start'}
          </button>
        )}

        <PlaceInput
          label="Start"
          accent={START_COLOR}
          value={start}
          placeholder="Search a place, or pick on map"
          mapCenter={mapCenter}
          onSelect={onStartChange}
          onPickOnMap={() => onPick(picking === 'start' ? null : 'start')}
          isPicking={picking === 'start'}
        />
        <PlaceInput
          label="Destination"
          accent={END_COLOR}
          value={end}
          placeholder="Search a place, or pick on map"
          mapCenter={mapCenter}
          onSelect={onEndChange}
          onPickOnMap={() => onPick(picking === 'end' ? null : 'end')}
          isPicking={picking === 'end'}
        />
      </div>

      {/* --------------------------------------------------- alternatives -- */}
      <div className="panel-section">
        <div className="section-head">
          <h2>Routes</h2>
          {loading && <span className="mini-spinner" aria-label="Calculating route" />}
        </div>

        {!features.length && !loading && (
          <div className="empty-state">
            <p className="panel-note">
              {!start && !end
                ? 'Click the map twice — once for your start, once for your destination — or search for places above.'
                : !start
                  ? 'Set a start point to calculate a route.'
                  : !end
                    ? 'Now set a destination. Click the map or search above.'
                    : 'No route yet.'}
            </p>
            <p className="panel-note panel-note-dim">
              Then switch fleet profile to see the route change: heavier and taller
              vehicles are pushed off restricted roads.
            </p>
          </div>
        )}

        {features.length > 0 && (
          <>
            <ul className="route-list">
              {features.map((f) => {
                const p = f.properties;
                const delay = formatDelay(p.trafficDelaySeconds);
                const isSelected = p.index === selectedIndex;
                return (
                  <li key={p.index}>
                    <button
                      type="button"
                      className={`route-option ${isSelected ? 'route-option-selected' : ''}`}
                      onClick={() => onSelectRoute(p.index)}
                      aria-pressed={isSelected}
                    >
                      <span className="route-rank">
                        <span
                          className="route-swatch"
                          style={{ background: isSelected ? SELECTED_SWATCH : ALT_SWATCH }}
                          aria-hidden="true"
                        />
                        {p.index === 0 ? 'Fastest' : `Alt ${p.index}`}
                      </span>
                      <span className="route-metrics">
                        <strong>{formatDuration(p.travelTimeSeconds)}</strong>
                        <span className="route-dist">{formatDistance(p.lengthMeters)}</span>
                      </span>
                      {delay && <span className="route-delay">{delay}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            {routeData?.profile && (
              <p className="route-vendor">
                Routed as <strong>{routeData.profile.label}</strong> ({routeData.profile.travelMode})
                {' · '}
                {features.length} option{features.length === 1 ? '' : 's'}
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
