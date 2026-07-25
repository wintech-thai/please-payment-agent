/**
 * rlbotline Worker — Webhook Client
 *
 * Outbound HTTP client for reporting status events to the Central API.
 * Includes retry logic, heartbeat scheduling, and typed payloads.
 */

import { logger } from "./logger.js";
import {
  headersToObject,
  logHttpError,
  logHttpRequest,
  logHttpResponse,
  safeReadBody,
} from "./http-log.js";
import type { WebhookEvent, WebhookPayload } from "../types.js";

let webhookUrl = "";
let instanceId = "";
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Configure the webhook client. Call once on startup.
 */
export function configureWebhook(url: string, id: string): void {
  webhookUrl = url;
  instanceId = id;
}

/**
 * Send a webhook event to the Central API.
 * Fire-and-forget with retry (max 3 attempts).
 */
export async function sendWebhookEvent(
  event: WebhookEvent,
  data: Record<string, unknown> = {},
): Promise<void> {
  if (!webhookUrl) {
    logger.warn("Webhook URL not configured, skipping event", { event });
    return;
  }

  const payload: WebhookPayload = {
    instanceId,
    event,
    data,
    timestamp: Date.now(),
  };

  const headers = {
    "Content-Type": "application/json",
    "X-Instance-ID": instanceId,
  };
  const body = JSON.stringify(payload);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const trace = { event, attempt, maxRetries: MAX_RETRIES, instanceId };
    logHttpRequest("webhook", { method: "POST", url: webhookUrl, headers, body }, trace);
    const startedAt = Date.now();
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });
      const responseBody = await safeReadBody(response);
      logHttpResponse(
        "webhook",
        {
          method: "POST",
          url: webhookUrl,
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - startedAt,
          headers: headersToObject(response.headers),
          body: responseBody,
        },
        trace,
      );

      if (response.ok) {
        return;
      }
    } catch (error) {
      logHttpError(
        "webhook",
        { method: "POST", url: webhookUrl, durationMs: Date.now() - startedAt, timeoutMs: 5000 },
        error,
        trace,
      );

      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * attempt),
        );
      }
    }
  }

  logger.error("Webhook exhausted all retries", {
    event,
    maxRetries: MAX_RETRIES,
  });
}

/**
 * Start the heartbeat loop. Sends a heartbeat event every 60 seconds.
 */
export function startHeartbeat(): void {
  if (heartbeatInterval) return;

  logger.info("Starting webhook heartbeat", {
    intervalMs: HEARTBEAT_INTERVAL_MS,
  });

  heartbeatInterval = setInterval(() => {
    sendWebhookEvent("heartbeat", {
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    }).catch(() => {
      // Already logged inside sendWebhookEvent
    });
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the heartbeat loop.
 */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    logger.info("Stopped webhook heartbeat");
  }
}

/**
 * Send the PIN code to the Central API for display on the affiliate's dashboard.
 */
export async function reportPincode(pincode: string): Promise<void> {
  logger.info("Reporting PIN code to Central API", { pincode });
  await sendWebhookEvent("pincode", { pincode });
}

/**
 * Send the QR login URL to the Central API for display on the dashboard.
 * The operator renders it as a QR code and scans it with the LINE app.
 */
export async function reportQr(url: string): Promise<void> {
  logger.info("Reporting QR login URL to Central API");
  await sendWebhookEvent("qrcode", { url });
}

/**
 * Report that the worker is ready and connected.
 */
export async function reportReady(
  profileName: string,
  profileMid: string,
): Promise<void> {
  logger.info("Reporting ready status to Central API", {
    profileName,
    profileMid,
  });
  await sendWebhookEvent("ready", { profileName, profileMid });
}

export async function reportStatus(
  status: "stopped" | "starting" | "running" | "error",
  message?: string,
  context?: Record<string, unknown>,
): Promise<void> {
  const data: Record<string, unknown> = {
    status,
    ...(context ?? {}),
  };

  if (message) {
    data["message"] = message;
  }

  logger.info("Reporting worker status to Central API", data);
  await sendWebhookEvent("status", data);
}

/**
 * Report an error to the Central API.
 */
export async function reportError(
  errorMessage: string,
  context?: Record<string, unknown>,
): Promise<void> {
  logger.error("Reporting error to Central API", {
    errorMessage,
    ...context,
  });
  await sendWebhookEvent("error", {
    message: errorMessage,
    errorMessage,
    ...context,
  });
}

/**
 * Report graceful shutdown to the Central API.
 */
export async function reportShutdown(reason: string): Promise<void> {
  logger.info("Reporting shutdown to Central API", { reason });
  await sendWebhookEvent("shutdown", { reason });
}
