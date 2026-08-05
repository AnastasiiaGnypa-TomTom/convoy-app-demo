import { formatDistance, formatDuration } from '../lib/format.js';
import { maneuverGlyph } from '../lib/navigation.js';

/** Distance phrasing a driver expects: rounded coarse when far, precise when close. */
function formatManeuverDistance(m) {
  if (m == null) return '';
  if (m < 30) return 'now';
  if (m < 500) return `${Math.round(m / 10) * 10} m`;
  if (m < 1000) return `${Math.round(m / 50) * 50} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

const clock = (d) =>
  d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

/**
 * Full guidance view: maneuver banner on top, trip bar at the bottom.
 *
 * Deliberately sparse. Everything here is readable at a glance because it is meant
 * to be looked at while driving — which also makes it read as a navigation app
 * rather than a dashboard when demoed.
 */
export default function NavigateView({
  maneuver,
  progress,
  source,
  paused,
  speedMultiplier,
  gpsError,
  offRoute,
  voiceOn,
  followingCamera,
  onTogglePause,
  onCycleSpeed,
  onToggleSource,
  onToggleVoice,
  cameraMode,
  onToggleCameraMode,
  onRecenter,
  onEnd,
}) {
  return (
    <>
      {/* ---------------------------------------------------- maneuver banner */}
      <div className="nav-banner" role="status" aria-live="polite">
        <span className="nav-maneuver-icon" aria-hidden="true">
          {maneuverGlyph(maneuver?.maneuver)}
        </span>
        <div className="nav-maneuver-text">
          <span className="nav-maneuver-dist">{formatManeuverDistance(maneuver?.distanceToManeuver)}</span>
          <span className="nav-maneuver-street">
            {maneuver?.street || maneuver?.message || 'Continue'}
          </span>
        </div>
        <button type="button" className="nav-close" onClick={onEnd} aria-label="End navigation">
          ×
        </button>
      </div>

      {offRoute && (
        <div className="nav-warn" role="alert">
          Off route by {Math.round(offRoute)} m
        </div>
      )}
      {gpsError && (
        <div className="nav-warn" role="alert">
          {gpsError} — using the simulated driver.
        </div>
      )}

      {/* Only offered when the user has panned away, like a real nav app. */}
      {!followingCamera && (
        <button type="button" className="fab fab-recenter" onClick={onRecenter}>
          Re-centre
        </button>
      )}

      {/* --------------------------------------------------------- trip bar */}
      <div className="nav-bottom">
        <div className="nav-trip">
          <span className="nav-eta">{clock(progress?.etaDate)}</span>
          <span className="nav-trip-sub">
            {formatDuration(progress?.remainingSeconds)} · {formatDistance(progress?.remainingMeters)}
          </span>
        </div>

        <div className="nav-controls">
          {source === 'simulated' && (
            <>
              <button type="button" className="nav-btn" onClick={onTogglePause}>
                {paused ? '▶' : '❚❚'}
              </button>
              <button type="button" className="nav-btn" onClick={onCycleSpeed}>
                {speedMultiplier}×
              </button>
            </>
          )}
          {/* Follow ↔ Overhead: one toggle, one smooth transition. */}
          <button
            type="button"
            className={`nav-btn nav-btn-wide ${cameraMode === 'overhead' ? 'nav-btn-on' : ''}`}
            onClick={onToggleCameraMode}
            title={
              cameraMode === 'overhead'
                ? 'Overhead (north-up) — tap for the 3D chase camera'
                : '3D chase camera — tap for overhead north-up'
            }
          >
            {cameraMode === 'overhead' ? '▦' : '◭'}
          </button>
          <button
            type="button"
            className={`nav-btn ${voiceOn ? 'nav-btn-on' : ''}`}
            onClick={onToggleVoice}
            title="Voice guidance"
          >
            {voiceOn ? '🔊' : '🔇'}
          </button>
          <button
            type="button"
            className={`nav-btn nav-btn-wide ${source === 'gps' ? 'nav-btn-on' : ''}`}
            onClick={onToggleSource}
            title={source === 'gps' ? 'Using real GPS' : 'Using the simulated driver'}
          >
            {source === 'gps' ? 'GPS' : 'SIM'}
          </button>
          <button type="button" className="nav-btn nav-end" onClick={onEnd}>
            End
          </button>
        </div>
      </div>
    </>
  );
}
