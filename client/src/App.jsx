import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MapView from './components/MapView.jsx';
import MapControls from './components/MapControls.jsx';
import PoiPanel from './components/PoiPanel.jsx';
import SearchBar from './components/SearchBar.jsx';
import PlaceCard from './components/PlaceCard.jsx';
import Sidebar from './components/Sidebar.jsx';
import ViewToggles from './components/ViewToggles.jsx';
import NavigateView from './components/NavigateView.jsx';
import ElevationProfile from './components/ElevationProfile.jsx';
import TimeControl from './components/TimeControl.jsx';
import RoutePanel from './components/RoutePanel.jsx';
import {
  fetchCapabilities,
  fetchConfig,
  fetchImageryMeta,
  fetchImageryProvenance,
  fetchCaptures,
  fetchPoiLayers,
  fetchPois,
  fetchPoisAlongRoute,
  fetchProfiles,
  fetchTrafficIncidents,
  fetchTerrainMeta,
  fetchTrafficMeta,
  requestChangeDetection,
  requestRoute,
  reverseGeocode,
} from './api.js';
import { isGeolocationAvailable, locateUser } from './lib/locate.js';
import {
  buildRouteIndex,
  distanceBetween,
  nextManeuver,
  progressSummary,
  splitRoute,
} from './lib/navigation.js';
import { sampleRouteElevation, steepSegmentsToGeoJSON } from './lib/elevationProfile.js';
import { useVehicleMotion } from './hooks/useVehicleMotion.js';
import { CAMERA_MODES, NAV_ZOOM } from './lib/cameraController.js';
import {
  ROLLING_AHEAD_METERS,
  createRollingPrefetch,
  prefetchStartBuffer,
} from './lib/tilePrefetch.js';
import { useVoiceGuidance } from './hooks/useVoiceGuidance.js';

/**
 * Retry a fetch a few times before giving up. Overlay metadata resolves once at
 * startup, so a single hiccup would otherwise disable a layer for the whole
 * session with no visible reason.
 */
async function retry(fn, attempts = 3, delayMs = 600) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.name === 'AbortError') return null;
      if (i === attempts - 1) return null;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  return null;
}

/**
 * Category presets. "Convoy mobility" is the set that actually bears on moving a
 * heavy vehicle — the corridors, fuel, logistics and medical support along a route
 * — as opposed to the full critical-infrastructure picture.
 */
/**
 * Convoy essentials: the layers that bear on moving a heavy vehicle. Only layers
 * with a verified source can be selected, so this list is intersected with what
 * actually resolved at build time.
 */
const CONVOY_PRESET = ['fuel', 'medical', 'logistics', 'parking', 'maritime', 'airfields'];

/** Starting values for the custom profile — a plausible heavy rig. */
const DEFAULT_CUSTOM = {
  weightKg: 44000,
  axleWeightKg: 11500,
  lengthM: 18.75,
  widthM: 2.55,
  heightM: 4.2,
};

export default function App() {
  const [config, setConfig] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [profileData, setProfileData] = useState(null);
  const [error, setError] = useState(null);
  const [mapReady, setMapReady] = useState(false);

  const [profileId, setProfileId] = useState('heavy-truck');
  const [custom, setCustom] = useState(DEFAULT_CUSTOM);
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState(null);
  const [picking, setPicking] = useState(null);

  const [routeData, setRouteData] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [routeLoading, setRouteLoading] = useState(false);
  const [mapCenter, setMapCenter] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [locating, setLocating] = useState(isGeolocationAvailable());
  const [flyTo, setFlyTo] = useState(null);

  // Overlays
  const [imageryMeta, setImageryMeta] = useState(null);
  const [trafficMeta, setTrafficMeta] = useState(null);
  /*
   * The user makes exactly two orthogonal choices; the renderer is derived from the
   * combination. This replaced a 3-state cycle (2D → 3D-buildings → 3D-terrain) that
   * asked the user to arbitrate a rendering conflict the app can settle itself.
   *
   *   basemap 'map'       + view '3d' → extruded buildings
   *   basemap 'satellite' + view '3d' → imagery draped, NO extrusions
   *
   * Satellite and Map being one choice makes satellite-plus-buildings unreachable,
   * so the doubled-building artifact is impossible by construction rather than
   * prevented by a rule.
   */
  const [basemap, setBasemap] = useState('map');
  const [view, setView] = useState('2d');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  /*
   * Derived render state. Declared here, above every effect that reads it — putting
   * these lower in the component body throws a temporal-dead-zone error at render,
   * which blanks the whole app.
   */
  const imageryOn = basemap === 'satellite';
  const is3D = view === '3d';
  /** Buildings only on the vector base: this is what prevents doubled buildings. */
  const buildings3D = basemap === 'map' && is3D;
  const [trafficOn, setTrafficOn] = useState(false);

  const [incidents, setIncidents] = useState(null);
  const [bounds, setBounds] = useState(null);
  const [congestionCount, setCongestionCount] = useState(0);
  const [zoom, setZoom] = useState(null);
  const [provenance, setProvenance] = useState(null);
  /*
   * Imagery mode. Initialised from the server's DEFAULT_IMAGERY_MODE so flipping
   * the app default is a one-line server change; the toggle overrides it for this
   * session only, with no persistence.
   */
  /*
   * POI layers.
   *
   * Definitions (including which layers have no data source) come from the server's
   * build-time verified allowlist. Which layers start on is the server's decision
   * too — fuel + medical — so it is not duplicated here.
   *
   * On by default because the toggle sits low in the panel and is easy to miss: an
   * empty map then reads as broken, and the basemap's own park and district labels
   * get mistaken for our POIs.
   */
  /*
   * One screen, four modes — BROWSE / PLACE / DIRECTIONS / NAVIGATE.
   *
   * A single `mode` value rather than a set of booleans: the modes are mutually
   * exclusive, and booleans would allow impossible combinations like a place card
   * open during navigation.
   */
  const [mode, setMode] = useState('browse');
  const [place, setPlace] = useState(null);
  const [placePreview, setPlacePreview] = useState(null);
  const [placePreviewLoading, setPlacePreviewLoading] = useState(false);


  // Navigation
  const [navSource, setNavSource] = useState('simulated');
  const [speedMultiplier, setSpeedMultiplier] = useState(1);
  const [followCamera, setFollowCamera] = useState(true);
  /*
   * Bumped when the user presses Re-centre. A counter rather than a boolean so
   * repeated presses each trigger exactly one camera move.
   */
  const [recenterRequest, setRecenterRequest] = useState(0);

  // Terrain
  const [terrainMeta, setTerrainMeta] = useState(null);
  const [terrainReady, setTerrainReady] = useState(false);
  const [exaggeration, setExaggeration] = useState(1.4);
  /*
   * Hillshade ON by default.
   *
   * This was off, and it was the real reason terrain "did not show up until you were
   * zoomed right in": the DEM was loaded and exaggerated the whole time, but a flat
   * vector basemap gives the eye no light or shadow to read height from, so correct
   * geometry still looked flat. Only when zoomed in far enough for the horizon and
   * perspective to give the cue did it appear. Shading is what makes relief visible,
   * so it should not be something you have to find and switch on.
   */
  const [hillshadeOn, setHillshadeOn] = useState(true);
  /*
   * Two distinct 3D looks, mutually exclusive:
   *   'terrain'   — satellite draped over the DEM. Right for hills.
   *   'buildings' — vector base with extruded buildings. Right for flat cities,
   *                 where a tilted photo alone shows no relief at all.
   * Buildings force imagery off to avoid the doubled-rooftop artifact.
   */
  const [buildingsAvailable, setBuildingsAvailable] = useState(false);
  const [elevProfile, setElevProfile] = useState(null);
  const mapRef2 = useRef(null);

  /*
   * Temporal model: one time axis for imagery and elevation. `captureDate` pins the
   * imagery render; null means "latest".
   */
  const [captures, setCaptures] = useState(null);
  const [capturesLoading, setCapturesLoading] = useState(false);
  const [captureDate, setCaptureDate] = useState(null);
  const [compareFrom, setCompareFrom] = useState(null);
  const [changeResult, setChangeResult] = useState(null);
  const [changeBusy, setChangeBusy] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  /** Camera mode is a preference, so it survives a reload. */
  const [cameraMode, setCameraMode] = useState(
    () => localStorage.getItem('convoyCameraMode') || CAMERA_MODES.FOLLOW,
  );
  const [prefetch, setPrefetch] = useState(null);

  const [poiLayerDefs, setPoiLayerDefs] = useState(null);
  /** Which POI layer is currently being pointed out on the map, if any. */
  const [highlightedPoiLayer, setHighlightedPoiLayer] = useState(null);
  /** One-shot camera fit request: { bounds, token }. */
  const [fitBounds, setFitBounds] = useState(null);
  /** Bridges/tunnels extracted server-side, for zooms below the tile floor. */
  const [extractedStructures, setExtractedStructures] = useState(null);
  /** Structures along the active route — fetched once per route, shown at any zoom. */
  const [routeStructureLines, setRouteStructureLines] = useState(null);
  /*
   * Bridges & tunnels come from the basemap road data, not from POIs, so there is no
   * fetch to wait on and nothing to rate-limit — which is why this one can default to
   * ON without slowing first load. A toggle is still offered for decluttering.
   */
  const [structuresOn, setStructuresOn] = useState(
    () => localStorage.getItem('convoyStructures') !== 'off',
  );
  const [routeStructures, setRouteStructures] = useState([]);
  const [poiOn, setPoiOn] = useState(true);
  const [poiSelected, setPoiSelected] = useState([]);
  const [poiData, setPoiData] = useState(null);
  const [poiLoading, setPoiLoading] = useState(false);
  // 8.05 km = 5 miles either side of the route; the server is the authority.
  const [corridorKm, setCorridorKm] = useState(8.05);

  const [imageryMode, setImageryMode] = useState(null);
  // What is actually rendered: seamless falls back to latest where no mosaic exists.
  const [effectiveImageryMode, setEffectiveImageryMode] = useState(null);
  const [fellBack, setFellBack] = useState(false);

  /* ---------------------------------------------------------- bootstrap */
  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const [cfg, profs, imagery, traffic, poiMeta, terrain] = await Promise.all([
          fetchConfig({ signal: ctl.signal }),
          fetchProfiles({ signal: ctl.signal }),
          /*
           * Overlay metadata is enrichment, so a failure must not stop the map —
           * but it must not silently kill the layer either. A single transient
           * failure (e.g. the page loaded while the server was restarting) used to
           * leave `imageryMeta` null forever, which disables the Imagery button
           * with no explanation. Retry, and the toggle re-fetches on demand too.
           */
          retry(() => fetchImageryMeta({ signal: ctl.signal })),
          retry(() => fetchTrafficMeta({ signal: ctl.signal })),
          retry(() => fetchPoiLayers({ signal: ctl.signal })),
          retry(() => fetchTerrainMeta({ signal: ctl.signal })),
        ]);
        setConfig(cfg);
        setProfileData(profs);
        setImageryMeta(imagery);
        setTrafficMeta(traffic);
        if (terrain) {
          setTerrainMeta(terrain);
          if (terrain.defaultExaggeration) setExaggeration(terrain.defaultExaggeration);
        }
        if (poiMeta?.layers) {
          setPoiLayerDefs(poiMeta.layers);
          if (poiMeta.corridorKmDefault) setCorridorKm(poiMeta.corridorKmDefault);
          // Defaults come from the server (fuel + medical), never hard-coded here,
          // and only layers with a verified source can be switched on.
          setPoiSelected(poiMeta.layers.filter((l) => l.hasSource && l.defaultOn).map((l) => l.id));
        }
        if (imagery?.defaultMode) {
          setImageryMode(imagery.defaultMode);
          setEffectiveImageryMode(imagery.defaultMode);
        }
        setMapCenter({ lat: cfg.map.center[1], lon: cfg.map.center[0] });
        setCapabilities(await fetchCapabilities({ signal: ctl.signal }));
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message);
      }
    })();
    return () => ctl.abort();
  }, []);

  /* ------------------------------------------------------- user location */
  /*
   * Start from where the user actually is, so the demo is usable anywhere rather
   * than anchored to one city. Geolocation is best-effort: if it is refused or
   * unavailable the map simply stays at the configured fallback centre and the
   * user sets both points themselves.
   */
  useEffect(() => {
    if (!isGeolocationAvailable()) return;
    let cancelled = false;

    (async () => {
      const here = await locateUser();
      if (cancelled) return;
      setLocating(false);
      if (!here) return;

      setFlyTo({ lat: here.lat, lon: here.lon, zoom: 12 });
      setMapCenter({ lat: here.lat, lon: here.lon });

      // Seed the start so the user only has to choose a destination.
      const provisional = { lat: here.lat, lon: here.lon, label: 'Your location' };
      setStart(provisional);
      try {
        const { label } = await reverseGeocode({ lat: here.lat, lon: here.lon });
        if (!cancelled) setStart({ lat: here.lat, lon: here.lon, label });
      } catch {
        /* keep the generic label */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------------------------- route recalculation */
  // Ignore results from a superseded request so fast profile switching cannot
  // leave a stale route on screen.
  const routeSeq = useRef(0);

  useEffect(() => {
    if (!start || !end) {
      setRouteData(null);
      return;
    }
    const seq = ++routeSeq.current;
    const ctl = new AbortController();
    setRouteLoading(true);
    setError(null);

    requestRoute(
      { start, end, profileId, custom: profileId === 'custom' ? custom : undefined },
      { signal: ctl.signal },
    )
      .then((data) => {
        if (seq !== routeSeq.current) return;
        setRouteData(data);
        setSelectedIndex(0);
      })
      .catch((err) => {
        if (err.name === 'AbortError' || seq !== routeSeq.current) return;
        setRouteData(null);
        setError(err.message);
      })
      .finally(() => {
        if (seq === routeSeq.current) setRouteLoading(false);
      });

    return () => ctl.abort();
  }, [start, end, profileId, custom]);

  /* --------------------------------------------------- traffic incidents */
  /*
   * Fetched for the visible area, and only while the traffic layer is on, so
   * turning traffic off stops the polling too. Debounced because panning fires
   * `moveend` repeatedly and this key is rate-limited.
   */
  useEffect(() => {
    if (!trafficOn || !bounds) {
      if (!trafficOn) setIncidents(null);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetchTrafficIncidents(bounds, { signal: ctl.signal })
        .then(setIncidents)
        .catch((err) => {
          if (err.name !== 'AbortError') setIncidents(null);
        });
    }, 400);

    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [trafficOn, bounds]);

  /* ------------------------------------------------- imagery provenance */
  /*
   * Only while the imagery layer is on, and debounced — this answers "how current
   * is the imagery on screen?" and must not cost a vendor call per pan frame.
   */
  useEffect(() => {
    if (!imageryOn || !bounds || !imageryMeta?.available || !imageryMode) {
      if (!imageryOn) setProvenance(null);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetchImageryProvenance(bounds, imageryMode, { signal: ctl.signal })
        .then((r) => {
          setProvenance(r.provenance);
          // The server decides the effective mode; rendering follows it so the
          // overlay is never blank where no mosaic exists.
          setEffectiveImageryMode(r.effectiveMode || imageryMode);
          setFellBack(Boolean(r.fellBack));
        })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            setProvenance(null);
            setEffectiveImageryMode(imageryMode);
            setFellBack(false);
          }
        });
    }, 500);

    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [imageryOn, bounds, imageryMeta, imageryMode]);

  // The highlight is a gesture, not a mode: it fades on its own.
  useEffect(() => {
    if (!highlightedPoiLayer) return;
    const id = setTimeout(() => setHighlightedPoiLayer(null), 6000);
    return () => clearTimeout(id);
  }, [highlightedPoiLayer]);

  /*
   * Below zoom 12 the basemap tiles no longer carry bridge/tunnel attributes, so the
   * client cannot draw them from the tiles it already has. /api/structures reads deeper
   * tiles server-side and returns just the geometry. Fetched only in the band where it
   * is both needed and affordable (z9.5 to z12); above z12 the free tile path is used and
   * this stays untouched.
   */
  useEffect(() => {
    if (!structuresOn || !bounds || zoom == null) return;
    if (zoom >= 12 || zoom < 9.5) {
      setExtractedStructures(null);
      return;
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => {
      const [w, s2, e, n] = bounds;
      fetch(`/api/structures?bbox=${w.toFixed(4)},${s2.toFixed(4)},${e.toFixed(4)},${n.toFixed(4)}&zoom=${zoom.toFixed(1)}`,
        { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((fc) => {
          if (fc) setExtractedStructures(fc);
        })
        .catch((err) => {
          if (err.name !== 'AbortError') console.warn('[structures]', err.message);
        });
    }, 400);

    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [structuresOn, bounds, zoom]);

  /* ------------------------------------------------------------- POI layers */
  /*
   * With an active route, POIs come from search-along-route inside the convoy
   * corridor, so what is shown is relevant to the path rather than to the window.
   * With no route, fall back to a viewport category browse. Either way the query
   * carries category ids only — never free text.
   */
  /*
   * Route points to POST for corridor queries.
   *
   * A 469 km alternative arrives as ~9,000 coordinates, about 450 KB of JSON, which
   * exceeded the server's body limit and returned 413 — so that alternative silently
   * showed zero POIs while the shorter ones worked. Corridor membership is measured
   * against an 8 km buffer, so points every few hundred metres add nothing: 600 points
   * over 469 km is a sample every ~780 m, far finer than the buffer it feeds.
   */
  const MAX_CORRIDOR_POINTS = 600;
  const corridorPoints = useCallback((coords) => {
    if (!coords?.length) return [];
    if (coords.length <= MAX_CORRIDOR_POINTS) return coords.map(([lon, lat]) => ({ lat, lon }));
    const step = (coords.length - 1) / (MAX_CORRIDOR_POINTS - 1);
    const out = [];
    for (let i = 0; i < MAX_CORRIDOR_POINTS; i++) {
      const [lon, lat] = coords[Math.round(i * step)];
      out.push({ lat, lon });
    }
    return out;
  }, []);

  const selectedRouteCoords = useMemo(
    () =>
      routeData?.routes?.features?.find((f) => f.properties.index === (selectedIndex ?? 0))
        ?.geometry?.coordinates || null,
    [routeData, selectedIndex],
  );

  /*
   * Identity of the route the POI corridor was fetched for.
   *
   * This is the fix for alternatives not refreshing their POIs. The fetch key used to be
   * just `layers|route:corridorKm`, which carries no information about WHICH route — so
   * switching primary <-> alternative produced an identical key, the "already fetched"
   * guard matched, and the request was skipped. The POIs stayed on the previous
   * alternative's corridor.
   *
   * The same flaw silently affected changing the origin or destination: index 0 stays 0,
   * so that key matched too and the corridor was never refetched for the new route.
   *
   * Fingerprint rather than index alone: the index is stable across different routes, so
   * it cannot detect a new origin/destination on its own. Point count plus the rounded
   * endpoints changes for any genuinely different geometry and is O(1) to compute.
   */
  const selectedRouteKey = useMemo(() => {
    const c = selectedRouteCoords;
    if (!c?.length) return null;
    const at = (i) => `${c[i][0].toFixed(4)},${c[i][1].toFixed(4)}`;
    return `${selectedIndex ?? 0}:${c.length}:${at(0)}:${at(c.length - 1)}`;
  }, [selectedRouteCoords, selectedIndex]);

  /*
   * Structures along the active route. Fetched once per route — NOT on pan or zoom,
   * because a corridor does not depend on where the camera is looking.
   */
  useEffect(() => {
    // tweak: no longer gated on `structuresOn` — the "On this route" list is useful
    // even when the map layer is decluttered off. Visibility of the LINES is still
    // controlled by the toggle in MapView.
    if (!selectedRouteCoords?.length) {
      setRouteStructureLines(null);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch('/api/structures/along-route', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          route: corridorPoints(selectedRouteCoords),
          corridorM: 1200,
        }),
        signal: ctl.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((fc) => {
          if (fc) setRouteStructureLines(fc);
        })
        .catch((err) => {
          if (err.name !== 'AbortError') console.warn('[structures/route]', err.message);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [structuresOn, selectedRouteCoords]);

  /*
   * ── Why this is not simply "fetch on every bounds change" ────────────────
   * It was, and dragging the map felt like it: every pan fired a request, the whole
   * feature set was replaced, and the icons blinked out and back. Three fixes, in order
   * of how much they matter:
   *
   *  1. Fetch a PADDED box, then skip the request entirely while the viewport stays
   *     inside what was already fetched. Small and medium pans now need no request at
   *     all — the POIs just stay put, which is the behaviour that actually feels right.
   *  2. With a route active the query is search-along-route and does not depend on the
   *     viewport at all, so panning must not refetch it. Previously it did, on every
   *     single moveend, re-requesting an identical result.
   *  3. Never clear what is on screen. The old code replaced the data on failure and on
   *     every new request, so a transient error emptied the map.
   */
  const poiFetchRef = useRef({ box: null, key: null, zoom: null });
  /*
   * Key of the most recently STARTED POI request.
   *
   * Needed because switching alternatives fires a new corridor fetch while the previous
   * one may still be in flight, and the two take very different times — a 271 km
   * alternative sweeps far more samples than a 160 km one. Without this, whichever
   * response happens to land last wins, so the map could end up showing the POIs of a
   * route the user already switched away from. Measured exactly that: two different
   * geometries posted, identical POI set displayed.
   */
  const poiInFlightRef = useRef(null);

  useEffect(() => {
    if (!poiOn || !poiSelected.length) {
      setPoiData(null);
      poiFetchRef.current = { box: null, key: null, zoom: null };
      return;
    }
    if (!selectedRouteCoords && !bounds) return;

    // Identifies the query apart from the viewport.
    const key = `${[...poiSelected].sort().join(',')}|${selectedRouteKey ? `route:${corridorKm}:${selectedRouteKey}` : 'view'}`;
    const prev = poiFetchRef.current;

    if (key === prev.key) {
      // Route mode: viewport is not an input, so nothing to do.
      if (selectedRouteCoords) return;
      /*
       * Browse mode: skip only if the view is still covered AND at a similar scale.
       *
       * "Covered" alone is not enough, and assuming it was is what left cities empty.
       * The per-layer cap is spent across whatever area was requested, so a box fetched
       * at z9 holds POIs scattered over a whole region; zooming to a city inside that
       * box is still "covered" while containing almost nothing. Zooming in by more than
       * a level therefore has to refetch, because the same cap now buys far more detail.
       */
      if (prev.box && bounds && prev.zoom != null && zoom != null) {
        const [w, s2, e, n] = bounds;
        const [W, S, E, N] = prev.box;
        const covered = w >= W && s2 >= S && e <= E && n <= N;
        const similarScale = zoom <= prev.zoom + 1;
        if (covered && similarScale) return;
      }
    }

    /*
     * Pad the request beyond the visible window so there is fresh data ready just off
     * screen.
     *
     * Reduced from 45% to 25%. Padding is not free: the per-layer cap is spent over the
     * whole requested box, so a big pad thins out the POIs actually visible on screen.
     * 25% still absorbs ordinary small pans without a request.
     */
    const padded = bounds
      ? (() => {
          const [w, s2, e, n] = bounds;
          const dx = (e - w) * 0.25;
          const dy = (n - s2) * 0.25;
          return [
            Math.max(-180, w - dx),
            Math.max(-85, s2 - dy),
            Math.min(180, e + dx),
            Math.min(85, n + dy),
          ];
        })()
      : null;

    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setPoiLoading(true);
      const request = selectedRouteCoords
        ? fetchPoisAlongRoute(
            {
              route: corridorPoints(selectedRouteCoords),
              layers: poiSelected,
              corridorKm,
            },
            { signal: ctl.signal },
          )
        : fetchPois(padded, poiSelected, { signal: ctl.signal });

      poiInFlightRef.current = key;
      request
        .then((data) => {
          // Ignore a response that has been superseded — see poiInFlightRef.
          if (poiInFlightRef.current !== key) return;
          setPoiData(data);
          poiFetchRef.current = { box: selectedRouteCoords ? null : padded, key, zoom };
        })
        .catch((err) => {
          // Keep whatever is already drawn; an empty map is worse than stale POIs.
          if (err.name !== 'AbortError') console.warn('[pois]', err.message);
        })
        .finally(() => setPoiLoading(false));
    }, 350);

    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [poiOn, poiSelected, bounds, zoom, selectedRouteCoords, selectedRouteKey, corridorKm, corridorPoints]);

  /**
   * "Show me these" — frames the POIs of one layer and marks them.
   *
   * Counts are computed from the loaded features, so the same features can be used to
   * fit the camera; there is nothing to re-fetch. The highlight clears itself, because
   * a marker that stays on forever stops meaning "these ones".
   */
  /**
   * "Show me these" — highlight the layer's POIs, in place.
   *
   * Deliberately does NOT move the camera when any of them are already on screen. It used
   * to fit the bounds of every feature in the layer, which meant clicking the count while
   * zoomed into a city threw the view back out to the whole region — the opposite of what
   * you want when you are asking "which of these on my screen are the fuel stations".
   * The camera only moves when none are visible, which is the one case where a highlight
   * on its own would appear to do nothing.
   */
  /*
   * tweak: the "On this route" list, sourced from the server's along-route extraction.
   *
   * The existing list (`routeStructures`) comes from scanning what the map has RENDERED,
   * which only works at zoom 12+ and only while the layer is visible — so on a wide Alps
   * view it was always empty. The server extraction is zoom-independent and already
   * fetched, so it is used whenever the rendered scan comes up short. Additive: the
   * original path still wins when it has more detail.
   */
  const routeStructureList = useMemo(() => {
    if (routeStructures?.length) return routeStructures;
    const feats = routeStructureLines?.features || [];
    if (!feats.length) return routeStructures || [];

    /*
     * Only structures worth listing. The raw extraction returns everything — 871 on the
     * Emmen to Locarno route, mostly 15 m field bridges — which is a list nobody reads.
     * A convoy planner cares about the long spans and the ones on major roads.
     */
    const MAJOR = ['motorway', 'trunk', 'primary'];
    const significant = feats.filter((f) => {
      const p = f.properties || {};
      return Number(p.length_m) >= 100 || MAJOR.includes(p.category);
    });

    const byKey = new Map();
    for (const f of significant) {
      const p = f.properties || {};
      const kind = p.kind === 'tunnel' || p.tunnel === true ? 'tunnel' : 'bridge';
      const startDistance = Number(p.distance_m) || 0;
      // Merge fragments of the same structure: same kind, same name, within 250 m.
      const key = `${kind}:${(p.name || '').toLowerCase()}:${Math.round(startDistance / 250)}`;
      const prev = byKey.get(key);
      const lengthM = Number(p.length_m) || 0;
      if (prev) {
        /*
         * MAX, not sum. A dual carriageway arrives as two parallel segments of the same
         * structure, so adding them reported a 3.3 km bridge where the real span is
         * ~1.1 km. The longest fragment is the better estimate of the structure itself.
         */
        prev.lengthM = Math.max(prev.lengthM, lengthM);
        continue;
      }
      byKey.set(key, {
        kind,
        name: p.name || null,
        startDistance,
        endDistance: startDistance,
        lengthM,
        resolutionM: 50,
        coord: (f.geometry.type === 'MultiLineString'
          ? f.geometry.coordinates[0]?.[0]
          : f.geometry.coordinates?.[0]) || null,
      });
    }
    // Capped so the panel stays readable; the map still shows every structure.
    return [...byKey.values()]
      .sort((a, b) => a.startDistance - b.startDistance)
      .slice(0, 40);
  }, [routeStructures, routeStructureLines]);

  const handleLocatePoiLayer = useCallback(
    (layerId) => {
      const feats = (poiData?.features || []).filter((f) => f.properties?.layer === layerId);
      if (!feats.length) return;

      const inView = bounds
        ? feats.filter((f) => {
            const [lon, lat] = f.geometry.coordinates;
            return lon >= bounds[0] && lat >= bounds[1] && lon <= bounds[2] && lat <= bounds[3];
          })
        : feats;

      setHighlightedPoiLayer(layerId);

      // Already visible: just mark them and leave the view exactly where it is.
      if (inView.length) return;

      let west = 180;
      let south = 90;
      let east = -180;
      let north = -90;
      for (const f of feats) {
        const [lon, lat] = f.geometry.coordinates;
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
      setFitBounds({ bounds: [west, south, east, north], token: Date.now() });
    },
    [poiData, bounds],
  );

  const handleTogglePoiLayer = useCallback(
    (id) => {
      const def = poiLayerDefs?.find((l) => l.id === id);
      if (!def?.hasSource) return; // no-source layers are never queried
      setPoiSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    },
    [poiLayerDefs],
  );

  const handlePoiPreset = useCallback(
    (preset) => {
      const available = (poiLayerDefs || []).filter((l) => l.hasSource).map((l) => l.id);
      if (preset === 'all') setPoiSelected(available);
      else if (preset === 'none') setPoiSelected([]);
      else setPoiSelected(CONVOY_PRESET.filter((id) => available.includes(id)));
    },
    [poiLayerDefs],
  );

  /* ----------------------------------------------------- temporal captures */
  useEffect(() => {
    if (!bounds) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setCapturesLoading(true);
      fetchCaptures(bounds, { signal: ctl.signal })
        .then(setCaptures)
        .catch((err) => {
          if (err.name !== 'AbortError') setCaptures(null);
        })
        .finally(() => setCapturesLoading(false));
    }, 900);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [bounds]);

  /** Newest renderable capture — the implicit "to" when the slider has not moved. */
  const latestCapture = captures?.captures?.find((c) => c.available)?.datetime || null;

  const handleCompare = useCallback(async () => {
    // `to` defaults to the latest capture: requiring the user to move the slider
    // before Compare becomes usable is a trap, since "now vs then" is the common case.
    const to = captureDate || latestCapture;
    if (!bounds || !compareFrom || !to) return;
    setChangeBusy(true);
    try {
      // Hits the real endpoint; it answers 501 with a ChangeResult while stubbed.
      const result = await requestChangeDetection({ aoi: bounds, from: compareFrom, to });
      setChangeResult(result);
    } catch (err) {
      setChangeResult({ implemented: false, summary: `Change detection failed: ${err.message}` });
    } finally {
      setChangeBusy(false);
    }
  }, [bounds, compareFrom, captureDate, latestCapture]);

  /* --------------------------------------------------------- navigation */
  const selectedFeature =
    routeData?.routes?.features?.find((f) => f.properties.index === (selectedIndex ?? 0)) || null;

  // Rebuilt only when the geometry changes, not on every animation frame.
  const routeIndex = useMemo(
    () => (selectedFeature ? buildRouteIndex(selectedFeature.geometry.coordinates) : null),
    [selectedFeature],
  );

  /* ------------------------------------------------------ elevation profile */
  /*
   * Sampled from the loaded DEM via the map, so the profile matches the terrain the
   * map draws. Re-sampled when the route, the vehicle limit or terrain readiness
   * changes; a short delay lets DEM tiles arrive before the first attempt.
   */
  const activeGradeLimit =
    (profileId === 'custom' ? custom : profileData?.profiles?.find((p) => p.id === profileId)?.spec)
      ?.maxGradePercent ?? null;

  useEffect(() => {
    const map = mapRef2.current;
    if (!map || !terrainReady || !selectedFeature) {
      setElevProfile(null);
      return;
    }
    let cancelled = false;
    const attempt = (tries = 0) => {
      if (cancelled) return;
      const result = sampleRouteElevation(map, selectedFeature.geometry.coordinates, {
        maxGradePercent: activeGradeLimit,
      });
      setElevProfile(result);
      // DEM tiles stream in; retry a couple of times before settling.
      if (result?.insufficient && tries < 4) setTimeout(() => attempt(tries + 1), 1200);
    };
    const t = setTimeout(() => attempt(0), 700);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [terrainReady, selectedFeature, activeGradeLimit]);

  const steepGeoJSON = useMemo(
    () => (elevProfile && !elevProfile.insufficient ? steepSegmentsToGeoJSON(elevProfile) : null),
    [elevProfile],
  );

  const navigating = mode === 'navigate';

  const {
    motionRef,
    motion: navPosition,
    gpsError,
    paused,
    setPaused,
    seek,
  } = useVehicleMotion({
    routeIndex,
    travelTimeSeconds: selectedFeature?.properties.travelTimeSeconds,
    profileId,
    active: navigating,
    source: navSource,
    speedMultiplier,
  });

  const maneuver = useMemo(
    () =>
      navigating && navPosition && selectedFeature
        ? nextManeuver(selectedFeature.properties.maneuvers, navPosition.distanceAlong)
        : null,
    [navigating, navPosition, selectedFeature],
  );

  const navProgress = useMemo(
    () =>
      navigating && navPosition && routeIndex
        ? progressSummary({
            index: routeIndex,
            distanceAlong: navPosition.distanceAlong,
            travelTimeSeconds: selectedFeature?.properties.travelTimeSeconds,
          })
        : null,
    [navigating, navPosition, routeIndex, selectedFeature],
  );

  const navSplit = useMemo(
    () =>
      navigating && navPosition && routeIndex
        ? splitRoute(routeIndex, navPosition.distanceAlong)
        : null,
    [navigating, navPosition, routeIndex],
  );

  useVoiceGuidance({ enabled: voiceOn, maneuver, navigating });

  /*
   * Rolling prefetch: keep the next ~1.5 km of road warm while driving, so the vehicle
   * is always entering tiles that already exist.
   *
   * Polled rather than run per frame — tile fetching is not a 60 fps concern, and the
   * function self-skips while a batch is in flight. Fired once immediately so the
   * window starts filling during the entry animation instead of one tick later, which
   * is exactly when the start buffer is running out.
   */
  useEffect(() => {
    if (!navigating || basemap !== 'satellite' || !routeIndex || !selectedFeature) return;
    const ahead = createRollingPrefetch({
      coordinates: selectedFeature.geometry.coordinates,
      cum: routeIndex.cum,
      navZoom: NAV_ZOOM,
      mode: effectiveImageryMode || 'seamless',
      captureDate,
    });
    if (typeof window !== 'undefined') window.__rollingPrefetch = ahead;

    const tick = () => ahead(motionRef.current?.distanceAlong || 0, { aheadMeters: ROLLING_AHEAD_METERS });
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      clearInterval(id);
      if (typeof window !== 'undefined') delete window.__rollingPrefetch;
    };
  }, [navigating, basemap, routeIndex, selectedFeature, effectiveImageryMode, captureDate, motionRef]);

  // Arriving ends the trip on its own, as a nav app does.
  useEffect(() => {
    if (!navigating || !navProgress) return;
    if (navProgress.remainingMeters < 25) {
      setMode('directions');
      setFollowCamera(true);
    }
  }, [navigating, navProgress]);

  /*
   * "Go" warms a SMALL start buffer, then begins immediately.
   *
   * Only the tiles the opening navigation view will show, plus ~800 m of run-up, and
   * bounded three ways (see prefetchStartBuffer) so the wait is ~1-2.5 s rather than a
   * full-route download. Everything beyond that is the rolling window's job. Skipped
   * entirely on the vector basemap, where there is no imagery to warm.
   */
  const startNavigation = useCallback(async () => {
    const feature = routeData?.routes?.features?.find(
      (f) => f.properties.index === (selectedIndex ?? 0),
    );
    if (!feature) return;

    seek(0);
    setPaused(false);
    setFollowCamera(true);

    if (basemap === 'satellite') {
      setPrefetch({ warming: true });
      try {
        const r = await prefetchStartBuffer(feature.geometry.coordinates, {
          navZoom: NAV_ZOOM,
          mode: effectiveImageryMode || 'seamless',
          captureDate,
          cum: routeIndex?.cum || null,
        });
        // Kept for the acceptance tests and for diagnosing a slow start in the field.
        if (typeof window !== 'undefined') window.__startWarm = r;
      } catch {
        /* a failed warm-up must never block the drive */
      }
      setPrefetch(null);
    }

    setMode('navigate');
  }, [routeData, selectedIndex, seek, setPaused, basemap, effectiveImageryMode, captureDate, routeIndex]);

  const endNavigation = useCallback(() => {
    setMode('browse');
    setFollowCamera(true);
    setPaused(false);
  }, [setPaused]);

  /* ---------------------------------------------------- place interactions */
  const openPlace = useCallback(async (p) => {
    setPlace(p);
    setPlacePreview(null);
    setMode('place');
    if (!p.name) {
      try {
        const { label } = await reverseGeocode({ lat: p.lat, lon: p.lon });
        setPlace((cur) => (cur && cur.lat === p.lat ? { ...cur, name: label, address: label } : cur));
      } catch {
        /* keep coordinates */
      }
    }
  }, []);

  const handlePoiClick = useCallback(
    (props, coord) => {
      openPlace({
        lat: coord[1],
        lon: coord[0],
        name: props.name,
        address: props.address,
        tomtomCategory: props.tomtomCategory,
      });
    },
    [openPlace],
  );

  // The place card's ETA: a real constraint-aware route, not a straight-line guess.
  useEffect(() => {
    if (mode !== 'place' || !place || !start) return;
    const ctl = new AbortController();
    setPlacePreviewLoading(true);
    requestRoute(
      {
        start,
        end: { lat: place.lat, lon: place.lon },
        profileId,
        custom: profileId === 'custom' ? custom : undefined,
        maxAlternatives: 0,
      },
      { signal: ctl.signal },
    )
      .then((data) => {
        const f = data.routes.features[0];
        setPlacePreview({
          travelTimeSeconds: f.properties.travelTimeSeconds,
          lengthMeters: f.properties.lengthMeters,
          straightLineMeters: distanceBetween([start.lon, start.lat], [place.lon, place.lat]),
        });
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setPlacePreview(null);
      })
      .finally(() => setPlacePreviewLoading(false));
    return () => ctl.abort();
  }, [mode, place, start, profileId, custom]);

  const goToDirections = useCallback(() => {
    if (place) setEnd({ lat: place.lat, lon: place.lon, label: place.name || place.address });
    setMode('directions');
  }, [place]);

  const goNow = useCallback(() => {
    if (place) setEnd({ lat: place.lat, lon: place.lon, label: place.name || place.address });
    setMode('navigate');
    setFollowCamera(true);
    seek(0);
  }, [place, seek]);

  /* -------------------------------------------------------------- events */
  const handleReady = useCallback(async (map) => {
    setMapReady(true);
    // Kept so the elevation profile can query the loaded DEM directly.
    if (map) mapRef2.current = map;
    try {
      setCapabilities(await fetchCapabilities());
    } catch {
      /* non-fatal */
    }
  }, []);

  const handleMapClick = useCallback(
    async (point) => {
      /*
       * Which field a click fills:
       *   - an explicit "Pick on map" request wins
       *   - otherwise fill the first empty field, so two clicks build a route
       *   - with both already set, plain clicks do nothing; that keeps an
       *     exploratory click from silently destroying a route the user is
       *     presenting. "Clear" or "Pick on map" starts over.
       */
      const which = picking || (!start ? 'start' : !end ? 'end' : null);
      if (!which) return;
      setPicking(null);

      // Show the coordinates immediately, then upgrade to a place name.
      const setter = which === 'start' ? setStart : setEnd;
      setter({ ...point, label: `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` });
      try {
        const { label } = await reverseGeocode(point);
        setter({ ...point, label });
      } catch {
        /* keep the coordinate label */
      }
    },
    [picking, start, end],
  );

  const handleClear = useCallback(() => {
    setStart(null);
    setEnd(null);
    setRouteData(null);
    setPicking(null);
  }, []);

  const handleUseMyLocation = useCallback(async () => {
    setLocating(true);
    const here = await locateUser();
    setLocating(false);
    if (!here) {
      setError('Could not get your location. Set the start by searching or clicking the map.');
      return;
    }
    setFlyTo({ lat: here.lat, lon: here.lon, zoom: 12 });
    setStart({ lat: here.lat, lon: here.lon, label: 'Your location' });
    try {
      const { label } = await reverseGeocode({ lat: here.lat, lon: here.lon });
      setStart({ lat: here.lat, lon: here.lon, label });
    } catch {
      /* keep the generic label */
    }
  }, []);

  /**
   * Turning imagery on also repairs missing metadata.
   *
   * If the startup fetch failed, the layer has no source and the button would be a
   * dead control. Fetching here means a click always either shows imagery or
   * reports why it cannot — never nothing.
   */
  const handleBasemapChange = useCallback(async (next) => {
    setBasemap(next);
    if (next !== 'satellite') return;
    if (imageryMeta?.available) return;

    const meta = await retry(() => fetchImageryMeta(), 2, 400);
    if (meta?.available) {
      setImageryMeta(meta);
      if (meta.defaultMode && !imageryMode) {
        setImageryMode(meta.defaultMode);
        setEffectiveImageryMode(meta.defaultMode);
      }
    } else {
      setBasemap('map');
      setError('Vantor imagery is unavailable — could not load imagery configuration.');
    }
  }, [imageryMeta, imageryMode]);

  const handleCustomChange = useCallback((key, value) => {
    setCustom((c) => ({ ...c, [key]: value === '' ? '' : Number(value) }));
  }, []);

  const handleSwap = useCallback(() => {
    setStart(end);
    setEnd(start);
  }, [start, end]);

  // Vendor status of the basemap style (not the user's Map/Satellite choice).
  const basemapStatus = capabilities?.basemap;
  const usingFallback = basemapStatus && basemapStatus.active !== 'tomtom-orbis';

  const navMode = mode === 'navigate';

  return (
    <div className={`app app-mode-${mode} ${sidebarCollapsed ? 'app-rail' : ''}`}>
      {!navMode && (
        <header className="app-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <div>
              <h1>Convoy App</h1>
              <p className="brand-sub">TomTom routing &amp; traffic × Vantor imagery</p>
            </div>
          </div>
          <div className="header-status">
            <span className={`chip ${mapReady ? 'chip-ok' : 'chip-wait'}`}>
              {mapReady ? 'Map ready' : 'Loading…'}
            </span>
          </div>
        </header>
      )}

      <main className="app-body">
        {/*
          * ONE panel surface. Everything that used to be a floating sheet is a
          * section in here, so nothing can overlap or hide anything else.
          * Hidden only during navigation, which is a deliberate full-screen mode.
          */}
        {!navMode && (
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
            searchBar={
              <SearchBar
                mapCenter={mapCenter}
                layerCount={poiOn ? poiSelected.length : 0}
                onOpenLayers={() => {}}
                onPick={(p) =>
                  openPlace({ lat: p.lat, lon: p.lon, name: p.name, address: p.address })
                }
              />
            }
            origin={start}
            destination={end}
            profiles={profileData?.profiles}
            customLimits={profileData?.customLimits}
            profileId={profileId}
            custom={custom}
            routes={routeData?.routes}
            routeStructures={routeStructureList}
            selectedIndex={selectedIndex}
            routeLoading={routeLoading}
            routeError={error}
            mapCenter={mapCenter}
            onOriginChange={setStart}
            onDestinationChange={setEnd}
            onProfileChange={setProfileId}
            onCustomChange={handleCustomChange}
            onSelectRoute={setSelectedIndex}
            onSwap={handleSwap}
            onClear={handleClear}
            onGo={startNavigation}
            basemap={basemap}
            view={view}
            exaggeration={exaggeration}
            satelliteAvailable={Boolean(imageryMeta?.available)}
            buildingsAvailable={buildingsAvailable}
            terrainAvailable={Boolean(terrainMeta?.available)}
            onBasemapChange={handleBasemapChange}
            onViewChange={setView}
            onExaggerationChange={setExaggeration}
            placeCard={
              mode === 'place' && place ? (
                <PlaceCard
                  place={place}
                  preview={placePreview}
                  previewLoading={placePreviewLoading}
                  onDirections={goToDirections}
                  onGo={goNow}
                  onClose={() => {
                    setPlace(null);
                    setMode('browse');
                  }}
                />
              ) : null
            }
            trafficControl={
              <label className="inline-toggle">
                <input
                  type="checkbox"
                  checked={trafficOn}
                  onChange={() => setTrafficOn((v) => !v)}
                />
                <span>Live traffic {trafficOn && incidents?.features?.length ? `(${incidents.features.length})` : ''}</span>
              </label>
            }
            layersPanel={
              <>
                <label className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={structuresOn}
                    onChange={() => {
                      const next = !structuresOn;
                      setStructuresOn(next);
                      localStorage.setItem('convoyStructures', next ? 'on' : 'off');
                    }}
                  />
                  <span>
                    Bridges &amp; tunnels
                    <em className="toggle-hint">
                      {' '}
                      — every one on the road network
                    </em>
                  </span>
                </label>
                <label className="inline-toggle">
                  <input type="checkbox" checked={poiOn} onChange={() => setPoiOn((v) => !v)} />
                  <span>Show POI layers</span>
                </label>
                {/*
                  * Hill shading. On by default and exposed here because it is what makes
                  * terrain readable — without the light and shadow, correct 3D geometry
                  * still looks flat at anything but close range.
                  */}
                <label className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={hillshadeOn}
                    disabled={!terrainMeta?.available}
                    onChange={() => setHillshadeOn((v) => !v)}
                  />
                  <span>
                    Hill shading{' '}
                    <em className="inline-toggle-hint">— mountain light and shadow</em>
                  </span>
                </label>
                {structuresOn && zoom != null && zoom < 9.5 && (
                  <p className="panel-note panel-note-dim">
                    Below zoom 9.5, bridges and tunnels show only along an active route.
                    TomTom omits these attributes from wide-area tiles, so a whole-country
                    view would need well over a thousand extra tile reads. Plan a route, or
                    zoom in a little.
                  </p>
                )}
                {poiOn && (
                  <PoiPanel
                    layers={poiLayerDefs}
                    selected={poiSelected}
                    counts={poiData?.perLayer}
                    capped={poiData?.capped}
                    enabled
                    loading={poiLoading}
                    mode={poiData?.mode}
                    corridorKm={poiData?.corridorKm || corridorKm}
                    total={poiData?.features?.length || 0}
                    droppedOutOfCategory={poiData?.droppedOutOfCategory || 0}
                    onToggleEnabled={() => setPoiOn((v) => !v)}
                    onToggleLayer={handleTogglePoiLayer}
                    onLocateLayer={handleLocatePoiLayer}
                    highlighted={highlightedPoiLayer}
                    onSelectPreset={handlePoiPreset}
                  />
                )}
              </>
            }
            timelinePanel={
              <TimeControl
                captures={captures?.captures}
                timeRange={captures?.timeRange}
                selected={captureDate}
                latest={latestCapture}
                compareFrom={compareFrom}
                loading={capturesLoading}
                changeResult={changeResult}
                changeBusy={changeBusy}
                onSelect={setCaptureDate}
                onSetCompareFrom={setCompareFrom}
                onCompare={handleCompare}
              />
            }
            elevationPanel={
              <ElevationProfile
                profile={elevProfile}
                vehicleLabel={routeData?.profile?.label || 'this vehicle'}
                gradeLimit={activeGradeLimit}
                unavailableReason={
                  !terrainMeta?.available ? 'No elevation source available for this area.' : null
                }
              />
            }
          />
        )}

        <div className="map-wrap">
          {config ? (
            <MapView
              config={config}
              routeData={routeData}
              selectedIndex={selectedIndex}
              structuresOn={structuresOn}
              extractedStructures={extractedStructures}
              routeStructureLines={routeStructureLines}
              profileLabel={routeData?.profile?.label || null}
              onRouteStructures={setRouteStructures}
              start={start}
              end={end}
              picking={picking}
              flyTo={flyTo}
              onReady={handleReady}
              onError={setError}
              onSelectRoute={setSelectedIndex}
              onMapClick={handleMapClick}
              onCenterChange={setMapCenter}
              onBoundsChange={setBounds}
              onCongestionCount={setCongestionCount}
              onZoomChange={setZoom}
              onPoiClick={handlePoiClick}
              onMapLongPress={openPlace}
              onUserPan={() => navMode && setFollowCamera(false)}
              imageryModes={imageryMeta?.available ? imageryMeta.modes : null}
              activeImageryMode={effectiveImageryMode}
              trafficSource={trafficMeta?.flow?.source || null}
              incidents={incidents}
              imageryOn={imageryOn}
              trafficOn={trafficOn}
              is3D={is3D}
              terrainSourceDef={terrainMeta?.source || config.terrain?.source || null}
              terrainAvailable={Boolean(terrainMeta?.available)}
              exaggeration={exaggeration}
              hillshadeOn={hillshadeOn}
              steepGeoJSON={steepGeoJSON}
              onTerrainReady={setTerrainReady}
              buildings3D={buildings3D}
              onBuildingsAvailable={setBuildingsAvailable}
              captureDate={captureDate}
              poiCategories={poiLayerDefs?.filter((l) => l.hasSource)}
              poiData={poiData}
              poiOn={poiOn && !navMode}
              highlightedPoiLayer={highlightedPoiLayer}
              fitBounds={fitBounds}
              navigating={navMode}
              navSplit={navSplit}
              followCamera={followCamera}
              navSource={navSource}
              recenterRequest={recenterRequest}
              cameraMode={cameraMode}
              profileId={profileId}
              motionRef={motionRef}
            />
          ) : (
            !error && <div className="map-placeholder">Loading configuration…</div>
          )}

          {/* On the map: only things that belong on the map. */}
          {!navMode && (
            <div className="fab-stack">
              {/* Mobile mirrors the two toggles as compact FABs; the panel holds the
                  full versions. One decision, two places to reach it. */}
              <div className="fab-toggles">
                <ViewToggles
                  compact
                  basemap={basemap}
                  view={view}
                  exaggeration={exaggeration}
                  satelliteAvailable={Boolean(imageryMeta?.available)}
                  buildingsAvailable={buildingsAvailable}
                  terrainAvailable={Boolean(terrainMeta?.available)}
                  onBasemapChange={handleBasemapChange}
                  onViewChange={setView}
                  onExaggerationChange={setExaggeration}
                />
              </div>
            </div>
          )}

          {navMode && (
            <NavigateView
              maneuver={maneuver}
              progress={navProgress}
              source={navSource}
              paused={paused}
              speedMultiplier={speedMultiplier}
              gpsError={gpsError}
              offRoute={navPosition?.offRouteMeters > 40 ? navPosition.offRouteMeters : null}
              voiceOn={voiceOn}
              followingCamera={followCamera}
              onTogglePause={() => setPaused((v) => !v)}
              onCycleSpeed={() => setSpeedMultiplier((v) => (v === 1 ? 2 : v === 2 ? 4 : 1))}
              onToggleSource={() => setNavSource((v) => (v === 'simulated' ? 'gps' : 'simulated'))}
              onToggleVoice={() => setVoiceOn((v) => !v)}
              cameraMode={cameraMode}
              onToggleCameraMode={() => {
                const next =
                  cameraMode === CAMERA_MODES.FOLLOW ? CAMERA_MODES.OVERHEAD : CAMERA_MODES.FOLLOW;
                setCameraMode(next);
                localStorage.setItem('convoyCameraMode', next);
              }}
              onRecenter={() => {
                setFollowCamera(true);
                setRecenterRequest((n) => n + 1);
              }}
              onEnd={endNavigation}
            />
          )}

          {prefetch && (
            <div className="prep-overlay" role="status">
              <span className="mini-spinner" aria-hidden="true" />
              <span>Preparing route…</span>
            </div>
          )}

          {poiOn && poiLoading && !navMode && (
            <div className="map-loading" role="status">
              <span className="mini-spinner" aria-hidden="true" />
              Loading POIs…
            </div>
          )}
        </div>
      </main>

      {error && !navMode && (
        <div className="error-toast" role="alert">
          <strong>Problem:</strong> {error}
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
