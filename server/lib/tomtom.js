/**
 * TomTom vendor adapter.
 *
 * The single place where the TomTom API key is attached to a request. Nothing
 * above this module ever sees it, which is what keeps the key out of the browser
 * bundle. Swapping TomTom for another routing/basemap vendor means rewriting
 * this file and nothing in the client.
 *
 * API-version notes, established empirically against the live key (2026-07-29):
 *   - Orbis Routing requires apiVersion=2. apiVersion=1 returns
 *     400 "This API version is no longer available"; 3 and 4 are not valid.
 *   - Orbis basemap styles work at apiVersion=1 (basic_street-light and
 *     basic_street-satellite both return a style).
 *   - Orbis places/geocode returns 401 on this key, so geocoding uses the
 *     classic Search v2 endpoint instead. Traffic uses Flow v4 + Incidents v5.
 */

import { config } from './env.js';

const BASE = 'https://api.tomtom.com';

/** Orbis apiVersion values, isolated here so a vendor bump is a one-line edit. */
export const ORBIS_API_VERSION = {
  routing: '2',
  maps: '1',
  places: '2',
  traffic: '1',
};

/** Default Orbis basemap style. Swap for a dark/satellite variant if the demo wants one. */
export const ORBIS_MAP_STYLE = 'basic_street-light';

export class VendorError extends Error {
  constructor(message, { status, vendorStatus, body } = {}) {
    super(message);
    this.name = 'VendorError';
    this.status = status ?? 502;
    this.vendorStatus = vendorStatus;
    this.body = body;
  }
}

/** Build a TomTom URL with the key appended server-side. Never logged verbatim. */
export function tomtomUrl(path, params = {}) {
  const url = new URL(path.startsWith('http') ? path : `${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', config.tomtomKey);
  return url.toString();
}

/** Redact the key from any URL before it reaches a log line or an error body. */
export function redact(value) {
  return String(value).replace(/([?&]key=)[^&]*/gi, '$1<redacted>');
}

/**
 * Fetch from TomTom with a timeout. Returns the raw Response so callers can
 * stream binary tiles without buffering them.
 */
export async function tomtomFetch(url, { timeoutMs = 15_000, headers = {}, method = 'GET', body } = {}) {
  if (!config.tomtomKey) {
    throw new VendorError('TOMTOM_API_KEY is not configured on the server', { status: 503 });
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { method, headers, body, signal: ctl.signal });
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    throw new VendorError(`TomTom request failed: ${reason}`, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the TomTom key currently accepted?
 *
 * HEAD against the copyrights caption endpoint — a 56-byte resource, so this is
 * the cheapest call that still exercises key validation. Verified 2026-07-30:
 * 200 with a valid key, 401 with an invalid one.
 *
 * Deliberately not the Orbis style endpoint: that would also pass on a key that
 * has routing but not Maps, and it transfers 139 KB on a GET.
 */
export async function checkTomTomKey({ timeoutMs = 8000 } = {}) {
  if (!config.tomtomKey) return { configured: false, valid: false, detail: 'TOMTOM_API_KEY not set' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(tomtomUrl('/map/2/copyrights/caption.json'), {
      method: 'HEAD',
      signal: ctl.signal,
    });
    return {
      configured: true,
      valid: res.ok,
      status: res.status,
      detail: res.ok
        ? 'key accepted by TomTom'
        : res.status === 401 || res.status === 403
          ? 'key rejected — revoked, rotated, or lacking entitlement'
          : `unexpected HTTP ${res.status}`,
    };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    return { configured: true, valid: false, detail: `could not reach TomTom: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch and parse JSON, turning vendor errors into VendorError with a safe body. */
export async function tomtomJson(url, opts) {
  const res = await tomtomFetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new VendorError(`TomTom returned HTTP ${res.status}`, {
      status: res.status === 403 || res.status === 401 ? 502 : res.status,
      vendorStatus: res.status,
      body: redact(text).slice(0, 500),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new VendorError('TomTom returned a non-JSON body', { status: 502 });
  }
}
