/**
 * rlbotline Worker — onix NotifyLineMessage client
 *
 * Forwards watched bank-OA messages to the onix "destination server" via its
 * AdminAgent NotifyLineMessage action. This is a payload adapter on top of the
 * same idea as `forwarder.ts`, but onix expects a fixed body shape + a specific
 * endpoint and header set (not the generic ForwardedMessage), so it lives here
 * as a dedicated sink.
 *
 * Request (derived from onix examples/Admin/test-admin-agent-notify.rb + utils.rb):
 *   POST {apiUrl}/admin-api/AdminAgent/org/{org}/action/NotifyLineMessage/{agentId}
 *   Authorization:         Basic base64("{apiUser}:{apiKey}")   // user "api", pass = key
 *   Content-Type:          application/json
 *   Onix-Application-Type: backend
 *   {
 *     "sourceType":  "NOTIFICATION",
 *     "sourceKey":   "jp.naver.line.android",
 *     "sourceLabel": "LINE",
 *     "title":       "<OA display name>",
 *     "text":        "<message text>"
 *   }
 *
 * Like `forwarder.ts`, this never throws — it returns a result record so the
 * caller can log/aggregate failures without breaking the intercept path.
 */

import { logger } from "./logger.js";
import type { OnixConfig } from "../types.js";

/** Constant envelope fields for a LINE-sourced notification (see onix examples). */
const SOURCE_TYPE = "NOTIFICATION";
const SOURCE_KEY = "jp.naver.line.android";
const SOURCE_LABEL = "LINE";

let config: OnixConfig | null = null;

export interface OnixNotifyInput {
  /** OA display name → onix `title` (e.g. "Krungthai Connext"). */
  title: string;
  /** Message body → onix `text`. */
  text: string;
}

export interface OnixResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** True when onix is not configured and the call was skipped. */
  skipped?: boolean;
}

/** Configure the onix client once on startup. No-op fields when disabled. */
export function configureOnix(opts: OnixConfig): void {
  config = opts;
  logger.info("onix client configured", {
    enabled: opts.enabled,
    apiUrl: opts.enabled ? opts.apiUrl : undefined,
    org: opts.org,
    appType: opts.appType,
  });
}

/** True when the onix target is fully configured and forwarding is active. */
export function isOnixEnabled(): boolean {
  return config?.enabled === true;
}

/** Full NotifyLineMessage endpoint for the configured agent. */
function buildEndpoint(cfg: OnixConfig): string {
  return `${cfg.apiUrl}/admin-api/AdminAgent/org/${cfg.org}/action/NotifyLineMessage/${cfg.agentId}`;
}

/** Basic auth header value — user "api", password = the configured API key. */
function buildBasicAuth(cfg: OnixConfig): string {
  return `Basic ${Buffer.from(`${cfg.apiUser}:${cfg.apiKey}`).toString("base64")}`;
}

/**
 * POST one LINE message to onix as a NotifyLineMessage. Never throws.
 * Returns `{ skipped: true }` when onix is unconfigured.
 */
export async function notifyLineMessage(input: OnixNotifyInput): Promise<OnixResult> {
  const cfg = config;
  if (!cfg || !cfg.enabled) {
    return { ok: false, skipped: true };
  }

  const body = JSON.stringify({
    sourceType: SOURCE_TYPE,
    sourceKey: SOURCE_KEY,
    sourceLabel: SOURCE_LABEL,
    title: input.title,
    text: input.text,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(buildEndpoint(cfg), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Onix-Application-Type": cfg.appType,
        Authorization: buildBasicAuth(cfg),
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn("onix notify returned non-OK", { status: res.status, title: input.title });
      return { ok: false, status: res.status };
    }
    logger.debug("onix notify ok", { status: res.status, title: input.title });
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("onix notify failed", { error: msg, title: input.title });
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
