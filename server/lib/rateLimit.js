/**
 * Per-IP rate limiting for the vendor proxy.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The keys never reach the browser, which protects the CREDENTIALS. It does not
 * protect the QUOTA behind them. On a public URL with no authentication, every
 * /api/* endpoint is an open relay to TomTom and Vantor billed to our account:
 * anyone who finds the link can drive unlimited routing calls and imagery tiles.
 * Imagery is the expensive path — a script pulling tiles in a loop is the realistic
 * abuse case, not a clever exploit.
 *
 * So the limit is per-IP, per-class, and deliberately generous: a real demo session
 * with a long drive and rolling tile prefetch must never hit it, while a scripted
 * pull stops within seconds.
 *
 * ── Token bucket, not fixed window ────────────────────────────────────────
 * A fixed window would break the app's own traffic pattern. Guidance start fires a
 * legitimate burst of ~50 prefetch tiles at once; a 60-per-minute fixed window
 * either rejects that burst or has to be set so high it stops limiting anything. A
 * bucket with a large capacity and a steady refill absorbs the burst and still caps
 * the sustained rate, which is exactly the shape of the traffic.
 *
 * ── Known limitation, stated rather than hidden ───────────────────────────
 * State is per-process and in-memory. Scale the App Service out to N instances and
 * the effective limit becomes N× this, because each instance counts separately.
 * At one instance — the demo configuration — it is exact. Anything stricter needs a
 * shared store (Redis), which is not worth a dependency for a demo. Restarting the
 * process also clears all buckets; that is acceptable for the same reason.
 */

/** Buckets per class, keyed by client IP. */
const buckets = new Map();

/** Sweep idle buckets so a long-running instance does not grow unbounded. */
const IDLE_MS = 10 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < IDLE_MS) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (now - b.last > IDLE_MS) buckets.delete(key);
  }
}

/**
 * Client IP.
 *
 * App Service terminates TLS at its front end and forwards the real client address
 * in x-forwarded-for, so req.ip would otherwise be the load balancer for every
 * visitor — one shared bucket, and the first busy user would rate-limit everybody.
 * The leftmost entry is the original client. It is spoofable, but spoofing it only
 * lets an abuser spread their own traffic across buckets, which is the same thing
 * they could achieve with proxies anyway; it cannot be used to limit someone else.
 */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) {
    const first = fwd.split(',')[0].trim();
    // App Service appends :port to the forwarded address; strip it.
    if (first) return first.replace(/:\d+$/, '');
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Build a limiter middleware.
 *
 * @param {object}  opts
 * @param {string}  opts.name      bucket class, so tiles and routes limit separately
 * @param {number}  opts.capacity  burst size — the most that can arrive at once
 * @param {number}  opts.perMinute sustained refill rate
 */
export function rateLimit({ name, capacity, perMinute }) {
  const refillPerMs = perMinute / 60_000;

  return function limiter(req, res, next) {
    const now = Date.now();
    sweep(now);

    const key = `${name}:${clientIp(req)}`;
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: now };
      buckets.set(key, b);
    }

    // Refill for elapsed time, capped at capacity.
    b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerMs);
    b.last = now;

    if (b.tokens < 1) {
      const retryAfter = Math.ceil((1 - b.tokens) / refillPerMs / 1000);
      res.set('retry-after', String(Math.max(1, retryAfter)));
      res.set('cache-control', 'no-store');
      /*
       * 429 with a plain body. No detail about limits or bucket state: that is free
       * reconnaissance for anyone probing, and a legitimate user never sees this.
       */
      return res.status(429).json({ error: 'rate limit exceeded' });
    }

    b.tokens -= 1;
    return next();
  };
}

/**
 * Limits per endpoint class.
 *
 * Numbers chosen against the app's own measured behaviour rather than picked round:
 *
 *   imagery  A guidance start warms up to 50 tiles, then the rolling window tops up
 *            ~3-12 tiles every 1.5 s, and MapLibre itself requests what it draws.
 *            Capacity 220 absorbs the start burst plus the map's own loading with
 *            room to spare; 600/min sustained is roughly 10 tiles a second, far
 *            above any human panning and far below what a scripted pull wants.
 *
 *   routing  Recalculated on profile change, endpoint edits, and alternatives.
 *            A busy user might issue a dozen in a minute; 120/min is ~10x that.
 *
 *   search   Autocomplete is debounced client-side but still per-keystroke-ish.
 *
 *   general  Everything else: config, capabilities, terrain meta, temporal.
 */
export const LIMITS = {
  imagery: { name: 'imagery', capacity: 220, perMinute: 600 },
  routing: { name: 'routing', capacity: 40, perMinute: 120 },
  search: { name: 'search', capacity: 60, perMinute: 200 },
  general: { name: 'general', capacity: 90, perMinute: 300 },
};

/** Exposed for tests and for a future admin readout. Never includes IPs. */
export function limiterStats() {
  const byClass = {};
  for (const key of buckets.keys()) {
    const cls = key.slice(0, key.indexOf(':'));
    byClass[cls] = (byClass[cls] || 0) + 1;
  }
  return { trackedBuckets: buckets.size, byClass };
}
