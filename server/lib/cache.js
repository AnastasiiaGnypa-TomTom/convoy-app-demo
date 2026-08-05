/**
 * Tiny in-memory TTL cache.
 *
 * TomTom rate-limits this key hard enough that a probe run tripped 429s, and a
 * demo where someone re-types the same query or re-picks the same profile must
 * not stall in front of a customer. Repeated identical calls are served from here.
 *
 * Deliberately process-local: a single App Service instance, no extra dependency.
 */

const MAX_ENTRIES = 500;

export function createCache({ ttlMs }) {
  const store = new Map();

  const prune = () => {
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expires <= now) store.delete(k);
    }
    // Map preserves insertion order, so the oldest keys drop out first.
    while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
  };

  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expires <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      store.set(key, { value, expires: Date.now() + ttlMs });
      if (store.size > MAX_ENTRIES) prune();
      return value;
    },
    get size() {
      return store.size;
    },
  };
}
