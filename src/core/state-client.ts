/**
 * rlbotline Worker — State Client
 *
 * Thin HTTP wrapper for talking to the Central API's `/state/*` endpoints.
 * The worker NEVER connects to Postgres directly. Authenticates with the
 * per-bot bearer token (`INSTANCE_TOKEN`).
 *
 * Resilience:
 *  - 5s timeout per request (AbortController)
 *  - Up to 3 retries on network errors / 5xx with exponential backoff
 */

let baseUrl: string | null = null;
let bearerToken: string | null = null;

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 3;

export interface StateClientOptions {
  apiBaseUrl: string;
  instanceToken: string;
}

export function configureStateClient(options: StateClientOptions): void {
  baseUrl = options.apiBaseUrl.replace(/\/+$/, "");
  bearerToken = options.instanceToken;
}

function ensureConfigured(): { base: string; token: string } {
  if (!baseUrl || !bearerToken) {
    throw new Error("state-client not configured — call configureStateClient() first");
  }
  return { base: baseUrl, token: bearerToken };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** When true, a 404 returns null instead of throwing. */
  notFoundAsNull?: boolean;
}

/**
 * Perform an HTTP request to the Central API with retries.
 */
export async function stateRequest<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { base, token } = ensureConfigured();
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.retries ?? DEFAULT_RETRIES;

  let url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  if (options.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      clearTimeout(timer);

      if (res.status === 404 && options.notFoundAsNull) {
        return null as T;
      }
      if (res.status >= 500) {
        lastError = new Error(`state ${method} ${path} → ${res.status}`);
      } else if (!res.ok) {
        // 4xx — do not retry, surface immediately.
        const text = await res.text().catch(() => "");
        throw new Error(`state ${method} ${path} → ${res.status} ${text}`);
      } else {
        if (res.status === 204) return undefined as T;
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          return (await res.json()) as T;
        }
        return (await res.text()) as unknown as T;
      }
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
    }

    if (attempt < maxRetries) {
      await sleep(100 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`state-client failed after ${maxRetries + 1} attempts`);
}

/**
 * Liveness check (called on worker boot).
 */
export async function pingStateApi(): Promise<{ ok: boolean; instanceId: string }> {
  return stateRequest<{ ok: boolean; instanceId: string }>("/state/ping");
}
