/**
 * rlbotline Worker — Configuration
 *
 * Parses and validates all environment variables into a typed config object.
 * Fails fast with clear error messages if required vars are missing.
 */

import type { WorkerConfig, LogLevel } from "../types.js";

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

  const apiBaseUrl = requireEnv("API_BASE_URL").replace(/\/+$/, "");

  const config: WorkerConfig = {
    lineAuthToken: optionalTrimmedEnv("LINE_AUTH_TOKEN"),
    // Standalone login credentials sent directly to the worker via env. Used as
    // a fallback when the Central API session (GET /state/session) carries no
    // email/password, so this worker can log in with email/password without a
    // dashboard round-trip. Leave both empty to fall back to QR login.
    lineEmail: optionalTrimmedEnv("LINE_EMAIL"),
    linePassword: optionalTrimmedEnv("LINE_PASSWORD"),
    // Optional: defaults to the control-plane forward sink. Additional user
    // webhook targets (worker_settings.webhookTargets) are fanned out separately.
    webhookUrl: optionalTrimmedEnv("WEBHOOK_URL") ?? `${apiBaseUrl}/webhooks/forward`,
    apiBaseUrl,
    instanceToken: requireEnv("INSTANCE_TOKEN"),
    commandPrefix: optionalEnv("COMMAND_PREFIX", "!"),
    instanceId: requireEnv("INSTANCE_ID"),
    botName: optionalEnv("BOT_NAME", "rlbotline"),
    device: optionalEnv("LINE_DEVICE", "IOSIPAD"),
    rateLimitCalls: optionalInt("RATE_LIMIT_CALLS", 5),
    rateLimitWindowMs: optionalInt("RATE_LIMIT_WINDOW_MS", 10000),
    messageRetentionHours: optionalInt("MESSAGE_RETENTION_HOURS", 24),
    watchHmacSecret: optionalTrimmedEnv("WATCH_HMAC_SECRET"),
    forwardTimeoutMs: optionalInt("WATCH_FORWARD_TIMEOUT_MS", 5000),
    pinWaitTimeoutMs: optionalInt("PIN_WAIT_TIMEOUT_MS", 300000),
    logLevel,
  };

  return config;
}
