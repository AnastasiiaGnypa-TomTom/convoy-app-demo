import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  LAYERS,
  bindAlternativeClicks,
  ensureRouteLayers,
  fitToRoute,
  setCongestion,
  setRouteData,
  setSelectedRoute,
} from '../lib/routeLayers.js';
import {
  ensureImageryLayers,
  ensureIncidentLayers,
  ensureTrafficLayer,
  setImageryMode,
  setIncidentData,
  setLayerVisible,
  setTrafficVisible,
} from '../lib/overlays.js';
import {
  bindPoiClicks,
  ensurePoiHighlightLayer,
  ensurePoiLayers,
  raisePoiLayers,
  setPoiData,
  setPoiHighlight,
  setPoiVisible,
} from '../lib/poiLayers.js';
import { createVehiclePuckElement } from '../lib/vehicleIcons.js';
import CameraControls from './CameraControls.jsx'; // ux-camera
import {
  createVehicleMarker,
  ensureNavLayers,
  setNavProgress,
  setNavVisible,
} from '../lib/navLayers.js';
import { CAMERA_MODES, NAV_ZOOM, createCameraController } from '../lib/cameraController.js';
import { applyImageryFirst, restoreStreetStyle } from '../lib/imageryFirstStyle.js';
import { disableBuildings3D, enableBuildings3D, hasBuildingsLayer } from '../lib/buildings3d.js';
import {
  DEM_SOURCE_ID,
  HILLSHADE_LAYER,
  STEEP_LAYER,
  ensureDemSource,
  ensureHillshade,
  ensureSteepLayer,
  effectiveExaggeration,
  setLayerVisibility,
  setSteepData,
} from '../lib/terrainLayers.js';
import { buildRouteIndex } from '../lib/navigation.js';
import {
  bindStructureClicks,
  ensureExtractedLayers,
  raiseRouteStructureLayers,
  ensureRouteStructureLayers,
  setRouteStructureLines,
  setRouteStructureLinesVisible,
  setExtractedStructures,
  setExtractedVisible,
  ensureHighlightLayers,
  raiseHighlightLayers,
  ensureStructureLayers,
  pulseHighlight,
  setHighlightedStructure,
  setStructuresVisible,
  setRouteStructures,
  findRouteStructures,
  routeStructuresToGeoJSON,
} from '../lib/roadStructures.js';

/**
 * The MapLibre canvas plus everything drawn on it.
 *
 * React owns the data; a set of effects reconciles the map to it. The map instance
 * itself lives for the component's lifetime so later steps (imagery overlay,
 * terrain) can attach to an initialised map rather than rebuilding it.
 */
export default function MapView({
  config,
  routeData,
  selectedIndex,
  start,
  end,
  picking,
  flyTo,
  imageryModes,
  activeImageryMode,
  trafficSource,
  incidents,
  imageryOn,
  trafficOn,
  is3D,
  terrainSource,
  poiCategories,
  poiData,
  poiOn,
  highlightedPoiLayer,
  highlightedStructure,
  goTo,
  fitBounds,
  structuresOn,
  extractedStructures,
  routeStructureLines,
  onRouteStructures,
  profileLabel,
  navigating,
  motionRef,
  navSplit,
  followCamera,
  navSource,
  recenterRequest,
  cameraMode,
  profileId,
  terrainSourceDef,
  terrainAvailable,
  exaggeration,
  hillshadeOn,
  steepGeoJSON,
  onTerrainReady,
  onUserPan,
  onMapLongPress,
  onReady,
  onError,
  onSelectRoute,
  onMapClick,
  onCenterChange,
  onBoundsChange,
  onCongestionCount,
  onZoomChange,
  onPoiClick,
  captureDate,
  buildings3D,
  onBuildingsAvailable,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  /*
   * Ready is state, not a ref, on purpose: the route can resolve before the map
   * fires `load` (routinely on mobile, where WebGL init is slower). A ref would
   * let the layer effect bail out and never re-run, leaving the route invisible
   * even though the panel lists it. State re-runs the effect once the map is up.
   */
  const [ready, setReady] = useState(false);
  /** The single camera owner. Nothing else may move the camera. */
  const cameraRef = useRef(null);
  const enteredNavRef = useRef(false);
  /*
   * Distinguishes our own camera moves from the user dragging.
   *
   * Without this, every follow-camera easeTo would look like a user pan and would
   * immediately switch follow mode off — the camera would never follow at all.
   */
  const programmaticMoveRef = useRef(false);
  // Effects need the latest callbacks without re-running on every render.
  const handlers = useRef({});
  handlers.current = {
    onSelectRoute,
    onMapClick,
    onCenterChange,
    onError,
    onBoundsChange,
    onCongestionCount,
    onZoomChange,
    onUserPan,
    onMapLongPress,
    onPoiClick,
    onTerrainReady,
    onBuildingsAvailable,
    onRouteStructures,
  };
  // Only refit the camera when the geometry changes, not when the selection does.
  const lastFitKey = useRef(null);
  // Read by the structure popup; refs so the click binding survives re-renders.
  const routeStructRef = useRef([]);
  const profileLabelRef = useRef(null);
  profileLabelRef.current = profileLabel || null;

  /* ------------------------------------------------------------ init map */
  useEffect(() => {
    if (!config || mapRef.current) return;

    let map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: config.map.styleUrl,
        center: config.map.center,
        zoom: config.map.zoom,
        maxPitch: config.map.maxPitch ?? 75,
        /*
         * Not compact: compact mode collapses the credit into an (i) button, which is
         * one more thing on the map for no benefit. TomTom and Vantor both require
         * attribution to be shown, so the text stays — it is the toggle that goes.
         */
        attributionControl: { compact: false },
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        /*
         * A big tile cache is what stops the drive re-fetching imagery it passed a
         * minute ago. Default is small enough that a guidance run evicts tiles it is
         * about to need again on the return leg.
         */
        maxTileCacheSize: 1200,
        // Crisp on arrival rather than fading in soft — matters at driving speed.
        fadeDuration: 0,
      });
    } catch (err) {
      handlers.current.onError?.(`Map failed to initialise: ${err.message}`);
      return;
    }

    mapRef.current = map;
    cameraRef.current = createCameraController(map);

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    map.addControl(
      new maplibregl.GeolocateControl({ trackUserLocation: false, showAccuracyCircle: true }),
      'top-right',
    );

    let unbindAlternatives = () => {};

    map.on('load', () => {
      ensureRouteLayers(map);
      unbindAlternatives = bindAlternativeClicks(map, (i) => handlers.current.onSelectRoute?.(i));

      /*
       * Publish the initial camera immediately.
       *
       * These used to be emitted only from `moveend`, which never fires if nothing
       * moves the camera — exactly what happens when geolocation is denied. Bounds
       * then stayed null and anything keyed off them (infrastructure POIs, traffic
       * incidents) never requested data at all: no error, just a permanently empty
       * layer.
       */
      const b = map.getBounds();
      handlers.current.onBoundsChange?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      handlers.current.onZoomChange?.(map.getZoom());
      const c = map.getCenter();
      handlers.current.onCenterChange?.({ lat: c.lat, lon: c.lng });

      // Tell the app whether the basemap actually carries extrudable buildings.
      handlers.current.onBuildingsAvailable?.(hasBuildingsLayer(map));
      setReady(true);
      // Exposed for the acceptance tests; harmless in the demo build.
      if (typeof window !== 'undefined') window.__map = map;
      onReady?.(map);
    });

    map.on('click', (e) => {
      // Route-line clicks are handled by their own layer listener; this is for
      // choosing start/end points on the map.
      handlers.current.onMapClick?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

    /*
     * A real drag or zoom by the user breaks camera follow, as in any nav app.
     *
     * Only `dragstart` and `wheel` count. `rotatestart` and `pitchstart` were tried
     * and removed: the follow camera's own easeTo changes bearing and pitch every
     * update, so those events fire constantly from our own animation and the camera
     * instantly un-followed itself — pressing "Re-centre" appeared to do nothing.
     * Drag and wheel are pointer-driven and cannot be triggered by easeTo.
     */
    map.on('wheel', () => handlers.current.onUserPan?.());
    /*
     * Pointer drags are detected on the canvas rather than via MapLibre's
     * `dragstart`, because the follow camera runs an easeTo every position update
     * and an in-flight camera animation swallows that event — the user could pan
     * during navigation and the map would snap straight back with no way out.
     * A raw pointer-move threshold fires regardless of what the camera is doing.
     */
    const canvas = map.getCanvas();
    let panOrigin = null;
    canvas.addEventListener('pointerdown', (e) => {
      panOrigin = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!panOrigin) return;
      if (Math.hypot(e.clientX - panOrigin.x, e.clientY - panOrigin.y) > 12) {
        handlers.current.onUserPan?.();
        panOrigin = null;
      }
    });
    for (const ev of ['pointerup', 'pointercancel']) {
      canvas.addEventListener(ev, () => {
        panOrigin = null;
      });
    }

    /*
     * Long-press (or right-click) drops a pin.
     *
     * Cancelled only once the pointer moves more than a few pixels — a strict
     * "any mousemove cancels" rule never fires at all, because the browser emits
     * move events even when the pointer is effectively stationary.
     */
    let pressTimer = null;
    let pressOrigin = null;
    const clearPress = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
      pressOrigin = null;
    };
    map.on('mousedown', (e) => {
      if (e.originalEvent.button !== 0) return;
      pressOrigin = { x: e.point.x, y: e.point.y };
      pressTimer = setTimeout(() => {
        handlers.current.onMapLongPress?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
        clearPress();
      }, 450);
    });
    map.on('mousemove', (e) => {
      if (!pressOrigin) return;
      if (Math.hypot(e.point.x - pressOrigin.x, e.point.y - pressOrigin.y) > 8) clearPress();
    });
    for (const ev of ['mouseup', 'dragstart', 'zoomstart']) map.on(ev, clearPress);

    map.on('contextmenu', (e) =>
      handlers.current.onMapLongPress?.({ lat: e.lngLat.lat, lon: e.lngLat.lng }),
    );

    map.on('moveend', () => {
      programmaticMoveRef.current = false;
      const c = map.getCenter();
      handlers.current.onCenterChange?.({ lat: c.lat, lon: c.lng });
      const b = map.getBounds();
      handlers.current.onBoundsChange?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      handlers.current.onZoomChange?.(map.getZoom());
    });

    map.on('error', (e) => {
      const message = e?.error?.message || 'unknown map error';
      if (/style|glyph|sprite/i.test(message)) handlers.current.onError?.(`Map: ${message}`);
      else console.warn('[map]', message);
    });

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      unbindAlternatives();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, [config, onReady]);

  /* -------------------------------------------------------- route layers */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const fc = routeData?.routes;
    setRouteData(map, fc);
    setSelectedRoute(map, selectedIndex ?? 0);

    /*
     * ux: refit only when the ENDPOINTS change, not when the geometry does.
     *
     * The key used to include the point count and the first coordinate, so any recompute
     * that altered the shape re-framed the camera — and options DO alter the shape.
     * Toggling "avoid motorways" or nudging the departure time therefore yanked the view
     * back to the whole route mid-adjustment, which is the "returns me to the front"
     * jump. Origin and destination are the only things that should re-aim the camera:
     * a different route between the same two points is still the same area you are
     * looking at.
     */
    const key =
      fc?.features?.length && start && end
        ? `${Number(start.lat).toFixed(5)},${Number(start.lon).toFixed(5)}|${Number(end.lat).toFixed(5)},${Number(end.lon).toFixed(5)}`
        : null;
    /*
     * Never re-frame while navigating. Pressing "Go" sets the destination, which
     * produces new geometry and used to fire a fitBounds to the whole route at the
     * exact moment the nav camera was moving in — the reported zoom-out-then-snap.
     */
    if (key && key !== lastFitKey.current && !navigating) {
      lastFitKey.current = key;
      fitToRoute(map, fc);
    } else if (key) {
      lastFitKey.current = key;
    }
    if (!key) lastFitKey.current = null;
  }, [routeData, selectedIndex, ready, navigating, start, end]); // ux: endpoints drive the fit

  /* --------------------------------------------------------- overlay setup */
  // Added once the sources are known. Both start hidden; the effects below
  // control visibility.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try {
      if (imageryModes?.length) ensureImageryLayers(map, imageryModes);
      if (trafficSource) {
        ensureTrafficLayer(map, trafficSource, LAYERS.altCasing);
        ensureIncidentLayers(map);
      }
    } catch (err) {
      console.warn('[overlays]', err.message);
    }
  }, [ready, imageryModes, trafficSource]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !imageryModes?.length) return;
    setImageryMode(map, activeImageryMode, Boolean(imageryOn));

    /*
     * Imagery on = imagery-first styling.
     *
     * The Orbis street style has 20 fills and 69 lines. Over satellite imagery that
     * reads as clutter: land-use polygons tint the ground, building footprints sit
     * on real rooftops, admin hairlines cross everything and every road carries a
     * bright casing. Hiding the layers the imagery already shows better is what
     * makes this look like the Vantor Hub rather than a street map with a photo
     * behind it. Restored exactly when imagery goes off.
     */
    if (imageryOn) applyImageryFirst(map);
    else restoreStreetStyle(map);
  }, [imageryOn, activeImageryMode, ready, imageryModes]);

  /*
   * Selecting a temporal capture re-points the imagery tiles at that date.
   *
   * The tile URL carries ?date=, which the proxy turns into a CQL filter on
   * acquisitionDate — so this genuinely re-renders the imagery rather than
   * relabelling it. setTiles() is used so the source is re-pointed in place instead
   * of being removed and re-added, which would flash the layer.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !imageryModes?.length) return;
    for (const mode of imageryModes) {
      const src = map.getSource(`vantor-imagery-${mode.id}`);
      if (!src?.setTiles) continue;
      const base = `${window.location.origin}/api/imagery/${mode.id}/{z}/{x}/{y}.png`;
      src.setTiles([captureDate ? `${base}?date=${encodeURIComponent(captureDate)}` : base]);
    }
  }, [captureDate, ready, imageryModes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setTrafficVisible(map, Boolean(trafficOn));
    setLayerVisible(map, LAYERS.congestion, Boolean(trafficOn));
  }, [trafficOn, ready, trafficSource]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setIncidentData(map, incidents);
  }, [incidents, ready]);

  /* ------------------------------------------------ bridges & tunnels */
  /*
   * These come from the basemap's own road data, so they only exist while the vector
   * basemap is loaded. Re-added whenever the style changes (switching to imagery and
   * back rebuilds the style, which drops added layers).
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    /*
     * tweak: off-route structures are shown again, but de-emphasised in paint (thin and
     * faded — see roadStructures.js) rather than hidden.
     *
     * Hiding them outright was worse than it sounds: with a route active the toggle then
     * had no visible effect anywhere the route itself was off screen, which reads as a
     * broken switch. Visibility now depends on the toggle ALONE, so flipping it always
     * changes something.
     */
    const apply = () => {
      try {
        ensureStructureLayers(map);
        setStructuresVisible(map, Boolean(structuresOn));
      } catch (err) {
        // A failure here means the layer silently does not exist; do not whisper it.
        console.error('[structures] layer setup failed:', err.message);
      }
    };
    apply();
    // styledata fires after a basemap swap; re-adding is cheap and idempotent.
    map.on('styledata', apply);

    /*
     * Click to inspect. `onRouteAt` answers whether the clicked point lies on a
     * structure the active route passes through, which is what lets the popup say the
     * clearance has already been checked against the vehicle profile.
     */
    const unbind = bindStructureClicks(map, {
      profileLabel: profileLabelRef.current,
      onRouteAt: (coord) =>
        (routeStructRef.current || []).some(
          (s) =>
            Math.abs(s.coord[0] - coord[0]) < 0.0025 && Math.abs(s.coord[1] - coord[1]) < 0.0025,
        ),
    });

    return () => {
      map.off('styledata', apply);
      unbind();
    };
  }, [ready, structuresOn, routeData]);

  /*
   * Structures ON the route. Recomputed when the route changes and after the map
   * settles, because detection reads what is currently rendered — panning along a
   * long route progressively fills the list in.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    // Routes arrive as a FeatureCollection; `index` is the property, not the array slot.
    const feats = routeData?.routes?.features || [];
    const route = feats.find((f) => f.properties?.index === (selectedIndex ?? 0)) || feats[0];
    const coords = route?.geometry?.coordinates;
    if (!coords?.length) {
      setRouteStructures(map, null);
      routeStructRef.current = [];
      handlers.current.onRouteStructures?.([]);
      return;
    }

    let timer = null;
    const found = new Map();

    const scan = () => {
      try {
        const idx = buildRouteIndex(coords);
        for (const s of findRouteStructures(map, idx.coordinates, idx.cum)) {
          // Key by kind + rounded distance so repeat scans merge rather than duplicate.
          found.set(`${s.kind}:${Math.round(s.startDistance / 50)}`, s);
        }
      } catch (err) {
        console.error('[route-structures] detection failed:', err.message);
        return;
      }
      const list = [...found.values()].sort((a, b) => a.startDistance - b.startDistance);
      setRouteStructures(map, routeStructuresToGeoJSON(list));
      routeStructRef.current = list;
      handlers.current.onRouteStructures?.(list);
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(scan, 350);
    };

    schedule();
    map.on('idle', schedule);
    return () => {
      clearTimeout(timer);
      map.off('idle', schedule);
    };
  }, [ready, routeData, selectedIndex]);

  /* ------------- bridges & tunnels along the route, at any zoom ---------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const apply = () => {
      try {
        ensureRouteStructureLayers(map);
        setRouteStructureLines(map, routeStructureLines);
        setRouteStructureLinesVisible(
          map,
          Boolean(structuresOn && routeStructureLines?.features?.length),
        );
      } catch (err) {
        console.warn('[structures/route]', err.message);
      }
    };
    apply();
    map.on('styledata', apply);
    return () => map.off('styledata', apply);
  }, [ready, routeStructureLines, structuresOn]);

  /* ---------------- bridges & tunnels at regional zoom (server-extracted) */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const apply = () => {
      try {
        ensureExtractedLayers(map);
        setExtractedStructures(map, extractedStructures);
        // tweak: shown regardless of a route; the route corridor layer draws on top of
        // these in full route width, so the two read as emphasised vs de-emphasised.
        setExtractedVisible(map, Boolean(structuresOn && extractedStructures?.features?.length));
      } catch (err) {
        console.warn('[structures/x]', err.message);
      }
    };
    apply();
    // Rebuilt after a basemap swap, same as the native layers.
    map.on('styledata', apply);
    return () => map.off('styledata', apply);
  }, [ready, extractedStructures, structuresOn, routeData]);

  /*
   * tweak: keep the POI icons above the route, the steep band and the structure lines.
   * Those layers are re-added on style swaps and route changes, each time landing on top
   * of the POI layers, so the lift has to be re-applied rather than done once.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const lift = () => {
      try {
        // Structures first, then POIs — so the final order is
        // route < structures < POI icons.
        raiseRouteStructureLayers(map);
        raisePoiLayers(map);
        // Last, so the inspection marker is never covered.
        raiseHighlightLayers(map);
      } catch (err) {
        console.warn('[poi order]', err.message);
      }
    };
    lift();
    map.on('styledata', lift);
    return () => map.off('styledata', lift);
  }, [ready, poiData, poiCategories, routeData, extractedStructures, routeStructureLines, steepGeoJSON, exaggeration, highlightedStructure]);

  /* --------------------------- highlighted structure (from the panel) */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelPulse = () => {};
    try {
      ensureHighlightLayers(map);
      setHighlightedStructure(map, highlightedStructure);
      if (highlightedStructure) cancelPulse = pulseHighlight(map);
    } catch (err) {
      console.warn('[structure highlight]', err.message);
    }
    return () => cancelPulse();
  }, [highlightedStructure, ready, routeStructureLines]);

  /* ------------------------------------- "show me these" fit + highlight */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !fitBounds?.bounds) return;
    const [w, s, e, n] = fitBounds.bounds;
    programmaticMoveRef.current = true;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      // Generous padding, and a zoom cap so a single POI does not slam to street level.
      { padding: 90, maxZoom: 15, duration: 900 },
    );
  }, [fitBounds, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try {
      ensurePoiHighlightLayer(map);
      setPoiHighlight(map, highlightedPoiLayer);
    } catch (err) {
      console.warn('[poi highlight]', err.message);
    }
  }, [highlightedPoiLayer, ready, poiCategories]);

  /* --------------------------------------------------------- infra POIs */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !poiCategories?.length) return;
    try {
      ensurePoiLayers(map, poiCategories);
    } catch (err) {
      console.warn('[pois]', err.message);
      return;
    }
    const labelFor = (id) => poiCategories.find((c) => c.id === id)?.label;
    // A POI tap opens the place card rather than only a popup — that is the
    // tap-POI-to-go flow, so the popup is suppressed when a handler is present.
    return bindPoiClicks(map, labelFor, (props, coord) =>
      handlers.current.onPoiClick?.(props, coord),
    );
  }, [ready, poiCategories]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setPoiData(map, poiData);
  }, [poiData, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setPoiVisible(map, Boolean(poiOn));
  }, [poiOn, ready, poiCategories]);

  /* ------------------------------------------- congestion on chosen route */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const features = routeData?.routes?.features || [];
    const selected = features.find((f) => f.properties.index === (selectedIndex ?? 0));
    const count = setCongestion(map, selected);
    handlers.current.onCongestionCount?.(count);
  }, [routeData, selectedIndex, ready, navigating]);

  /* ------------------------------------------------------------- terrain */
  /*
   * REAL elevation, not camera pitch.
   *
   * The DEM source is added as soon as it is available and terrain is set whenever
   * the DEM is usable — including in 2D. Two reasons: hillshade needs it, and
   * queryTerrainElevation (which drives the elevation profile) only returns values
   * while terrain is active. At pitch 0 an exaggerated DEM is visually almost
   * indistinguishable from flat, so leaving it on costs nothing and makes the
   * profile work without forcing the user into 3D.
   *
   * The 2D/3D toggle therefore controls PITCH (via the camera controller) and the
   * exaggeration actually applied, not whether elevation exists.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    if (!terrainAvailable || !terrainSourceDef) {
      // Never leave broken terrain behind: clear it and report so the UI can
      // disable 3D and hillshade with a note.
      try {
        map.setTerrain(null);
      } catch {
        /* nothing set */
      }
      setLayerVisibility(map, HILLSHADE_LAYER, false);
      handlers.current.onTerrainReady?.(false);
      return;
    }

    let applied = null;

    /*
     * Re-applied on zoom, because the effective value depends on it.
     *
     * MapLibre takes exaggeration as a plain number, not a zoom expression, so the
     * compensation has to be recomputed as the camera moves. Quantised to 0.05 and
     * compared against the last applied value, so a continuous pinch-zoom triggers a
     * handful of setTerrain calls rather than one per frame.
     */
    const applyTerrain = () => {
      const target = is3D
        ? Math.round(effectiveExaggeration(exaggeration, map.getZoom()) * 20) / 20
        : 1;
      if (applied !== null && Math.abs(target - applied) < 0.05) return;
      applied = target;
      map.setTerrain({ source: DEM_SOURCE_ID, exaggeration: target });
    };

    try {
      ensureDemSource(map, terrainSourceDef);
      ensureHillshade(map);
      ensureSteepLayer(map);
      applyTerrain();
      handlers.current.onTerrainReady?.(true);
    } catch (err) {
      console.warn('[terrain]', err.message);
      handlers.current.onTerrainReady?.(false);
      return;
    }

    map.on('zoom', applyTerrain);
    return () => map.off('zoom', applyTerrain);
  }, [ready, terrainAvailable, terrainSourceDef, is3D, exaggeration]);

  /*
   * tweak: re-assert the route after a terrain or exaggeration change.
   *
   * Changing exaggeration re-builds the terrain mesh, and the route line could end up
   * drawn under the new drape — it looked like the route had vanished. Re-setting the
   * source data and the selection forces MapLibre to re-place the line on the new mesh.
   * Cheap (no refetch) and idempotent, so it is safe to run on every change.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const id = setTimeout(() => {
      try {
        const fc = routeData?.routes;
        if (fc) {
          setRouteData(map, fc);
          setSelectedRoute(map, selectedIndex ?? 0);
        }
        if (routeStructureLines) setRouteStructureLines(map, routeStructureLines);
      } catch (err) {
        console.warn('[route re-drape]', err.message);
      }
    }, 120);
    return () => clearTimeout(id);
  }, [exaggeration, is3D, terrainAvailable, ready, routeData, selectedIndex, routeStructureLines]);

  // Pitch is the camera's business; the controller owns it.
  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera || !ready || navigating) return;
    camera.setPitch(is3D ? (window.matchMedia('(max-width: 760px)').matches ? 50 : 60) : 0);
  }, [is3D, ready, navigating]);

  /*
   * Re-applied on styledata, not just when the toggle changes.
   *
   * A basemap swap replaces the whole style, so the hillshade layer is rebuilt with its
   * creation default of hidden — and this effect would not re-run, because none of its
   * deps changed. The visible result was hillshade silently disappearing the moment you
   * switched to Satellite, which looked like the feature had been removed.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const apply = () => {
      try {
        if (terrainSourceDef) {
          ensureDemSource(map, terrainSourceDef);
          ensureHillshade(map);
        }
        setLayerVisibility(map, HILLSHADE_LAYER, Boolean(hillshadeOn && terrainAvailable));
      } catch (err) {
        console.warn('[hillshade]', err.message);
      }
    };

    apply();
    map.on('styledata', apply);
    return () => map.off('styledata', apply);
  }, [hillshadeOn, terrainAvailable, terrainSourceDef, ready]);

  // Steep stretches over the vehicle's grade limit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    ensureSteepLayer(map);
    setSteepData(map, steepGeoJSON);
    setLayerVisibility(map, STEEP_LAYER, Boolean(steepGeoJSON?.features?.length));
  }, [steepGeoJSON, ready]);

  /* ------------------------------------------------------- 3D buildings */
  /*
   * Only in 3D, and only on the vector base. The caller turns imagery off while
   * buildings are active — draped rooftops plus standing blocks is the "doubled
   * building" artifact, so the two looks are mutually exclusive by construction.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    // ux-fix: buildings must NOT extrude while satellite imagery is on, or the
    // untextured blocks stack on the photographed rooftops ("doubled/ghost
    // building" artifact). Extrusions are a Map-mode-only look, as the comment
    // above intends.
    if (buildings3D && is3D && !imageryOn) enableBuildings3D(map);
    else disableBuildings3D(map);
  }, [buildings3D, is3D, imageryOn, ready]);

  /* --------------------------------------------------------- navigation */
  const vehicleMarkerRef = useRef(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    ensureNavLayers(map);
  }, [ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setNavVisible(map, Boolean(navigating));
    // Ordinary route lines are hidden while navigating: the travelled/ahead split
    // replaces them, and drawing both makes the guidance line hard to read.
    for (const id of [LAYERS.alt, LAYERS.altCasing, LAYERS.selected, LAYERS.selectedCasing]) {
      setLayerVisible(map, id, !navigating);
    }
    if (!navigating) {
      vehicleMarkerRef.current?.remove();
      vehicleMarkerRef.current = null;
    }
  }, [navigating, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !navigating || !navSplit) return;
    setNavProgress(map, navSplit);
  }, [navSplit, navigating, ready]);

  /*
   * ENTER navigation: exactly one camera animation, fired once per session.
   */
  useEffect(() => {
    const map = mapRef.current;
    const camera = cameraRef.current;
    if (!map || !ready || !camera) return;

    if (navigating) {
      const m = motionRef?.current;
      if (!enteredNavRef.current && m?.coord) {
        enteredNavRef.current = true;
        camera.enterNavigation({ coord: m.coord, bearing: m.bearing || 0, cameraMode });
      }
    } else if (enteredNavRef.current) {
      enteredNavRef.current = false;
      camera.exitNavigation();
    }
  }, [navigating, ready, cameraMode, motionRef]);

  /*
   * PER-FRAME driver for the puck and the camera.
   *
   * Reads the motion ref, which the motion model updates every frame. This is
   * deliberately NOT a React effect keyed on position: re-rendering the component
   * 60 times a second, and starting a camera animation per render, was the original
   * source of the stutter. Here one rAF loop moves a DOM marker and calls jumpTo.
   */
  useEffect(() => {
    const map = mapRef.current;
    const camera = cameraRef.current;
    if (!map || !ready || !navigating || !motionRef) return;

    let raf = null;
    const tick = () => {
      const m = motionRef.current;
      if (m?.coord) {
        if (!vehicleMarkerRef.current) {
          const el = createVehiclePuckElement(profileId, { showAccuracy: navSource === 'gps' });
          vehicleMarkerRef.current = new maplibregl.Marker({
            element: el,
            rotationAlignment: 'map',
            pitchAlignment: 'map',
          })
            .setLngLat(m.coord)
            .addTo(map);
        } else {
          vehicleMarkerRef.current.setLngLat(m.coord);
        }
        vehicleMarkerRef.current.setRotation(m.bearing || 0);
        // Exposed for the acceptance tests; the marker and the coord it was given.
        if (typeof window !== 'undefined') {
          window.__puck = { marker: vehicleMarkerRef.current, coord: m.coord, bearing: m.bearing };
        }

        if (followCamera && enteredNavRef.current) {
          camera.follow({ coord: m.coord, bearing: m.bearing, cameraMode });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      vehicleMarkerRef.current?.remove();
      vehicleMarkerRef.current = null;
    };
  }, [ready, navigating, followCamera, cameraMode, profileId, navSource, motionRef]);

  // Switching camera mode mid-drive: one easeTo.
  const lastCameraModeRef = useRef(cameraMode);
  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera || !navigating || !enteredNavRef.current) {
      lastCameraModeRef.current = cameraMode;
      return;
    }
    if (lastCameraModeRef.current === cameraMode) return;
    lastCameraModeRef.current = cameraMode;
    const m = motionRef?.current;
    if (m?.coord) camera.setCameraMode(cameraMode, { coord: m.coord, bearing: m.bearing || 0 });
  }, [cameraMode, navigating, motionRef]);

  // Re-centre: a single move with the same parameters as entry.
  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera || !navigating || !followCamera || !recenterRequest) return;
    const m = motionRef?.current;
    if (m?.coord) camera.recenter({ coord: m.coord, bearing: m.bearing || 0, cameraMode });
  }, [recenterRequest, navigating, followCamera, cameraMode, motionRef]);

  /* ------------------------------------------------------------- fly to */
  /*
   * Recentres on a requested point (currently the user's own location). Skipped
   * once a route exists, so fitting the route wins over recentring.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !flyTo) return;
    if (routeData?.routes?.features?.length) return;
    // Via the controller: easeTo, not flyTo — flyTo arcs out and back in.
    cameraRef.current?.goTo({ coord: [flyTo.lon, flyTo.lat], zoom: flyTo.zoom ?? 12 });
    // routeData intentionally omitted: this should fire when flyTo changes, not
    // every time a route recalculates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo, ready]);

  /*
   * Direct centre+zoom, not gated on whether a route exists.
   *
   * Separate from the `flyTo` effect above on purpose: that one must stand down when a
   * route is present so it cannot fight the route fit, whereas this is an explicit user
   * request to go and look at one structure.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !goTo) return;
    programmaticMoveRef.current = true;
    cameraRef.current?.centerOn({ coord: [goTo.lon, goTo.lat], zoom: goTo.zoom ?? 15 });
  }, [goTo, ready]);

  /* ------------------------------------------------------ picking cursor */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = picking ? 'crosshair' : '';
  }, [picking]);

  return (
    <>
      <div
        ref={containerRef}
        className={`map-canvas ${picking ? 'map-picking' : ''}`}
        aria-label="Convoy route map"
      />
      {/*
        * ux-camera: rendered here because this is where the map instance lives, and the
        * controls drive it directly — a drag emits a value per pointer event, and routing
        * those through React state makes the rotation feel heavy.
        *
        * Hidden while the animation plays: the nav camera owns pitch and bearing then, so
        * the widget would be fighting it and showing values it cannot hold.
        */}
      {ready && (
        <CameraControls
          map={mapRef.current}
          maxPitch={config?.map?.maxPitch ?? 70}
          hidden={navigating}
        />
      )}
    </>
  );
}
