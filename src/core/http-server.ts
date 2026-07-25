/**
 * rlbotline Worker — Inbound HTTP API
 *
 * A small HTTP server (Bun.serve) exposed by the standalone app container on
 * `HTTP_PORT` (default 3000). It lets whoever runs the container drive login
 * over HTTP instead of a control-plane WS RPC:
 *
 *   GET  /health           → liveness + current login state (no auth)
 *   GET  /status           → who is logged in, deployed build, downstream wiring
 *   GET  /login/status     → full login status (qrUrl / pincode / profile)
 *   POST /login/qr         → start a QR login; waits briefly for the QR URL
 *   POST /login/password   → start an email/password login  { email, password }
 *
 * `/login/*` require HTTP Basic auth ("{HTTP_API_USER}:{HTTP_API_KEY}") when
 * `HTTP_API_KEY` is set; with no key the API is unauthenticated (logged loudly).
 *
 * Login runs in the background — the QR URL, PIN, and result are read back via
 * `/login/status` (and mirrored to the control-plane webhook as before).
 */

import { logger } from "./logger.js";
import { getLoginStatus } from "./login-state.js";
import { startQrLogin, startPasswordLogin } from "./line-client.js";
import { getBuildInfo } from "./build-info.js";
import { isRedisEnabled, redisKey } from "./redis-client.js";
import { isOnixEnabled } from "./onix-client.js";
import { listWatched } from "./chat-registry.js";
import type { WorkerConfig } from "../types.js";

/** How long POST /login/qr waits for the QR URL before replying without it. */
const QR_WAIT_MS = 12_000;

let server: ReturnType<typeof Bun.serve> | null = null;
const bootAt = Date.now();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Basic realm="rlbotline"',
    },
  });
}

/** Basic-auth check. Open (true) when no key is configured. */
function isAuthorized(req: Request, config: WorkerConfig): boolean {
  if (!config.httpApiKey) return true;
  const expected = `Basic ${Buffer.from(`${config.httpApiUser}:${config.httpApiKey}`).toString("base64")}`;
  return (req.headers.get("authorization") ?? "") === expected;
}

/** Poll the login status until a QR URL appears, login settles, or we time out. */
async function waitForQrUrl(timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = getLoginStatus();
    if (s.qrUrl) return s.qrUrl;
    if (s.state === "ready" || s.state === "error") return s.qrUrl;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getLoginStatus().qrUrl;
}

async function handle(req: Request, config: WorkerConfig): Promise<Response> {
  const path = new URL(req.url).pathname;

  // Liveness — always open so container/orchestrator health checks work.
  if (req.method === "GET" && path === "/health") {
    return json({
      ok: true,
      instanceId: config.instanceId,
      uptimeSec: Math.floor((Date.now() - bootAt) / 1000),
      login: getLoginStatus().state,
    });
  }

  // Everything below is login control — gate behind Basic auth.
  if (!isAuthorized(req, config)) return unauthorized();

  // Operational snapshot: who is logged in, which code is running, and whether
  // each downstream (session store, forward sink, onix) is actually wired up.
  if (req.method === "GET" && path === "/status") {
    const login = getLoginStatus();
    const watched = listWatched();
    return json({
      ok: true,
      instanceId: config.instanceId,
      botName: config.botName,
      uptimeSec: Math.floor((Date.now() - bootAt) / 1000),

      // 1. Is anyone logged in — and who?
      login: {
        loggedIn: login.state === "ready",
        state: login.state,
        profileName: login.profileName,
        profileMid: login.profileMid,
        awaitingScan: login.state === "qr_pending",
        awaitingPin: login.state === "pin_pending",
        error: login.error,
        updatedAt: login.updatedAt,
      },

      // 2. Which code is deployed.
      build: getBuildInfo(),

      // 3. Downstream wiring — "configured" is what the operator can act on.
      session: {
        store: isRedisEnabled() ? "redis" : "memory",
        persistent: isRedisEnabled(),
        keyPrefix: isRedisEnabled() ? redisKey("").replace(/:$/, "") : undefined,
      },
      forward: {
        // The generic sink. No URL means watched messages have nowhere to go.
        webhookUrl: config.webhookUrl,
        configured: Boolean(config.webhookUrl),
        signed: Boolean(config.watchHmacSecret),
        timeoutMs: config.forwardTimeoutMs,
      },
      onix: {
        enabled: isOnixEnabled(),
        apiUrl: config.onix.enabled ? config.onix.apiUrl : undefined,
        org: config.onix.org,
        agentId: config.onix.enabled ? config.onix.agentId : undefined,
        apiUser: config.onix.apiUser,
      },
      centralApi: {
        enabled: config.centralApiEnabled,
        apiBaseUrl: config.apiBaseUrl,
      },
      watched: {
        total: watched.length,
        oa: watched.filter((w) => w.chatType === "oa").length,
        enabled: watched.filter((w) => w.enabled).length,
        chats: watched.map((w) => ({
          chatId: w.chatId,
          chatName: w.chatName,
          chatType: w.chatType,
          enabled: w.enabled,
        })),
      },
    });
  }

  if (req.method === "GET" && path === "/login/status") {
    return json({ ok: true, ...getLoginStatus() });
  }

  if (req.method === "POST" && path === "/login/qr") {
    // Fire-and-forget: startQrLogin blocks until the scan completes, so we must
    // not await it here. The QR URL is surfaced via login-state below.
    void startQrLogin(config).catch((err) => {
      logger.error("HTTP /login/qr failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const qrUrl = await waitForQrUrl(QR_WAIT_MS);
    return json({ ok: true, state: getLoginStatus().state, qrUrl }, 202);
  }

  if (req.method === "POST" && path === "/login/password") {
    let body: { email?: string; password?: string };
    try {
      body = (await req.json()) as { email?: string; password?: string };
    } catch {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (!body.email || !body.password) {
      return json({ ok: false, error: "email and password are required" }, 400);
    }
    void startPasswordLogin(config, body.email, body.password).catch((err) => {
      logger.error("HTTP /login/password failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return json({ ok: true, state: "starting" }, 202);
  }

  return json({ ok: false, error: "not found" }, 404);
}

/**
 * Start the inbound HTTP API. No-op (returns null) when `HTTP_PORT` is 0.
 * Returns the bound port so callers/tests know where it's listening.
 */
export function startHttpServer(config: WorkerConfig): number | null {
  if (!config.httpApiEnabled) {
    logger.info("HTTP API disabled", { httpPort: config.httpPort });
    return null;
  }
  if (server) return server.port ?? null;

  server = Bun.serve({
    port: config.httpPort,
    fetch: (req) => handle(req, config),
  });

  if (!config.httpApiKey) {
    logger.warn("HTTP API is UNAUTHENTICATED — set HTTP_API_KEY to require Basic auth");
  }
  logger.info("HTTP API listening", { port: server.port });
  return server.port ?? null;
}

export function stopHttpServer(): void {
  if (server) {
    server.stop(true);
    server = null;
    logger.info("HTTP API stopped");
  }
}
