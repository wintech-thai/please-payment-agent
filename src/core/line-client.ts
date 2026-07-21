/**
 * rlbotline Worker — LINE Client Manager
 *
 * Manages the LINE client lifecycle. State persistence (auth token + linejs
 * FileStorage blob) lives in the Central API; the worker is stateless on disk.
 *
 *  - Smart auth flow (token-first, fallback to email/password)
 *  - Custom Storage adapter that flushes JSON to PUT /state/session/storage
 *  - `update:authtoken` listener mirrors the token to /state/session/auth-token
 */

import { loginWithPassword, loginWithAuthToken, loginWithQR } from "@evex/linejs";
import type { Client } from "@evex/linejs";
import { BaseStorage, type Storage } from "@evex/linejs/storage";
import { logger } from "./logger.js";
import { reportPincode, reportQr, reportReady, reportStatus } from "./webhook.js";
import { setLoginStatus } from "./login-state.js";
import { stateRequest } from "./state-client.js";
import { initSharedLimiter, gateOutbound } from "./rate-limiter.js";
import { isGroupCommandEnabled, isFleetMember, reportOwnProfileMid } from "./database.js";
import { getCommandContext } from "./command-context.js";
import type { WorkerConfig } from "../types.js";

type Device = "DESKTOPWIN" | "DESKTOPMAC" | "ANDROID" | "ANDROIDSECONDARY" | "IOS" | "IOSIPAD" | "WATCHOS" | "WEAROS";

/** Outcome of a `kickFromGroup` call: who was kicked, and who the fleet guard refused. */
export interface KickResult {
  kicked: string[];
  skipped: string[];
}

export type LineClientInitResult =
  | { kind: "ready" }
  | { kind: "onboarding-required" }
  | { kind: "pin-timeout"; requestedAt: number; timeoutMs: number }
  | { kind: "login-failed"; message: string; attempts: number };

let client: Client | null = null;
let botMid = "";
/** Device + storage passed to linejs login — cached so an on-demand re-login
 *  (triggered by the `login_qr`/`login_password` RPCs) reuses the same session
 *  storage instead of dropping the persisted blob. */
let loginDeviceOptions: { device: Device; storage: BaseStorage } | null = null;
/** True while a login attempt is running, so a bootstrap login and an RPC-
 *  triggered login can't run concurrently and fight over the client. */
let loginInFlight = false;
const PIN_TIMEOUT_POLL_MS = 250;
const PIN_TIMEOUT_REASON = "pin_timeout";
const PIN_TIMEOUT_MESSAGE = "PIN wait timed out; restart the bot to request a new PIN";
const MAX_LOGIN_ATTEMPTS = 3;
const LOGIN_RETRY_DELAY_MS = 1000;

export function getClient(): Client {
  if (!client) {
    throw new Error("LINE client not initialized. Call initLineClient() first.");
  }
  return client;
}

export function isClientReady(): boolean {
  return client !== null;
}

export function getKnownBotMid(): string {
  return botMid;
}

/**
 * Load the persisted session blobs from the Central API.
 */
async function loadSessionFromApi(): Promise<{
  authToken: string | null;
  storage: string | null;
  lineEmail: string | null;
  linePassword: string | null;
}> {
  try {
    const res = await stateRequest<{
      authToken: string | null;
      storage: string | null;
      lineEmail: string | null;
      linePassword: string | null;
    }>(
      "/state/session",
    );
    if (res.authToken) logger.info("Loaded persisted auth token from Central API");
    return {
      authToken: res.authToken ?? null,
      storage: res.storage ?? null,
      lineEmail: res.lineEmail ?? null,
      linePassword: res.linePassword ?? null,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn("Failed to load session from Central API", { error: msg });
    return { authToken: null, storage: null, lineEmail: null, linePassword: null };
  }
}

/**
 * In-memory linejs storage that mirrors all mutations to the Central API
 * via PUT /state/session/storage. Writes are debounced (1s) and retried.
 */
class ApiSessionStorage extends BaseStorage {
  private data: Record<string, Storage["Value"]> = {};
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(initial?: Record<string, Storage["Value"]>) {
    super();
    if (initial) this.data = { ...initial };
  }

  public async set(key: Storage["Key"], value: Storage["Value"]): Promise<void> {
    this.data[key] = value;
    this.scheduleFlush();
  }

  public async get(key: Storage["Key"]): Promise<Storage["Value"] | undefined> {
    return this.data[key];
  }

  public async delete(key: Storage["Key"]): Promise<void> {
    delete this.data[key];
    this.scheduleFlush();
  }

  public async clear(): Promise<void> {
    this.data = {};
    this.scheduleFlush();
  }

  public async getAll(): Promise<Record<Storage["Key"], Storage["Value"]>> {
    return { ...this.data };
  }

  public async migrate(target: BaseStorage): Promise<void> {
    for (const key in this.data) {
      if (Object.prototype.hasOwnProperty.call(this.data, key)) {
        await target.set(key, this.data[key] as Storage["Value"]);
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => {
        logger.error("Session storage flush failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 1000);
  }

  private async flush(reqOptions?: { retries?: number; timeoutMs?: number }): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    const snapshot = JSON.stringify(this.data);
    this.flushInFlight = stateRequest("/state/session/storage", {
      method: "PUT",
      body: { storage: snapshot },
      ...reqOptions,
    }).then(() => undefined);
    try {
      await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
    }
  }

  /**
   * Force the latest snapshot to the Central API right now, cancelling the
   * debounce. Called on graceful shutdown so a session mutation from the last
   * ~1s (a refreshed authToken, or — critically — a freshly registered E2EE
   * `e2eeKeys:*` entry) isn't lost when the process exits. Losing it would make
   * the next boot restore a stale blob, risk a fresh QR/password login, and
   * rotate the Letter Sealing key — breaking decryption for messages sent
   * before the rotation. Awaits any in-flight write first so the final PUT
   * carries the newest data, never an older snapshot.
   */
  public async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushInFlight) {
      try {
        await this.flushInFlight;
      } catch {
        // A failed in-flight write is retried by the final flush below.
      }
    }
    // Bounded on the shutdown path (2 attempts, 3s each) so a slow/unreachable
    // API can't push the flush past Docker's ~10s stop grace and starve the
    // rest of the shutdown (closeDatabase, etc.).
    await this.flush({ retries: 1, timeoutMs: 3000 });
  }
}

/**
 * Module-level handle to the active session storage, so `flushSession()` can
 * force a final persist on shutdown without threading the instance through.
 */
let sessionStorage: ApiSessionStorage | null = null;

/**
 * Force-persist the LINE session storage (auth token + E2EE keys) to the
 * Central API immediately. Best-effort, for the graceful-shutdown path — see
 * `ApiSessionStorage.flushNow()` for why losing the last write matters.
 */
export async function flushSession(): Promise<void> {
  if (!sessionStorage) return;
  try {
    await sessionStorage.flushNow();
    logger.info("Session storage flushed on shutdown");
  } catch (error) {
    logger.warn("Session storage flush on shutdown failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Persist the LINE auth token to the Central API so it survives worker
 * restarts (token-first login next boot instead of a fresh QR scan).
 */
function persistAuthToken(authtoken: string): void {
  stateRequest("/state/session/auth-token", {
    method: "PUT",
    body: { authToken: authtoken },
  }).catch((error) => {
    logger.error("Failed to persist auth token to Central API", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Set up auth-token persistence. linejs emits `update:authtoken` *during*
 * login() — before this runs — so the initial QR/password token would be
 * missed if we only listened for future refreshes. Persist the current token
 * once here, then keep the listener for subsequent refreshes.
 */
function setupTokenPersistence(lineClient: Client): void {
  lineClient.base.on("update:authtoken", (authtoken: string) => {
    logger.info("Auth token updated by linejs — pushing to Central API");
    persistAuthToken(authtoken);
  });

  const current = lineClient.base.authToken;
  if (current) {
    logger.info("Persisting initial auth token after login");
    persistAuthToken(current);
  }
}

function parseDevice(device: string): Device {
  const validDevices: Device[] = [
    "DESKTOPWIN", "DESKTOPMAC", "ANDROID", "ANDROIDSECONDARY",
    "IOS", "IOSIPAD", "WATCHOS", "WEAROS",
  ];
  if (validDevices.includes(device as Device)) {
    return device as Device;
  }
  logger.warn("Invalid device string, defaulting to IOSIPAD", { device });
  return "IOSIPAD";
}

/**
 * `setTimeout` that resolves early (without firing the full delay) if
 * `signal` aborts — lets a poll loop stop immediately instead of waiting out
 * its last scheduled tick.
 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Poll `getRequestedAt` until `timeoutMs` has elapsed since it was set, or
 * `signal` aborts. Runs as the "losing" side of a `Promise.race` against the
 * actual login call in `initLineClient` — once the login side settles
 * (success or failure), the caller aborts `signal` so this loop stops
 * ticking instead of continuing to poll every `PIN_TIMEOUT_POLL_MS` until
 * `pinWaitTimeoutMs` elapses on a login attempt that has already finished
 * (each abandoned poller was ~720 wasted wakeups on a parked worker under a
 * 256m/0.2cpu container cap). When aborted, this never resolves — nothing
 * awaits it past that point since the race already settled on the other
 * branch, so parking here is the fix, not a leak.
 */
export async function waitForPinTimeout(
  getRequestedAt: () => number | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ requestedAt: number; timeoutMs: number }> {
  while (true) {
    if (signal?.aborted) {
      await new Promise<never>(() => {});
    }

    const requestedAt = getRequestedAt();
    if (requestedAt !== null) {
      const remainingMs = requestedAt + timeoutMs - Date.now();
      if (remainingMs <= 0) {
        return { requestedAt, timeoutMs };
      }
      await sleepAbortable(Math.min(PIN_TIMEOUT_POLL_MS, remainingMs), signal);
      continue;
    }

    await sleepAbortable(PIN_TIMEOUT_POLL_MS, signal);
  }
}

/** A single login-attempt outcome, shared shape for QR and email/password. */
type LoginAttemptOutcome =
  | { kind: "ready"; lineClient: Client }
  | { kind: "pin-timeout"; requestedAt: number; timeoutMs: number };

/**
 * A small, conservative allowlist of known LINE `TalkException` codes that
 * mean the server flatly rejected the credentials (wrong password / no such
 * account). linejs surfaces these as `InternalError("RequestError", ..., data)`
 * where `data.code` carries the raw thrift exception code (see
 * `@evex/linejs` `base/request/mod.ts` ~L244-251). These codes are NOT
 * live-captured against this codebase's own traffic (unlike `LineOpType` —
 * see `.research/line-op-type-verification.md`); they're the stable,
 * widely-documented LINE TalkService codes used across other LINE client
 * reimplementations. Kept intentionally narrow — anything not on this list
 * falls through to "transient" in `isTerminalLoginError` below, per the
 * conservative-by-default rule (retrying a genuinely transient error is
 * cheap; treating a transient error as terminal parks the worker for no
 * reason, so unknown codes must NOT be treated as terminal).
 */
const TERMINAL_LOGIN_ERROR_CODES = new Set([
  "NOT_FOUND_ACCOUNT_OR_INCORRECT_PASSWORD",
  "INCORRECT_PASSWORD",
  "INVALID_PASSWORD",
]);

/**
 * Classify a login-attempt error as terminal (retrying can never succeed) or
 * transient (network blip, timeout, 5xx — worth retrying).
 *
 * Terminal cases handled:
 *  - `InternalError("RegExpUnmatch", "invalid email"/"invalid password")` —
 *    linejs's own pre-flight format validation (`base/login/mod.ts:330,333`,
 *    `withPassword`). This never even reaches LINE's servers — the exact
 *    same email/password string will fail identically every time, so
 *    retrying 3x just burns 2 extra rapid failed attempts for zero chance of
 *    success (and datacenter-IP rapid-retry is itself a known ban/
 *    verification trigger — see project anti-ban constraints).
 *  - A `RequestError` whose underlying thrift code is in
 *    `TERMINAL_LOGIN_ERROR_CODES` — the server explicitly rejected the
 *    credentials (see that const's doc comment for the confidence caveat).
 *
 * Anything else — including a `RequestError` whose code isn't recognized —
 * is treated as transient. Be conservative: an unclassified error keeps the
 * full retry cap rather than parking prematurely.
 */
function isTerminalLoginError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // linejs's `InternalError` overloads `.name` as its own error "type" tag
  // (see `@evex/linejs` `base/core/utils/error.ts`), not JS's builtin
  // `Error.name` semantics.
  const type = (error as { name?: string }).name;

  if (type === "RegExpUnmatch") return true;

  if (type === "RequestError") {
    const data = (error as { data?: { code?: unknown } }).data;
    const code = data?.code;
    if (typeof code === "string" && TERMINAL_LOGIN_ERROR_CODES.has(code)) {
      return true;
    }
  }

  return false;
}

/**
 * Run `performAttempt` up to `MAX_LOGIN_ATTEMPTS` times with linear backoff
 * (`LOGIN_RETRY_DELAY_MS * attempt`, mirroring `webhook.ts`'s retry loop) —
 * shared by both the QR and email/password login paths below so the same
 * counter/backoff/park behavior applies to whichever method is active.
 *
 * A `pin-timeout` does NOT consume an attempt — it's not a retryable
 * failure, just an unscanned QR / un-entered PIN — so it returns
 * immediately. Only a hard login error counts against the cap. On the
 * final failure we report status + park instead of throwing, so a
 * crash-looping container under `RestartPolicy: unless-stopped` can't spin
 * forever with zero backoff (and the in-process counter can't be reset by
 * a restart, unlike one that lived in persisted state).
 */
/**
 * Warn (log + dashboard) that a fresh login just rotated the LINE E2EE /
 * Letter Sealing key. Best-effort: a failed webhook must never break login.
 */
async function alertE2EEKeyRotation(methodLabel: string, hadToken: boolean): Promise<void> {
  logger.warn(
    "⚠️ Letter Sealing (E2EE) key rotated — fresh login, not a token restore",
    {
      reason: "e2ee_key_rotated",
      method: methodLabel,
      hadToken,
      impact:
        "messages encrypted to the previous key can no longer be decrypted; senders must resend",
      note: hadToken
        ? "a persisted token existed but token-restore still failed — investigate before this recurs"
        : "no prior token (onboarding login) — expected the first time this bot logs in",
    },
  );
  const th = hadToken
    ? `⚠️ บอทล็อกอินใหม่ผ่าน ${methodLabel} ทั้งที่มี token เดิม — กุญแจ Letter Sealing (E2EE) หมุนใหม่ ข้อความที่เข้ารหัสก่อนหน้านี้อาจถอดรหัสไม่ได้ (ให้ผู้ส่งส่งใหม่)`
    : `บอทล็อกอินครั้งแรกผ่าน ${methodLabel} — ตั้งกุญแจ Letter Sealing (E2EE) ใหม่ตามปกติ`;
  try {
    await reportStatus("running", th, {
      reason: "e2ee_key_rotated",
      method: methodLabel,
      hadToken,
    });
  } catch {
    // Dashboard alert is best-effort; the log line above is the source of truth.
  }
}

async function attemptLoginWithRetry(
  performAttempt: () => Promise<LoginAttemptOutcome>,
  methodLabel: string,
  hadToken: boolean,
): Promise<LineClientInitResult> {
  let lastMessage = `${methodLabel} login failed`;

  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    try {
      const loginResult = await performAttempt();

      if (loginResult.kind === "pin-timeout") {
        logger.warn(`${methodLabel} login timed out before it was completed`, {
          timeoutMs: loginResult.timeoutMs,
          requestedAt: loginResult.requestedAt,
        });
        await reportStatus("stopped", PIN_TIMEOUT_MESSAGE, {
          reason: PIN_TIMEOUT_REASON,
          requestedAt: loginResult.requestedAt,
          timeoutMs: loginResult.timeoutMs,
        });
        setLoginStatus({ state: "error", error: PIN_TIMEOUT_MESSAGE });
        return loginResult;
      }

      client = loginResult.lineClient;
      setupTokenPersistence(client);
      await onClientReady(client);
      // This path is ONLY reached for a fresh QR/email-password login (the
      // token-restore path in initLineClient never calls here), so linejs just
      // ran registerE2EEKeyPair() and rotated the Letter Sealing (E2EE) key.
      // Messages encrypted to the OLD key can no longer be decrypted — hence the
      // "ถอดรหัสไม่สำเร็จ" reports. Alert loudly (and surface on the dashboard) so
      // the operator knows a key rotation just happened. `hadToken` separates a
      // routine onboarding scan (no prior token) from the worrying case: a token
      // existed but token-restore still failed, which shouldn't normally happen.
      await alertE2EEKeyRotation(methodLabel, hadToken);
      return { kind: "ready" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      lastMessage = msg;

      if (isTerminalLoginError(error)) {
        // Deterministic failure — retrying the exact same credentials/QR
        // flow can never succeed, and rapid repeated failed logins from a
        // datacenter IP is itself a ban/verification trigger. Park on the
        // FIRST occurrence instead of burning the remaining attempts.
        logger.error(`${methodLabel} login failed with a terminal error — parking without retry`, {
          attempt,
          error: msg,
        });
        await reportStatus("error", msg, { reason: "login_failed" });
        setLoginStatus({ state: "error", error: msg });
        return { kind: "login-failed", message: msg, attempts: attempt };
      }

      logger.error(`${methodLabel} login attempt failed`, {
        attempt,
        maxAttempts: MAX_LOGIN_ATTEMPTS,
        error: msg,
      });

      if (attempt < MAX_LOGIN_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, LOGIN_RETRY_DELAY_MS * attempt));
      }
    }
  }

  logger.error(`${methodLabel} login exhausted all attempts — parking worker`, {
    attempts: MAX_LOGIN_ATTEMPTS,
    error: lastMessage,
  });
  await reportStatus("error", lastMessage, { reason: "login_failed" });
  setLoginStatus({ state: "error", error: lastMessage });
  return { kind: "login-failed", message: lastMessage, attempts: MAX_LOGIN_ATTEMPTS };
}

/**
 * Build a QR-login attempt: races `loginWithQR` against the PIN-wait timeout,
 * wiring the QR URL + PIN callbacks to the Central API reporters (`reportQr`/
 * `reportPincode`) so the central web can relay them to whoever requested the
 * login. Shared by the bootstrap flow and the on-demand `startQrLogin`.
 */
function buildQrAttempt(
  deviceOptions: { device: Device; storage: BaseStorage },
  pinWaitTimeoutMs: number,
): () => Promise<LoginAttemptOutcome> {
  return async () => {
    let qrRequestedAt: number | null = null;
    // Cancels the losing side of the race once it settles, so a finished login
    // attempt doesn't leave `waitForPinTimeout` polling until the timeout.
    const pinTimeoutAbort = new AbortController();
    try {
      return await Promise.race([
        loginWithQR(
          {
            onReceiveQRUrl(url: string) {
              qrRequestedAt = Date.now();
              // Log the URL too so a standalone worker can be logged in by
              // scanning it straight from the container logs.
              logger.info("QR login URL received — scan to log in", { url });
              setLoginStatus({ state: "qr_pending", qrUrl: url });
              reportQr(url).catch((err) => {
                logger.error("Failed to report QR URL", {
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            },
            onPincodeRequest(pincode: string) {
              logger.info("QR PIN code received", { pincode });
              setLoginStatus({ state: "pin_pending", pincode });
              reportPincode(pincode).catch((err) => {
                logger.error("Failed to report PIN code", {
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            },
          },
          deviceOptions,
        ).then((lineClient) => ({ kind: "ready" as const, lineClient })),
        waitForPinTimeout(() => qrRequestedAt, pinWaitTimeoutMs, pinTimeoutAbort.signal).then(
          (timeout) => ({ kind: "pin-timeout" as const, ...timeout }),
        ),
      ]);
    } finally {
      pinTimeoutAbort.abort();
    }
  };
}

/**
 * Build an email/password login attempt: races `loginWithPassword` against the
 * PIN-wait timeout, reporting any 2FA PIN via `reportPincode`. Shared by the
 * bootstrap flow and the on-demand `startPasswordLogin`.
 */
function buildPasswordAttempt(
  deviceOptions: { device: Device; storage: BaseStorage },
  email: string,
  password: string,
  pinWaitTimeoutMs: number,
): () => Promise<LoginAttemptOutcome> {
  return async () => {
    let pinRequestedAt: number | null = null;
    const pinTimeoutAbort = new AbortController();
    try {
      return await Promise.race([
        loginWithPassword(
          {
            email,
            password,
            onPincodeRequest(pincode: string) {
              pinRequestedAt = Date.now();
              logger.info("PIN code received", { pincode });
              setLoginStatus({ state: "pin_pending", pincode });
              reportPincode(pincode).catch((err) => {
                logger.error("Failed to report PIN code", {
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            },
          },
          deviceOptions,
        ).then((lineClient) => ({ kind: "ready" as const, lineClient })),
        waitForPinTimeout(() => pinRequestedAt, pinWaitTimeoutMs, pinTimeoutAbort.signal).then(
          (timeout) => ({ kind: "pin-timeout" as const, ...timeout }),
        ),
      ]);
    } finally {
      pinTimeoutAbort.abort();
    }
  };
}

/**
 * Return the cached login device options, or build fresh ones if login hasn't
 * run yet — covers an on-demand login RPC arriving before `initLineClient` had
 * a chance to set them up (e.g. a worker that started with no credentials).
 */
function ensureLoginDeviceOptions(
  config: WorkerConfig,
): { device: Device; storage: BaseStorage } {
  if (loginDeviceOptions) return loginDeviceOptions;
  initSharedLimiter(config.rateLimitCalls, config.rateLimitWindowMs);
  const storage = new ApiSessionStorage();
  sessionStorage = storage;
  loginDeviceOptions = { device: parseDevice(config.device), storage };
  return loginDeviceOptions;
}

/**
 * Start (or restart) a QR login on demand — invoked by the `login_qr` RPC when
 * the central web asks this bot to log in. The QR URL and any PIN are reported
 * to the Central API as they arrive (webhook events `qrcode`/`pincode`); this
 * resolves once login settles (ready / pin-timeout / failed). Refuses to run
 * when a login is already in flight.
 */
export async function startQrLogin(config: WorkerConfig): Promise<LineClientInitResult> {
  if (loginInFlight) {
    return { kind: "login-failed", message: "login already in progress", attempts: 0 };
  }
  loginInFlight = true;
  setLoginStatus({ state: "starting", qrUrl: undefined, pincode: undefined, error: undefined });
  try {
    const opts = ensureLoginDeviceOptions(config);
    return await attemptLoginWithRetry(buildQrAttempt(opts, config.pinWaitTimeoutMs), "QR", false);
  } finally {
    loginInFlight = false;
  }
}

/**
 * Start (or restart) an email/password login on demand — invoked by the
 * `login_password` RPC. Any 2FA PIN is reported via the webhook `pincode` event.
 */
export async function startPasswordLogin(
  config: WorkerConfig,
  email: string,
  password: string,
): Promise<LineClientInitResult> {
  if (loginInFlight) {
    return { kind: "login-failed", message: "login already in progress", attempts: 0 };
  }
  loginInFlight = true;
  setLoginStatus({ state: "starting", qrUrl: undefined, pincode: undefined, error: undefined });
  try {
    const opts = ensureLoginDeviceOptions(config);
    return await attemptLoginWithRetry(
      buildPasswordAttempt(opts, email, password, config.pinWaitTimeoutMs),
      "Email/password",
      false,
    );
  } finally {
    loginInFlight = false;
  }
}

/**
 * Initialize the LINE client with the smart auth flow:
 * 1. Try persisted token from Central API / env auth token
 * 2. Fall back to email/password login when credentials are available, else
 *    QR-code login (triggers PIN). Credentials may come from either the Central
 *    API session (`GET /state/session`) or, for a standalone worker, the
 *    `LINE_EMAIL`/`LINE_PASSWORD` env vars (`config.lineEmail`/`linePassword`).
 *    The session value wins when both are present.
 *
 * Whichever of QR / email/password is chosen is retried via
 * `attemptLoginWithRetry` — see its doc comment for the retry/backoff/park
 * semantics.
 */
export async function initLineClient(config: WorkerConfig): Promise<LineClientInitResult> {
  // Pace all outbound LINE API calls through one shared bucket (anti-ban).
  initSharedLimiter(config.rateLimitCalls, config.rateLimitWindowMs);

  const session = await loadSessionFromApi();

  let initialStorage: Record<string, Storage["Value"]> | undefined;
  if (session.storage) {
    try {
      initialStorage = JSON.parse(session.storage) as Record<string, Storage["Value"]>;
    } catch (error) {
      logger.warn("Persisted storage blob is corrupt — starting fresh", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const storage = new ApiSessionStorage(initialStorage);
  sessionStorage = storage;
  const device = parseDevice(config.device);
  loginDeviceOptions = { device, storage };
  const deviceOptions = loginDeviceOptions;

  const authToken = session.authToken ?? config.lineAuthToken;
  // Credentials reach the worker from the Central API session first and, when
  // that carries none, from the env vars sent directly to this worker
  // (LINE_EMAIL/LINE_PASSWORD). Both empty → QR login below.
  const fallbackLineEmail = session.lineEmail ?? config.lineEmail ?? null;
  const fallbackLinePassword = session.linePassword ?? config.linePassword ?? null;

  if (authToken) {
    try {
      logger.info("Attempting login with auth token");
      client = await loginWithAuthToken(authToken, deviceOptions);
      setupTokenPersistence(client);
      await onClientReady(client);
      return { kind: "ready" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn("Token login failed, falling back to email/password or QR login", { error: msg });
    }
  }

  // Default login method: QR code. When there's no usable token and no
  // email/password fallback, request a QR login — the operator scans it from
  // the dashboard, or from the worker logs (the URL is logged below) when
  // running standalone. Email/password is only used when explicitly provided
  // via the persisted session or the LINE_EMAIL/LINE_PASSWORD env vars.
  if (!fallbackLineEmail || !fallbackLinePassword) {
    // Standalone app with the inbound HTTP API: don't auto-start QR at boot —
    // let the caller pick QR or email/password via POST /login/*. The bootstrap
    // waits on `waitForLoginReady()` until one of those succeeds.
    if (config.httpApiEnabled) {
      logger.info("No token/credentials — awaiting login via the HTTP API");
      setLoginStatus({ state: "idle", qrUrl: undefined, pincode: undefined, error: undefined });
      return { kind: "onboarding-required" };
    }

    logger.info("No token or email/password; starting QR login");
    return attemptLoginWithRetry(
      buildQrAttempt(deviceOptions, config.pinWaitTimeoutMs),
      "QR",
      Boolean(authToken),
    );
  }

  logger.info("Attempting login with email/password");
  return attemptLoginWithRetry(
    buildPasswordAttempt(
      deviceOptions,
      fallbackLineEmail,
      fallbackLinePassword,
      config.pinWaitTimeoutMs,
    ),
    "Email/password",
    Boolean(authToken),
  );
}

/**
 * Wrap `client.base.talk` in a Proxy so every outbound method is paced through
 * the shared rate limiter — one chokepoint instead of editing every call site.
 * `sync` is excluded: it's the long-poll listener, not an outbound action, and
 * throttling it would stall event delivery. Best-effort: if `talk` isn't a
 * writable property on this linejs build, we skip silently (per-call helpers in
 * batch loops still apply their own `randomDelay`).
 */
function installTalkRateLimit(lineClient: Client): void {
  try {
    const base = lineClient.base as unknown as { talk: Record<string | symbol, unknown> };
    const target = base.talk;
    const proxied = new Proxy(target, {
      get(t, prop, recv) {
        const orig = Reflect.get(t, prop, recv);
        if (typeof orig !== "function") return orig;
        const fn = orig as (...a: unknown[]) => unknown;
        // `sync` is the long-poll listener — bind it straight to the real talk
        // (this=target) so it's never gated and its internals aren't proxied.
        if (prop === "sync") return fn.bind(t);
        return async (...args: unknown[]) => {
          await gateOutbound();
          return fn.apply(t, args);
        };
      },
    });
    base.talk = proxied;
    logger.info("Outbound LINE API rate limiting installed (talk proxy)");
  } catch (error) {
    logger.warn("Could not install talk rate-limit proxy — outbound calls ungated", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function onClientReady(lineClient: Client): Promise<void> {
  installTalkRateLimit(lineClient);
  try {
    const profile = await lineClient.base.talk.getProfile();
    const displayName = (profile as { displayName?: string })?.displayName ?? "Unknown";
    const mid = (profile as { mid?: string })?.mid ?? "Unknown";
    botMid = mid === "Unknown" ? "" : mid;

    logger.info("LINE client authenticated successfully", { displayName, mid });
    setLoginStatus({
      state: "ready",
      profileName: displayName,
      profileMid: mid,
      qrUrl: undefined,
      pincode: undefined,
      error: undefined,
    });
    await reportReady(displayName, mid);

    // Enrol in the fleet roster so siblings recognise this bot and never kick it.
    // Guarded on `botMid`, not `mid`: `mid` may be the "Unknown" sentinel, and
    // storing that as an identity would drop this bot out of its own fleet. The
    // API rejects it too, but not sending it keeps the failure out of the logs.
    if (botMid) {
      await reportOwnProfileMid(botMid);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn("Failed to fetch profile after login", { error: msg });
    setLoginStatus({
      state: "ready",
      profileName: "Unknown",
      profileMid: "Unknown",
      qrUrl: undefined,
      pincode: undefined,
      error: undefined,
    });
    await reportReady("Unknown", "Unknown");
  }
}

export async function getBotMid(): Promise<string> {
  if (botMid) return botMid;
  const lineClient = getClient();
  const profile = await lineClient.base.talk.getProfile();
  botMid = (profile as { mid?: string })?.mid ?? "";
  return botMid;
}

/**
 * Resolve a user's display name from their MID.
 *
 * Best-effort: falls back to the raw MID if the lookup fails (client not
 * ready, network error, contact not found, etc). Shared by features that
 * need to render a human-readable name in notifications (welcome/goodbye,
 * anti-kick).
 */
export async function resolveDisplayName(mid: string): Promise<string> {
  try {
    const lineClient = getClient();
    const contacts = await lineClient.base.talk.getContacts({ mids: [mid] });

    if (Array.isArray(contacts) && contacts.length > 0) {
      const displayName = (contacts[0] as { displayName?: string }).displayName;
      return displayName ?? mid;
    }
  } catch {
    logger.debug("Could not resolve display name", { mid });
  }
  return mid;
}

/**
 * Start the event listener with auto-reconnect on failure.
 *
 * Bypasses `client.listen()` (LEGY HTTP/2 push) — Bun's HTTP/2 throws
 * "no resStream" ~every 4s. Uses short-poll loop via `client.base.talk.sync()`.
 */
export async function startListening(): Promise<void> {
  const lineClient = getClient();
  const { runPollLoop } = await import("./poll-loop.js");

  logger.info("Starting LINE event listener (short-poll mode)");
  await runPollLoop(lineClient);
}

/**
 * Kick one or more members out of a group chat.
 *
 * ponytail: `deleteOtherFromChat` isn't part of linejs's typed `talk` surface
 * (see `Chat.kick()` in `@evex/linejs` `client/features/chat/mod.ts` for the
 * canonical `{ request: { chatMid, targetUserMids } }` shape) — this is the
 * single home of the untyped cast. Route new callers through here instead of
 * re-casting `lineClient.base.talk` locally.
 *
 * Being the single funnel is what makes the fleet guard below tractable: every
 * kick in the worker (anti-kick revenge + autokickbot, join-guard, anti-spam,
 * sweep_blacklist, the kick_member RPC, and `!sync kick`) arrives here, so one
 * filter covers them all. Do not add a bypass.
 *
 * Returns which mids were actually kicked and which the fleet guard refused.
 * Ambient callers can ignore it; operator-facing ones must not.
 */
export async function kickFromGroup(
  chatId: string,
  mids: string[],
): Promise<KickResult> {
  // Never kick one of our own bots. Two bots of the same user in one group each
  // observe the other's legitimate kicks as a hostile C_MR and retaliate — the
  // exact incident behind tasks/todo/008. Filtering at the funnel means a new
  // kick call site is protected by default rather than by remembering to check.
  const kicked: string[] = [];
  const skipped: string[] = [];
  for (const mid of mids) {
    if (await isFleetMember(mid)) {
      logger.info("Refusing to kick a fleet bot", { chatId, mid });
      skipped.push(mid);
      continue;
    }
    kicked.push(mid);
  }

  // An empty targetUserMids is a LINE API error, so a fully-filtered kick must
  // return instead of calling out. The result says what happened — ambient
  // callers ignore it, but an operator-driven one (the kick_member RPC) has to
  // be able to tell "done" from "refused", or the dashboard reports success for
  // a kick that never occurred.
  if (kicked.length === 0) return { kicked, skipped };

  const lineClient = getClient();
  await (lineClient.base.talk as unknown as Record<string, (arg: unknown) => Promise<unknown>>)[
    "deleteOtherFromChat"
  ]({
    request: {
      chatMid: chatId,
      targetUserMids: kicked,
    },
  });

  return { kicked, skipped };
}

// ─── Group-settings guard wrappers (Phase B, task 019+) ──────────────
//
// Thin funnels over the `talk` group-settings RPCs, same untyped-cast
// convention as `kickFromGroup` (route new callers here, never re-cast
// `base.talk` locally). Each swallows errors and returns a boolean so a revert
// can never throw into an op-listener. NONE of these fire until a capture
// session confirms the settings-change op types and the guard features are
// flipped off `available: false` (.research/line-op-type-verification.md).
//
// `updatedAttribute` is LINE's `Pb1_O2` bitmask (accepts the enum NAME too):
//   NAME=1 · PICTURE_STATUS=2 · PREVENTED_JOIN_BY_TICKET=4 · INVITATION_TICKET=16

/** Current name / picture / invite-link state for a group, for snapshot seeding. */
export interface ChatSettings {
  name?: string;
  picturePath?: string;
  preventedJoinByTicket?: boolean;
}

type UntypedTalk = Record<string, (arg: unknown) => Promise<unknown>>;

function talkRpc(): UntypedTalk {
  return getClient().base.talk as unknown as UntypedTalk;
}

async function nextReqSeq(): Promise<number | undefined> {
  try {
    return await (
      getClient().base as unknown as { getReqseq: (name?: string) => Promise<number> }
    ).getReqseq("talk");
  } catch {
    return undefined;
  }
}

/** Reads a group's current settings (name/picture/invite-link) for seeding a snapshot. */
export async function fetchChatSettings(chatId: string): Promise<ChatSettings | null> {
  try {
    const res = (await talkRpc()["getChats"]({
      chatMids: [chatId],
      withMembers: false,
      withInvitees: false,
    })) as { chats?: Array<{ chatName?: string; picturePath?: string; extra?: { groupExtra?: { preventedJoinByTicket?: boolean } } }> };
    const chat = res?.chats?.[0];
    if (!chat) return null;
    return {
      name: chat.chatName,
      picturePath: chat.picturePath,
      preventedJoinByTicket: chat.extra?.groupExtra?.preventedJoinByTicket,
    };
  } catch (error) {
    logger.warn("fetchChatSettings failed", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Restore a group's name (revert a hostile rename to the snapshot value). */
export async function revertChatName(chatId: string, oldName: string): Promise<boolean> {
  try {
    await talkRpc()["updateChat"]({
      request: {
        reqSeq: await nextReqSeq(),
        chat: { chatMid: chatId, chatName: oldName },
        updatedAttribute: 1, // NAME
      },
    });
    return true;
  } catch (error) {
    logger.warn("revertChatName failed", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Restore a group's picture (revert a hostile picture change to the snapshot value). */
export async function revertChatPicture(chatId: string, oldPicturePath: string): Promise<boolean> {
  try {
    await talkRpc()["updateChat"]({
      request: {
        reqSeq: await nextReqSeq(),
        chat: { chatMid: chatId, picturePath: oldPicturePath },
        updatedAttribute: 2, // PICTURE_STATUS
      },
    });
    return true;
  } catch (error) {
    logger.warn("revertChatPicture failed", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Disable a group's join-by-invite-link and reissue the ticket so any already
 * leaked link stops working. Two RPCs, best-effort each.
 */
export async function disableInviteLink(chatId: string): Promise<boolean> {
  let ok = true;
  try {
    await talkRpc()["updateChat"]({
      request: {
        reqSeq: await nextReqSeq(),
        chat: { chatMid: chatId, extra: { groupExtra: { preventedJoinByTicket: true } } },
        updatedAttribute: 4, // PREVENTED_JOIN_BY_TICKET
      },
    });
  } catch (error) {
    ok = false;
    logger.warn("disableInviteLink: updateChat failed", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    // Invalidate the leaked link — a member who already grabbed the URL/QR
    // can't use it after the ticket is reissued.
    await talkRpc()["reissueChatTicket"]({
      request: { reqSeq: await nextReqSeq(), groupMid: chatId },
    });
  } catch (error) {
    ok = false;
    logger.warn("disableInviteLink: reissueChatTicket failed", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return ok;
}

/** Cancel outstanding invitations (revert a rogue member-invite). */
export async function cancelInvitations(chatId: string, targetUserMids: string[]): Promise<boolean> {
  if (targetUserMids.length === 0) return true;
  try {
    await talkRpc()["cancelChatInvitation"]({
      request: { reqSeq: await nextReqSeq(), chatMid: chatId, targetUserMids },
    });
    return true;
  } catch (error) {
    logger.warn("cancelInvitations failed", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Re-invite users into a group (restore an invite a member wrongly cancelled).
 * `inviteIntoChat` takes a flat `{ chatMid, targetUserMids }` (not the `{request}`
 * wrapper the others use) — same call shape as anti-kick.ts's re-invite.
 */
export async function reinviteToChat(chatId: string, targetUserMids: string[]): Promise<boolean> {
  if (targetUserMids.length === 0) return true;
  try {
    await getClient().base.talk.inviteIntoChat({ chatMid: chatId, targetUserMids });
    return true;
  } catch (error) {
    logger.warn("reinviteToChat failed", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Send a chat message, gated by the `cmdoutput` per-group toggle.
 *
 * This is the single chokepoint for all outbound `talk.sendMessage` calls
 * (same convention as `kickFromGroup`) — every feature/`src/index.ts` call
 * site routes through here instead of calling `lineClient.base.talk.sendMessage`
 * directly.
 *
 * Gating only applies when there's an active command context (set by
 * `event-router.ts` around `feature.handleCommand()` via
 * `runInCommandContext`): if `cmdoutput` is disabled for that context's
 * `chatId`, the send is skipped. Ambient sends (welcome/goodbye, anti-kick
 * notices, anti-spam warnings, auto-reply, join-guard, and the router's own
 * `RawMessage.reply()` error path) never run inside a command context, so
 * they always go through unaffected — this is required behavior, not a gap.
 *
 * `source: "ui"` command contexts are EXEMPT from the `cmdoutput` gate —
 * a dashboard-triggered `POST /bots/:id/commands/execute` must still post to
 * LINE even when chat output is muted, or the button silently reports
 * `ok: true` while doing nothing. The dashboard is the documented escape
 * hatch for a muted bot (same reasoning `admincmd`'s bypass already applies
 * to `source: "ui"` in event-router.ts). Only `source: "chat"` contexts are
 * actually gated.
 *
 * Otherwise there is no bypass option and no per-feature exemption — this is
 * a deliberate design (see docs/api-spec.md §3a `cmdoutput`/`admincmd`
 * toggles). `opts.contentMetadata` is a pass-through to the underlying
 * `talk.sendMessage` call (needed by `tagall.ts` for LINE mention metadata)
 * — it does not affect gating in any way.
 *
 * Returns `true` if the message was actually sent, `false` if it was
 * suppressed by the `cmdoutput` gate. Callers that fan out a chat-triggered
 * send to other systems (e.g. `sync.ts` broadcasting `!sync chat` to peer
 * bots over the Sync Hub) should check this before fanning out, so a muted
 * bot doesn't leak its suppressed text through a side channel — see
 * `sync.ts`'s `handleCommand` for the "chat" action.
 */
export async function sendBotMessage(
  to: string,
  text: string,
  opts?: { e2ee?: boolean; contentMetadata?: Record<string, string> },
): Promise<boolean> {
  const ctx = getCommandContext();
  if (ctx && ctx.source !== "ui") {
    const enabled = await isGroupCommandEnabled(ctx.chatId, "cmdoutput");
    if (!enabled) {
      logger.debug("sendBotMessage suppressed by cmdoutput toggle", {
        chatId: ctx.chatId,
        command: ctx.command,
        source: ctx.source,
      });
      return false;
    }
  }

  const lineClient = getClient();
  await lineClient.base.talk.sendMessage({
    to,
    text,
    e2ee: opts?.e2ee ?? true,
    ...(opts?.contentMetadata ? { contentMetadata: opts.contentMetadata } : {}),
  });
  return true;
}

export function disconnectClient(): void {
  if (client) {
    logger.info("Disconnecting LINE client");
    client = null;
  }
}
