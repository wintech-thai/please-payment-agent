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
 * When ONIX_API_URL already contains the NotifyLineMessage action path, it is the
 * full endpoint and is used verbatim — nothing is appended (see resolveEndpoint).
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
import {
  headersToObject,
  logHttpError,
  logHttpRequest,
  logHttpResponse,
  safeReadBody,
} from "./http-log.js";
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

/**
 * Full NotifyLineMessage endpoint for the configured agent.
 *
 * ONIX_API_URL is normally the API base URL and the standard action path is
 * appended from org + agentId. A deployment can instead configure the FULL
 * endpoint (URL already containing the NotifyLineMessage action path) — then it
 * is used verbatim, so the POST hits exactly ONIX_API_URL.
 */
export function resolveEndpoint(cfg: Pick<OnixConfig, "apiUrl" | "org" | "agentId">): string {
  if (cfg.apiUrl.includes("/action/NotifyLineMessage")) return cfg.apiUrl;
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

  const url = resolveEndpoint(cfg);
  const headers = {
    "Content-Type": "application/json",
    "Onix-Application-Type": cfg.appType,
    Authorization: buildBasicAuth(cfg),
  };
  // org/agent/user identify WHICH onix target and identity was used — the fields
  // you compare against onix's side when a notify is rejected.
  const trace = { title: input.title, org: cfg.org, agentId: cfg.agentId, apiUser: cfg.apiUser };
  logHttpRequest("onix", { method: "POST", url, headers, body }, trace);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const responseBody = await safeReadBody(res);
    logHttpResponse(
      "onix",
      {
        method: "POST",
        url,
        status: res.status,
        statusText: res.statusText,
        durationMs: Date.now() - startedAt,
        headers: headersToObject(res.headers),
        body: responseBody,
      },
      trace,
    );
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logHttpError(
      "onix",
      { method: "POST", url, durationMs: Date.now() - startedAt, timeoutMs: cfg.timeoutMs },
      err,
      trace,
    );
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
