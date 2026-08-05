import { useEffect, useRef, useState } from 'react';
import { positionAt, snapToRoute, speedForProfile } from '../lib/navigation.js';

/**
 * Continuous vehicle motion — one rAF loop for both movement sources.
 *
 * ── Why this replaced the previous model ──────────────────────────────────
 * Before, the simulated driver advanced on rAF but GPS moved the vehicle one HOP
 * per fix (about 1 Hz), and the camera was driven straight off those hops. The
 * result was visible jerk: a stationary second followed by a jump, with the camera
 * lurching to catch up.
 *
 * Now there is exactly one animation loop, and both sources feed the SAME
 * integrator:
 *
 *   distanceAlong += speed × dt      (frame-rate independent)
 *
 *   simulated : `speed` eases toward the profile's cruising speed
 *   gps       : each fix sets a TARGET distance-along; the loop closes the gap
 *               smoothly and derives speed from successive fixes, so between fixes
 *               the vehicle keeps moving (dead reckoning) rather than freezing
 *
 * Bearing is low-pass filtered along the shortest arc, so small polyline wiggles
 * and GPS heading noise do not snap the world around.
 *
 * The loop publishes to a ref every frame and to React state at a throttled rate:
 * the camera and puck read the ref (60 fps, no re-render), while the banner and ETA
 * re-render a few times a second. Re-rendering the whole app 60 times a second was
 * itself a source of stutter.
 */

const REDUCED_MOTION = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** How quickly speed converges on its target (per second). Gives eased accel. */
const SPEED_EASE = 1.6;
/** How quickly a GPS position gap is closed, as a fraction per second. */
const GPS_CATCHUP = 2.2;
/** UI refresh rate — banner/ETA do not need 60 fps. */
const UI_HZ = 6;

function smoothAngle(prev, next, factor) {
  if (prev == null || Number.isNaN(prev)) return next;
  const delta = ((next - prev + 540) % 360) - 180;
  if (Math.abs(delta) < 0.6) return prev; // jitter, not turning
  return (prev + delta * factor + 360) % 360;
}

export function useVehicleMotion({
  routeIndex,
  travelTimeSeconds,
  profileId,
  active,
  source,
  speedMultiplier = 1,
}) {
  /** Live state, read by the camera and puck every frame without re-rendering. */
  const motionRef = useRef({
    distanceAlong: 0,
    coord: null,
    bearing: 0,
    speedMps: 0,
    offRouteMeters: 0,
  });

  const [uiMotion, setUiMotion] = useState(null);
  const [gpsError, setGpsError] = useState(null);
  const [paused, setPaused] = useState(false);

  const speedRef = useRef(0);
  const targetDistanceRef = useRef(null); // GPS only
  const gpsSpeedRef = useRef(null);
  const rafRef = useRef(null);
  const lastTsRef = useRef(null);
  const lastUiRef = useRef(0);
  const watchRef = useRef(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // Reset when the route changes.
  useEffect(() => {
    motionRef.current = {
      distanceAlong: 0,
      coord: routeIndex ? positionAt(routeIndex, 0)?.coord || null : null,
      bearing: routeIndex ? positionAt(routeIndex, 0)?.bearing || 0 : 0,
      speedMps: 0,
      offRouteMeters: 0,
    };
    speedRef.current = 0;
    targetDistanceRef.current = null;
    gpsSpeedRef.current = null;
    lastTsRef.current = null;
    setUiMotion(routeIndex ? { ...motionRef.current } : null);
  }, [routeIndex]);

  /* ------------------------------------------------------- the single loop */
  useEffect(() => {
    if (!active || !routeIndex) return;

    const cruising = speedForProfile(profileId);
    const reduced = REDUCED_MOTION();

    const frame = (ts) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      // Clamp dt so a backgrounded tab does not teleport the vehicle on return.
      const dt = Math.min(0.1, Math.max(0, (ts - lastTsRef.current) / 1000));
      lastTsRef.current = ts;
      const m = motionRef.current;

      if (!pausedRef.current && dt > 0) {
        if (source === 'gps') {
          /*
           * Dead reckoning between fixes, plus a smooth pull toward the latest fix.
           * Moving at the last known speed keeps the puck gliding for the ~1 s
           * between fixes instead of freezing and then jumping.
           */
          const target = targetDistanceRef.current;
          const gpsSpeed = gpsSpeedRef.current;
          if (gpsSpeed != null) {
            speedRef.current += (gpsSpeed - speedRef.current) * Math.min(1, SPEED_EASE * dt);
          }
          m.distanceAlong += speedRef.current * dt;
          if (target != null) {
            // Close any remaining gap proportionally rather than snapping.
            m.distanceAlong += (target - m.distanceAlong) * Math.min(1, GPS_CATCHUP * dt);
          }
        } else {
          // Simulated: ease toward cruising speed so there is no instant jump.
          const targetSpeed = cruising * speedMultiplier;
          speedRef.current += (targetSpeed - speedRef.current) * Math.min(1, SPEED_EASE * dt);
          m.distanceAlong += speedRef.current * dt;
        }

        m.distanceAlong = Math.max(0, Math.min(routeIndex.totalMeters, m.distanceAlong));
        const p = positionAt(routeIndex, m.distanceAlong);
        if (p) {
          m.coord = p.coord;
          // Reduced motion: take the raw bearing, no easing.
          m.bearing = reduced ? p.bearing : smoothAngle(m.bearing, p.bearing, Math.min(1, 3.5 * dt));
        }
        m.speedMps = speedRef.current;
      }

      // Throttled publish for the banner and ETA.
      if (ts - lastUiRef.current > 1000 / UI_HZ) {
        lastUiRef.current = ts;
        setUiMotion({ ...m });
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
    };
  }, [active, routeIndex, source, profileId, speedMultiplier]);

  /* ---------------------------------------------------------------- gps in */
  useEffect(() => {
    if (!active || !routeIndex || source !== 'gps') {
      targetDistanceRef.current = null;
      gpsSpeedRef.current = null;
      return;
    }
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      setGpsError('GPS needs a secure context (https or localhost).');
      return;
    }

    let lastFix = null;
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsError(null);
        const snapped = snapToRoute(routeIndex, [pos.coords.longitude, pos.coords.latitude], {
          fromMeters: motionRef.current.distanceAlong,
        });
        targetDistanceRef.current = snapped.distanceAlong;
        motionRef.current.offRouteMeters = snapped.offRouteMeters;

        // Prefer the device's own speed; otherwise derive it from consecutive fixes.
        if (typeof pos.coords.speed === 'number' && !Number.isNaN(pos.coords.speed)) {
          gpsSpeedRef.current = Math.max(0, pos.coords.speed);
        } else if (lastFix) {
          const dtS = (pos.timestamp - lastFix.timestamp) / 1000;
          if (dtS > 0.2) {
            gpsSpeedRef.current = Math.max(0, (snapped.distanceAlong - lastFix.distance) / dtS);
          }
        }
        lastFix = { timestamp: pos.timestamp, distance: snapped.distanceAlong };
      },
      (err) => {
        setGpsError(
          err.code === err.PERMISSION_DENIED ? 'Location permission denied.' : err.message,
        );
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10_000 },
    );

    return () => {
      if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    };
  }, [active, routeIndex, source]);

  return {
    /** Read by the camera and puck each frame — never triggers a re-render. */
    motionRef,
    /** Throttled copy for the banner and ETA. */
    motion: uiMotion,
    gpsError,
    paused,
    setPaused,
    seek: (meters) => {
      motionRef.current.distanceAlong = Math.max(0, meters);
      speedRef.current = 0;
      targetDistanceRef.current = null;
    },
  };
}
