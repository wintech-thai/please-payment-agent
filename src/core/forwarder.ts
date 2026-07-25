/**
 * rlbotline Worker — Outbound Forwarder
 *
 * POSTs JSON payloads to external URLs (per-chat forwardUrl) and the Central
 * API webhook. Signs each request with HMAC-SHA256 when WATCH_HMAC_SECRET is
 * configured.
 *
 * Signature scheme (compatible with the Standard Webhooks spec):
 *   X-Webhook-Id:        unique event id
 *   X-Webhook-Timestamp: unix seconds
 *   X-Webhook-Signature: "v1," + base64( hmacSha256( `${id}.${ts}.${body}` ) )
 */

import { createHmac, randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import {
  headersToObject,
  logHttpError,
  logHttpRequest,
  logHttpResponse,
  safeReadBody,
} from "./http-log.js";
import type { OutboundWebhookTarget } from "../types.js";

export interface ForwardedMessage {
  /** Unique LINE message id */
  messageId: string;
  /** Source chat id (group / oa / user MID) */
  chatId: string;
  /** Cached display name for the chat (from watched_chats.chat_name) */
  chatName: string;
  /** Chat type (group / oa / user / ...) */
  chatType: string;
  /** Sender MID */
  senderId: string;
  /** Message content type label (TEXT / IMAGE / STICKER / ...) */
  contentType: string;
  /** Plain text body (may be empty for media) */
  text: string;
  /** Unix milliseconds — receive time at the worker */
  receivedAt: number;
  /** Worker instance id (from config.instanceId) */
  instanceId: string;
  /** Raw LINE message object (msg.raw.raw — the underlying wire Message struct). Optional. */
  raw?: unknown;
}

export interface ForwardResult {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

let secret: string | undefined;
let timeoutMs = 5000;

export function configureForwarder(opts: {
  hmacSecret: string | undefined;
  timeoutMs: number;
}): void {
  secret = opts.hmacSecret;
  timeoutMs = opts.timeoutMs;
  logger.info("Forwarder configured", {
    signing: secret ? "hmac-sha256" : "disabled",
    timeoutMs,
  });
}

/**
 * Build the signature headers for a given body.
 * Returns an empty set of crypto headers when no secret is configured.
 */
function buildHeaders(body: string): Record<string, string> {
  const id = randomUUID();
  const ts = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rlbotline-worker/1.0",
    "X-Webhook-Id": id,
    "X-Webhook-Timestamp": ts,
  };
  if (secret) {
    const mac = createHmac("sha256", secret)
      .update(`${id}.${ts}.${body}`)
      .digest("base64");
    headers["X-Webhook-Signature"] = `v1,${mac}`;
  }
  return headers;
}

function normalizeTarget(target: string | OutboundWebhookTarget): OutboundWebhookTarget | null {
  if (typeof target === "string") {
    const url = target.trim();
    return url.length > 0 ? { url } : null;
  }

  const url = target.url.trim();
  if (url.length === 0) {
    return null;
  }

  const token = typeof target.token === "string" && target.token.trim().length > 0
    ? target.token.trim()
    : null;

  return token ? { url, token } : { url };
}

function buildApiKeyAuthorization(apiKey: string): string {
  return `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`;
}

/**
 * JSON.stringify replacer — the raw LINE wire `Message` struct carries
 * `bigint` fields (e.g. createdTime/deliveredTime via linejs' Int64), which
 * JSON.stringify throws on natively. Coerce to string so forwarding never
 * breaks once a `raw` payload is attached.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * POST `payload` to `url` with signed headers. Never throws — returns a result
 * record so callers can log/aggregate failures across multiple targets.
 */
export async function forwardTo(
  target: string | OutboundWebhookTarget,
  payload: ForwardedMessage,
): Promise<ForwardResult> {
  const normalized = normalizeTarget(target);
  if (!normalized) {
    return { url: "", ok: false, error: "invalid target" };
  }

  const body = JSON.stringify(payload, jsonReplacer);
  const headers = buildHeaders(body);
  if (normalized.token) {
    headers["Authorization"] = buildApiKeyAuthorization(normalized.token);
  }
  const trace = {
    messageId: payload.messageId,
    chatId: payload.chatId,
    signed: Boolean(headers["X-Webhook-Signature"]),
    authenticated: Boolean(normalized.token),
  };
  logHttpRequest("forward", { method: "POST", url: normalized.url, headers, body }, trace);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(normalized.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const responseBody = await safeReadBody(res);
    logHttpResponse(
      "forward",
      {
        method: "POST",
        url: normalized.url,
        status: res.status,
        statusText: res.statusText,
        durationMs: Date.now() - startedAt,
        headers: headersToObject(res.headers),
        body: responseBody,
      },
      trace,
    );
    if (!res.ok) {
      return { url: normalized.url, ok: false, status: res.status };
    }
    return { url: normalized.url, ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logHttpError(
      "forward",
      { method: "POST", url: normalized.url, durationMs: Date.now() - startedAt, timeoutMs },
      err,
      trace,
    );
    return { url: normalized.url, ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan out a payload to multiple URLs in parallel. Logs aggregate failures.
 */
export async function fanOut(
  targets: Array<string | OutboundWebhookTarget>,
  payload: ForwardedMessage,
): Promise<ForwardResult[]> {
  const uniqueTargets = new Map<string, OutboundWebhookTarget>();
  for (const target of targets) {
    const normalized = normalizeTarget(target);
    if (!normalized) continue;
    const key = `${normalized.url}\u0000${normalized.token ?? ""}`;
    uniqueTargets.set(key, normalized);
  }

  const unique = Array.from(uniqueTargets.values());
  if (unique.length === 0) return [];
  const results = await Promise.all(unique.map((target) => forwardTo(target, payload)));
  for (const r of results) {
    if (!r.ok) {
      logger.warn("Forward failed", {
        url: r.url,
        status: r.status,
        error: r.error,
        messageId: payload.messageId,
      });
    }
  }
  return results;
}
