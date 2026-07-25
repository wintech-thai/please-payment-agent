/**
 * rlbotline Worker — Outbound HTTP tracing
 *
 * Shared request/response logging for every outbound sink (generic forwarder,
 * onix, Central API webhook) so "what did we send where, with which credential,
 * and what came back" is answerable from the console at LOG_LEVEL=debug.
 *
 * Credentials are NEVER logged in plaintext. An `Authorization` header is
 * reduced to its scheme plus a short fingerprint (`sha256:1a2b3c4d`) — enough to
 * tell *which* key was used, and to spot "both sides disagree", without the
 * value ever reaching a log sink.
 */

import { createHash } from "node:crypto";
import { logger } from "./logger.js";

/** Headers whose value must never be logged verbatim. */
const SECRET_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key"]);

/** Max characters of a body kept in a log record (full size is reported too). */
const BODY_PREVIEW_CHARS = 2000;

/** `sha256:1a2b3c4d` — identifies a secret across logs without revealing it. */
export function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

/**
 * Copy headers with secrets masked: `Basic dXNlcjpwYXNz` → `Basic <sha256:1a2b3c4d>`.
 * The scheme survives because "are we even sending Basic?" is a real question.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SECRET_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
      continue;
    }
    const space = value.indexOf(" ");
    const scheme = space > 0 ? value.slice(0, space) : "";
    const secret = space > 0 ? value.slice(space + 1) : value;
    out[key] = scheme ? `${scheme} <${fingerprint(secret)}>` : `<${fingerprint(secret)}>`;
  }
  return out;
}

/** Truncate a body for logging, reporting the true size alongside. */
export function bodyPreview(body: string): { bytes: number; body: string; truncated?: boolean } {
  const bytes = Buffer.byteLength(body);
  if (body.length <= BODY_PREVIEW_CHARS) return { bytes, body };
  return { bytes, body: body.slice(0, BODY_PREVIEW_CHARS), truncated: true };
}

/**
 * Log an outbound request about to be sent. `sink` names the caller
 * ("forward", "onix", "webhook") so one grep follows a single integration.
 */
export function logHttpRequest(
  sink: string,
  req: { method: string; url: string; headers: Record<string, string>; body: string },
  extra?: Record<string, unknown>,
): void {
  const preview = bodyPreview(req.body);
  logger.debug(`${sink} → request`, {
    method: req.method,
    url: req.url,
    headers: redactHeaders(req.headers),
    bodyBytes: preview.bytes,
    body: preview.body,
    bodyTruncated: preview.truncated,
    ...extra,
  });
}

/**
 * Log the response. A non-2xx is a `warn` and carries the response body —
 * the body is where a rejecting server explains itself, and losing it is what
 * turns "onix said no" into an unanswerable question.
 */
export function logHttpResponse(
  sink: string,
  res: {
    method: string;
    url: string;
    status: number;
    statusText?: string;
    durationMs: number;
    body?: string;
    headers?: Record<string, string>;
  },
  extra?: Record<string, unknown>,
): void {
  const ok = res.status >= 200 && res.status < 300;
  const preview = res.body === undefined ? undefined : bodyPreview(res.body);
  const record = {
    method: res.method,
    url: res.url,
    status: res.status,
    statusText: res.statusText,
    durationMs: res.durationMs,
    responseHeaders: res.headers,
    responseBytes: preview?.bytes,
    responseBody: preview?.body,
    responseTruncated: preview?.truncated,
    ...extra,
  };
  if (ok) {
    logger.debug(`${sink} ← response ${res.status}`, record);
  } else {
    logger.warn(`${sink} ← response ${res.status} (non-2xx)`, record);
  }
}

/** Log a transport-level failure (DNS, refused, TLS, timeout/abort). */
export function logHttpError(
  sink: string,
  req: { method: string; url: string; durationMs: number; timeoutMs?: number },
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const aborted = err instanceof Error && err.name === "AbortError";
  logger.warn(`${sink} ✗ request failed`, {
    method: req.method,
    url: req.url,
    durationMs: req.durationMs,
    // An abort is the timeout firing — say so, rather than leaving "The operation
    // was aborted" to be decoded at 3am.
    reason: aborted ? `timeout after ${req.timeoutMs ?? "?"}ms` : message,
    errorName: err instanceof Error ? err.name : typeof err,
    ...extra,
  });
}

/** Read a response body for logging without ever throwing. */
export async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

/** Response headers as a plain object (small, so log them whole). */
export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return redactHeaders(out);
}
