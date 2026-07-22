/**
 * rlbotline Worker — Redis client (session persistence)
 *
 * Holds the single Redis connection used to persist the LINE session (auth token
 * + linejs storage blob with E2EE keys) so a restart restores the session instead
 * of re-logging-in. A fresh login rotates the device / Letter-Sealing key, and
 * repeated logins from a datacenter IP get the LINE account banned — persisting
 * the session is the anti-ban mechanism.
 *
 * No authentication: the connection is built from `REDIS_HOST`/`REDIS_PORT` only.
 * Disabled when `REDIS_HOST` is unset — the session then lives in memory for that
 * run only (a loud warning is logged; the next restart forces a fresh login).
 *
 * Uses Bun's native `RedisClient` (no external dependency).
 */

import { RedisClient } from "bun";
import { logger } from "./logger.js";
import type { RedisConfig } from "../types.js";

/**
 * The subset of the Redis client the worker actually uses. Kept as a narrow
 * interface so a Map-backed fake can be injected in tests (`__setRedisForTest`)
 * without standing up a real Redis or mocking the whole `"bun"` module.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  connect(): Promise<unknown>;
  close(): void;
}

let client: RedisLike | null = null;
let prefix = "";
let enabled = false;

/**
 * Configure the Redis session store once on startup. Never throws into boot —
 * a connection failure is logged and retried lazily via Bun's offline queue.
 */
export function configureRedis(cfg: RedisConfig): void {
  if (!cfg.enabled) {
    enabled = false;
    client = null;
    logger.warn(
      "⚠️ Redis not configured (REDIS_HOST empty) — LINE session will NOT persist; " +
        "it lives in memory for this run only, so a restart forces a fresh login " +
        "and rotates the Letter Sealing (E2EE) key",
    );
    return;
  }

  prefix = cfg.keyPrefix;
  const url = `redis://${cfg.host}:${cfg.port}`; // no auth
  const redisClient = new RedisClient(url, {
    autoReconnect: true,
    enableOfflineQueue: true,
  });
  redisClient.onconnect = () => logger.info("Redis connected", { url, keyPrefix: prefix });
  redisClient.onclose = (err?: Error) =>
    logger.warn("Redis connection closed", { error: err?.message });
  client = redisClient;
  enabled = true;

  // Lazy: the first command auto-connects. Kick a connect now so a bad host
  // surfaces in the logs immediately, but never let it crash the boot.
  redisClient.connect().catch((e) =>
    logger.error("Redis initial connect failed (offline queue will retry)", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
}

/** True when a Redis session store is configured and available. */
export function isRedisEnabled(): boolean {
  return enabled && client !== null;
}

/** The active Redis client, or null when disabled. */
export function getRedis(): RedisLike | null {
  return client;
}

/** Namespace a session key under the configured prefix (e.g. "auth-token" → "{prefix}:auth-token"). */
export function redisKey(suffix: string): string {
  return `${prefix}:${suffix}`;
}

/** Close the Redis connection on shutdown (best-effort). */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    client.close();
  } catch {
    // best-effort — the process is exiting anyway
  }
  client = null;
  enabled = false;
}

/**
 * Test seam: inject a fake Redis client + key prefix directly, bypassing
 * `configureRedis`. Only for unit tests — never call in production code.
 */
export function __setRedisForTest(fake: RedisLike | null, keyPrefix = "test"): void {
  client = fake;
  prefix = keyPrefix;
  enabled = fake !== null;
}
