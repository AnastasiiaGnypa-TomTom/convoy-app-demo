import { useState } from 'react';
import PlaceInput from './PlaceInput.jsx';
import ViewToggles from './ViewToggles.jsx';
import { formatDelay, formatDistance, formatDuration, formatVehicleSpec } from '../lib/format.js';
import { END_COLOR, START_COLOR } from './RoutePanel.jsx';

/**
 * The single panel surface.
 *
 * Everything lives here: search, directions, basemap/view, layers, timeline,
 * elevation. Previously these were separate floating sheets that shared one slot on
 * the map, so opening Directions hid Layers and two sheets could stack invisibly on
 * top of each other. One scroll column with collapsible sections removes that class
 * of bug entirely — no two things can contend for the same space.
 *
 * Sections are independently collapsible, NOT an exclusive accordion: expanding
 * Layers must not collapse Directions, because comparing a route against POI
 * coverage is a thing people actually do.
 *
 * Desktop: a fixed rail that is always present. Mobile: the same component rendered
 * as one draggable bottom sheet — same content, same tree, one surface.
 */

function Section({ id, title, badge, open, onToggle, children, hidden }) {
  if (hidden) return null;
  return (
    <section className={`side-section ${open ? 'side-section-open' : ''}`}>
      <button
        type="button"
        className="side-head"
        onClick={() => onToggle(id)}
        aria-expanded={open}
      >
        <span className="side-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="side-title">{title}</span>
        {badge != null && <span className="side-badge">{badge}</span>}
      </button>
      {open && <div className="side-body">{children}</div>}
    </section>
  );
}

export default function Sidebar({
  collapsed,
  onToggleCollapsed,
  // search / directions
  searchBar,
  origin,
  destination,
  profiles,
  customLimits,
  profileId,
  custom,
  routes,
  selectedIndex,
  routeStructures,
  // task 7
  avoidOptions,
  avoid,
  onAvoidChange,
  composition,
  onSelectStructure,
  highlightedStructureKey,
  routeLoading,
  routeError,
  mapCenter,
  onOriginChange,
  onDestinationChange,
  onProfileChange,
  onCustomChange,
  onSelectRoute,
  onSwap,
  onClear,
  onGo,
  // view
  basemap,
  view,
  exaggeration,
  satelliteAvailable,
  buildingsAvailable,
  terrainAvailable,
  onBasemapChange,
  onViewChange,
  onExaggerationChange,
  // slots
  layersPanel,
  trafficControl,
  timelinePanel,
  elevationPanel,
  placeCard,
}) {
  /*
   * Search+directions and view start open: they are what a demo touches first.
   * The rest are present but collapsed, so the panel is scannable rather than a wall.
   */
  const [open, setOpen] = useState({
    route: true,
    view: true,
    layers: false,
    timeline: false,
    elevation: true,
  });
  const toggle = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  const features = routes?.features || [];
  const activeProfile = profiles?.find((p) => p.id === profileId);
  const fastest = features.reduce(
    (best, f) =>
      !best || f.properties.travelTimeSeconds < best.properties.travelTimeSeconds ? f : best,
    null,
  );

  if (collapsed) {
    // Icon rail: collapsed, never gone.
    return (
      <aside className="sidebar sidebar-rail" aria-label="Panel (collapsed)">
        <button type="button" className="rail-btn" onClick={onToggleCollapsed} title="Expand panel">
          ☰
        </button>
        <span className="rail-mark" aria-hidden="true" />
      </aside>
    );
  }

  return (
    <aside className="sidebar" aria-label="Convoy controls">
      <div className="sheet-grip" aria-hidden="true" />

      <div className="sidebar-top">
        {searchBar}
        <button
          type="button"
          className="sidebar-collapse"
          onClick={onToggleCollapsed}
          title="Collapse panel"
        >
          ⟨
        </button>
      </div>

      {/* A tapped POI lives at the top of the panel, not in a floating card that
          would overlap whatever else is open. */}
      {placeCard}

      <div className="sidebar-scroll">
        <Section id="route" title="Route" open={open.route} onToggle={toggle}
          badge={features.length || null}>
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
            <div className="dir-row-actions">
              <button type="button" className="link-btn" onClick={onSwap} disabled={!origin || !destination}>
                Swap
              </button>
              <button type="button" className="link-btn" onClick={onClear} disabled={!origin && !destination}>
                Clear
              </button>
            </div>
          </div>

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

          {routeLoading && <p className="panel-note">Calculating routes…</p>}
          {routeError && !routeLoading && <p className="dir-error">{routeError}</p>}
          {!routeLoading && !features.length && !routeError && (
            <p className="panel-note panel-note-dim">
              Search above, or click the map twice — once for the start, once for the
              destination.
            </p>
          )}

          {!routeLoading && features.length > 0 && (
            <>
              <ul className="route-cards">
                {features.map((f) => {
                  const p = f.properties;
                  const isSelected = p.index === selectedIndex;
                  const delay = formatDelay(p.trafficDelaySeconds);
                  const slower =
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
                          {slower ? ` · +${Math.round(slower / 60)} min` : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {/*
                * Bridges and tunnels on the chosen route — the clearance and weight
                * constraints a convoy planner actually cares about.
                */}
              {routeStructures?.length > 0 && (
                <div className="route-structures">
                  <h4 className="route-structures-title">
                    On this route
                    <span className="route-structures-count">
                      {(() => {
                        const nb = routeStructures.filter((x) => x.kind === 'bridge').length;
                        const nt = routeStructures.filter((x) => x.kind === 'tunnel').length;
                        const part = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
                        return [nb && part(nb, 'bridge'), nt && part(nt, 'tunnel')]
                          .filter(Boolean)
                          .join(' · ');
                      })()}
                    </span>
                  </h4>
                  <ul className="route-structures-list">
                    {routeStructures.map((x, i) => {
                      const key = `${x.kind}-${Math.round(x.startDistance)}`;
                      const isActive = highlightedStructureKey === key;
                      return (
                        <li key={`${x.kind}-${i}`}>
                          {/*
                            * A button, not a div with a click handler: these rows are the
                            * clearance-critical part of the panel, so they need keyboard
                            * focus and Enter/Space for free.
                            */}
                          <button
                            type="button"
                            className={`rs rs-${x.kind} rs-btn ${isActive ? 'rs-active' : ''}`}
                            onClick={() => onSelectStructure?.(x, key)}
                            title="Show this on the map"
                          >
                            <span className="rs-glyph" aria-hidden="true">
                              {x.kind === 'tunnel' ? '◠' : '⌒'}
                            </span>
                            <span className="rs-name">
                              {x.name || (x.kind === 'tunnel' ? 'Tunnel' : 'Bridge')}
                            </span>
                            <span className="rs-at">
                              {x.startDistance < 1000
                                ? `${Math.round(x.startDistance / 10) * 10} m`
                                : `${(x.startDistance / 1000).toFixed(1)} km`}
                              {/*
                                * Length is only shown when it exceeds the detection
                                * resolution, and is marked approximate. Reporting "122 m"
                                * off a 25 m sampling step would be false precision.
                                */}
                              {x.lengthM > (x.resolutionM || 25) * 2
                                ? ` · ~${Math.round(x.lengthM / 50) * 50} m long`
                                : ''}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* task 7: avoidance toggles + what the route is actually made of. */}
              {avoidOptions?.length > 0 && (
                <details className="avoid-block">
                  <summary>Avoid road types</summary>
                  <ul className="avoid-list">
                    {avoidOptions.map((o) => (
                      <li key={o.id}>
                        <label className={`avoid-row ${o.supported ? '' : 'avoid-row-off'}`}>
                          <input
                            type="checkbox"
                            checked={Boolean(avoid?.includes(o.id))}
                            disabled={!o.supported}
                            onChange={() =>
                              onAvoidChange?.(
                                avoid?.includes(o.id)
                                  ? avoid.filter((x) => x !== o.id)
                                  : [...(avoid || []), o.id],
                              )
                            }
                          />
                          <span>{o.label}</span>
                          {/*
                            * Shown but disabled, with the reason. Hiding it would leave a
                            * planner assuming a bridge-free route is possible; faking it
                            * would be worse.
                            */}
                          {!o.supported && <em className="avoid-why">{o.reason}</em>}
                        </label>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {composition?.types && (
                <details className="comp-block">
                  <summary>
                    Route makeup
                    {composition.types[0] ? ` · ${composition.types[0].label} ${composition.types[0].percent}%` : ''}
                  </summary>
                  <ul className="comp-list">
                    {composition.types.map((t) => (
                      <li key={t.type} className="comp-row">
                        <span className="comp-label">{t.label}</span>
                        <span className="comp-bar" aria-hidden="true">
                          <span style={{ width: `${Math.min(100, t.percent)}%` }} />
                        </span>
                        <span className="comp-val">
                          {t.percent}% · {(t.meters / 1000).toFixed(1)} km
                        </span>
                      </li>
                    ))}
                  </ul>
                  {composition.unreported?.length > 0 && (
                    <p className="comp-note">
                      None on this route: {composition.unreported.join(', ')}.
                    </p>
                  )}
                  <p className="comp-note">{composition.note}</p>
                </details>
              )}

              {/*
                * "Mission planning", not "navigation": this runs an animated fly-through
                * of the planned route, not live turn-by-turn guidance. Calling it
                * navigation invited a defence audience to assume in-vehicle guidance,
                * which is a promise the demo cannot keep.
                */}
              <button type="button" className="btn-primary btn-go" onClick={onGo}>
                Start mission planning
              </button>
            </>
          )}
        </Section>

        <Section id="view" title="Basemap & view" open={open.view} onToggle={toggle}>
          <ViewToggles
            basemap={basemap}
            view={view}
            exaggeration={exaggeration}
            satelliteAvailable={satelliteAvailable}
            buildingsAvailable={buildingsAvailable}
            terrainAvailable={terrainAvailable}
            onBasemapChange={onBasemapChange}
            onViewChange={onViewChange}
            onExaggerationChange={onExaggerationChange}
          />
          {trafficControl}
        </Section>

        <Section id="layers" title="Layers" open={open.layers} onToggle={toggle}>
          {layersPanel}
        </Section>

        {/* Timeline only means something over imagery. */}
        <Section
          id="timeline"
          title="Imagery timeline"
          open={open.timeline}
          onToggle={toggle}
          hidden={basemap !== 'satellite'}
        >
          {timelinePanel}
        </Section>

        {/* Elevation appears whenever a route exists, in any basemap/view state. */}
        <Section
          id="elevation"
          title="Elevation"
          open={open.elevation}
          onToggle={toggle}
          hidden={!features.length}
        >
          {elevationPanel}
        </Section>
      </div>
    </aside>
  );
}
