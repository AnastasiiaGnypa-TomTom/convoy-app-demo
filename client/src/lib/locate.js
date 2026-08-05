/**
 * Browser geolocation, wrapped so the app can start from where the user is.
 *
 * Deliberately best-effort: geolocation needs a secure context (https, or
 * localhost in dev), the user can refuse it, and some corporate/meeting-room
 * networks resolve it poorly. Every failure path resolves to null so the caller
 * can fall back to the configured map centre rather than blocking startup.
 */

const TIMEOUT_MS = 8000;

export function isGeolocationAvailable() {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator && window.isSecureContext;
}

/**
 * @returns {Promise<{lat:number, lon:number, accuracyMeters:number}|null>}
 */
export function locateUser() {
  if (!isGeolocationAvailable()) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    // Belt and braces: some browsers never fire the error callback on timeout.
    const timer = setTimeout(() => done(null), TIMEOUT_MS + 500);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
        });
      },
      () => {
        clearTimeout(timer);
        done(null);
      },
      { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: 300000 },
    );
  });
}
