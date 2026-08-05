import { useEffect, useRef, useState } from 'react';
import { positionAt, snapToRoute, speedForProfile } from '../lib/navigation.js';

/**
 * The one place a vehicle position comes from during navigation.
 *
 * Two sources, one output shape — `{ coord, bearing, distanceAlong, speedMps,
 * offRouteMeters }` — so the banner, camera and ETA never know or care which is
 * active, as the spec requires.
 *
 *  SIMULATED (default): advances along the route polyline. This is the default
 *    deliberately: a live demo happens indoors, where GPS is unavailable or wildly
 *    inaccurate, and a navigation view that cannot move is not a demo.
 *
 *  GPS: watchPosition, snapped to the route. Needs a secure context, so it works on
 *    the Azure HTTPS URL and on localhost but not over plain http on a LAN. If
 *    permission is denied or it errors, it falls back to simulated rather than
 *    leaving a dead screen.
 */
export function usePositionSource({ routeIndex, travelTimeSeconds, profileId, active, source, speedMultiplier = 1 }) {
  const [position, setPosition] = useState(null);
  const [gpsError, setGpsError] = useState(null);
  const [paused, setPaused] = useState(false);

  // Distance along lives in a ref so the animation loop never restarts on change.
  const distanceRef = useRef(0);
  const rafRef = useRef(null);
  const lastTsRef = useRef(null);
  const watchRef = useRef(null);

  // Reset when the route itself changes.
  useEffect(() => {
    distanceRef.current = 0;
    lastTsRef.current = null;
    if (routeIndex) {
      const p = positionAt(routeIndex, 0);
      if (p) setPosition({ ...p, distanceAlong: 0, speedMps: 0, offRouteMeters: 0 });
    } else {
      setPosition(null);
    }
  }, [routeIndex]);

  /* ------------------------------------------------------------- simulated */
  useEffect(() => {
    if (!active || !routeIndex || source !== 'simulated') return;

    const baseSpeed = speedForProfile(profileId);
    const step = (ts) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = Math.min(0.25, (ts - lastTsRef.current) / 1000); // clamp tab-switch jumps
      lastTsRef.current = ts;

      if (!paused) {
        const speed = baseSpeed * speedMultiplier;
        distanceRef.current = Math.min(routeIndex.totalMeters, distanceRef.current + speed * dt);
        const p = positionAt(routeIndex, distanceRef.current);
        if (p) {
          setPosition({
            ...p,
            distanceAlong: distanceRef.current,
            speedMps: speed,
            offRouteMeters: 0,
          });
        }
      }
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [active, routeIndex, source, profileId, speedMultiplier, paused]);

  /* ------------------------------------------------------------------- gps */
  useEffect(() => {
    if (!active || !routeIndex || source !== 'gps') return;

    if (!('geolocation' in navigator) || !window.isSecureContext) {
      setGpsError('GPS needs a secure context (https or localhost).');
      return;
    }

    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsError(null);
        const coord = [pos.coords.longitude, pos.coords.latitude];
        const snapped = snapToRoute(routeIndex, coord, { fromMeters: distanceRef.current });
        distanceRef.current = snapped.distanceAlong;
        const onLine = positionAt(routeIndex, snapped.distanceAlong);
        setPosition({
          // Snapped to the line so the marker tracks the road rather than jittering.
          coord: snapped.coord,
          bearing:
            typeof pos.coords.heading === 'number' && !Number.isNaN(pos.coords.heading)
              ? pos.coords.heading
              : onLine?.bearing || 0,
          distanceAlong: snapped.distanceAlong,
          speedMps: pos.coords.speed ?? 0,
          offRouteMeters: snapped.offRouteMeters,
        });
      },
      (err) => {
        setGpsError(err.code === err.PERMISSION_DENIED ? 'Location permission denied.' : err.message);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10_000 },
    );

    return () => {
      if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    };
  }, [active, routeIndex, source]);

  return {
    position,
    gpsError,
    paused,
    setPaused,
    /** Jump the simulated driver, e.g. to restart. */
    seek: (meters) => {
      distanceRef.current = Math.max(0, meters);
    },
  };
}
