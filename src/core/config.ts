/**
 * rlbotline Worker — Configuration
 *
 * Parses and validates all environment variables into a typed config object.
 * Fails fast with clear error messages if required vars are missing.
 */

import type { WorkerConfig, LogLevel, OnixConfig, RedisConfig } from "../types.js";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`[Config] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    return defaultValue;
  }
  return value.trim();
}

function optionalTrimmedEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

function optionalInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return defaultValue;
  const parsed = parseInt(raw.trim(), 10);
  if (isNaN(parsed)) {
    throw new Error(`[Config] Invalid integer for ${name}: "${raw}"`);
  }
  return parsed;
}

/**
 * Load and validate worker configuration from environment variables.
 * Throws on missing required values.
 */
export function loadConfig(): WorkerConfig {
  const logLevel = optionalEnv("LOG_LEVEL", "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(
      `[Config] Invalid LOG_LEVEL: "${logLevel}". Must be one of: ${LOG_LEVELS.join(", ")}`,
    );
  }

  // Central API is OPTIONAL. When unset the worker runs standalone: session
  // persists to Redis, watched chats come from WATCH_CHAT_IDS, and every
  // /state/* /webhooks/* /ws/sync interaction is skipped (see centralApiEnabled).
  const apiBaseUrl = optionalTrimmedEnv("API_BASE_URL")?.replace(/\/+$/, "");
  const centralApiEnabled = Boolean(apiBaseUrl);

  const instanceId = requireEnv("INSTANCE_ID");

  // Redis session store (no auth). Enabled only when REDIS_HOST is set; the key
  // prefix defaults per-instance so two bots sharing one Redis don't collide.
  const redisHost = optionalTrimmedEnv("REDIS_HOST");
  const redis: RedisConfig = {
    enabled: Boolean(redisHost),
    host: redisHost ?? "",
    port: optionalInt("REDIS_PORT", 6379),
    keyPrefix: optionalEnv("REDIS_KEY_PREFIX", `rlbotline:${instanceId}`),
  };

  // Chats to watch + forward in standalone mode (comma-separated, like BANK_OA_HANDLES).
  const watchChatIds = optionalEnv("WATCH_CHAT_IDS", "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  // Bank OA MIDs to watch — verified against the account's contacts at boot and
  // watched as `oa` only if already added (never auto-followed). See §config.
  const bankOaMids = optionalEnv("BANK_OA_MIDS", "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  // onix (destination server) forward target. Enabled only when the URL, agent
  // id and key are all present, so an unconfigured worker simply skips onix.
  const onixApiUrl = optionalTrimmedEnv("ONIX_API_URL")?.replace(/\/+$/, "");
  const onixAgentId = optionalTrimmedEnv("ONIX_AGENT_ID");
  const onixApiKey = optionalTrimmedEnv("ONIX_API_KEY");
  const onix: OnixConfig = {
    enabled: Boolean(onixApiUrl && onixAgentId && onixApiKey),
    apiUrl: onixApiUrl ?? "",
    org: optionalEnv("ONIX_ORG", "global"),
    agentId: onixAgentId ?? "",
    apiUser: optionalEnv("ONIX_API_USER", "api"),
    apiKey: onixApiKey ?? "",
    appType: optionalEnv("ONIX_APPLICATION_TYPE", "backend"),
    timeoutMs: optionalInt("ONIX_FORWARD_TIMEOUT_MS", 5000),
  };

  // Bank OAs to follow + watch by @handle. Defaults to OFF: findContactByUserid
  // cannot resolve an OA basic-id, so every handle here fails, burning one
  // rate-limited LINE call and logging one warning per handle on every boot.
  // Defaulting this ON meant a deployment that never configured it (k8s manifest,
  // plain `docker run`) still paid that cost and looked broken in the logs.
  // Use BANK_OA_MIDS instead; set BANK_OA_HANDLES explicitly to opt back in.
  const bankOaHandles = (process.env.BANK_OA_HANDLES ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  // Bank-OA event filter (comma-separated, e.g. FILTER_EVENT=tx_in,tx_out).
  // Empty/unset = forward every parsed bank event. Future event names (e.g. a
  // balance event) plug in here without touching the filter mechanism.
  const filterEvent = optionalEnv("FILTER_EVENT", "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  // Inbound HTTP API (standalone app): login + health on this port. 0 disables.
  const httpPort = optionalInt("HTTP_PORT", 3000);

  const config: WorkerConfig = {
    lineAuthToken: optionalTrimmedEnv("LINE_AUTH_TOKEN"),
    // Login credentials sent directly to the worker via env. Used only when
    // there's no persisted auth token in Redis. Leave both empty for QR login.
    lineEmail: optionalTrimmedEnv("LINE_EMAIL"),
    linePassword: optionalTrimmedEnv("LINE_PASSWORD"),
    // Explicit WEBHOOK_URL wins; else the Central API forward sink when central
    // is on; else undefined (standalone with only per-chat / target URLs).
    webhookUrl: optionalTrimmedEnv("WEBHOOK_URL") ?? (apiBaseUrl ? `${apiBaseUrl}/webhooks/forward` : undefined),
    apiBaseUrl,
    centralApiEnabled,
    redis,
    watchChatIds,
    // Only the /state/* bearer — required when the Central API is on, ignored
    // standalone (a throwaway value is fine, so don't force one).
    instanceToken: centralApiEnabled ? requireEnv("INSTANCE_TOKEN") : optionalEnv("INSTANCE_TOKEN", ""),
    commandPrefix: optionalEnv("COMMAND_PREFIX", "!"),
    instanceId,
    botName: optionalEnv("BOT_NAME", "rlbotline"),
    device: optionalEnv("LINE_DEVICE", "IOSIPAD"),
    rateLimitCalls: optionalInt("RATE_LIMIT_CALLS", 5),
    rateLimitWindowMs: optionalInt("RATE_LIMIT_WINDOW_MS", 10000),
    messageRetentionHours: optionalInt("MESSAGE_RETENTION_HOURS", 24),
    watchHmacSecret: optionalTrimmedEnv("WATCH_HMAC_SECRET"),
    forwardTimeoutMs: optionalInt("WATCH_FORWARD_TIMEOUT_MS", 5000),
    pinWaitTimeoutMs: optionalInt("PIN_WAIT_TIMEOUT_MS", 300000),
    onix,
    bankOaHandles,
    bankOaMids,
    filterEvent,
    httpPort,
    httpApiEnabled: httpPort > 0,
    httpApiUser: optionalEnv("HTTP_API_USER", "api"),
    httpApiKey: optionalTrimmedEnv("HTTP_API_KEY"),
    logLevel,
  };

  return config;
}
