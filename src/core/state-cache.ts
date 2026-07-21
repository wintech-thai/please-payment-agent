/**
 * rlbotline Worker — State Cache
 *
 * Minimal TTL cache for hot reads against the Central API.
 * - 30s default TTL with stale-while-revalidate semantics
 * - `invalidate(prefix)` clears entries whose key starts with `prefix`
 * - `applyUpdate` integrates with WS `state_update` push-with-ack messages
 *
 * The cache is intentionally simple: a single in-process Map. There is no
 * cross-instance coherence — only the worker's own consumers.
 */

interface Entry<T> {
  data: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();
const DEFAULT_TTL_MS = 30_000;

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.data;
}

export function cacheSet<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS): void {
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function cacheDelete(key: string): void {
  store.delete(key);
}

export function invalidatePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function clearCache(): void {
  store.clear();
}

/**
 * Get-or-fetch helper. If the cache has a fresh value, returns it.
 * Otherwise calls `loader`, stores the result, and returns it.
 */
export async function getOrFetch<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return cached;
  const fresh = await loader();
  cacheSet(key, fresh, ttlMs);
  return fresh;
}

/**
 * Apply a WS state_update push by invalidating the affected cache keys.
 * Returns a hash-style verify token the WS client echoes back as `state_ack`.
 */
export function applyStateUpdate(table: string, _payload: unknown): string {
  invalidatePrefix(`${table}:`);
  return `${table}-${Date.now().toString(36)}`;
}
