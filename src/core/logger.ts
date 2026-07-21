/**
 * rlbotline Worker — Structured Logger
 *
 * Lightweight JSON logger that outputs to stdout (Docker-friendly).
 * Every log line includes the instance ID for multi-container correlation.
 */

import type { LogLevel, LogEntry } from "../types.js";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
let instanceId = "unknown";

/**
 * Configure the logger. Call once on startup.
 */
export function configureLogger(level: LogLevel, id: string): void {
  currentLevel = level;
  instanceId = id;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function emit(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    level,
    message,
    instanceId,
    timestamp: new Date().toISOString(),
  };

  if (data && Object.keys(data).length > 0) {
    entry.data = data;
  }

  const line = JSON.stringify(entry);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug(message: string, data?: Record<string, unknown>): void {
    emit("debug", message, data);
  },
  info(message: string, data?: Record<string, unknown>): void {
    emit("info", message, data);
  },
  warn(message: string, data?: Record<string, unknown>): void {
    emit("warn", message, data);
  },
  error(message: string, data?: Record<string, unknown>): void {
    emit("error", message, data);
  },
};
