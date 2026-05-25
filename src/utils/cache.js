// Simple in-memory TTL cache. Keys are arbitrary strings; values are any JSON.
// No persistence between restarts — for Overpass results, the 24 h TTL is enough
// to avoid hammering the public endpoint within a single session.

const store = new Map();

export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function set(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}
