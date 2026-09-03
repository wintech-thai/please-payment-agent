/**
 * rlbotline Worker — Login State
 *
 * Shared, in-memory snapshot of the LINE login flow so the inbound HTTP API
 * (src/core/http-server.ts) can report progress to whoever triggered a login,
 * and so the bootstrap can block until login is ready (`waitForLoginReady`).
 *
 * `line-client.ts` owns the login flow itself; `poll-loop.ts` owns what happens
 * to that verdict afterwards (`markSessionExpired` / `markSessionRecovered`) —
 * a state that only ever moved forward to "ready" was the whole reason a bot
 * whose LINE session had been revoked kept reporting itself as ready.
 * `http-server.ts` and `index.ts` read.
 * Only `logger` is imported (it pulls in nothing but types), so this module
 * stays free of dependency cycles.
 */

import { logger } from "./logger.js";

export type LoginState =
  | "idle" // no login attempted / awaiting an HTTP trigger
  | "starting" // login kicked off, nothing to show yet
  | "qr_pending" // a QR URL is available to scan
  | "pin_pending" // a 2FA PIN must be entered in the LINE app
  | "ready" // logged in and online
  | "expired" // was ready, but LINE has since revoked/expired the session
  | "error"; // last attempt failed (see `error`)

export interface LoginStatus {
  state: LoginState;
  /** QR login URL to scan (present while state === "qr_pending"). */
  qrUrl?: string;
  /** 2FA PIN to enter in the LINE app (present while state === "pin_pending"). */
  pincode?: string;
  /** Display name once logged in. */
  profileName?: string;
  /** LINE mid once logged in. */
  profileMid?: string;
  /** Error message from the last failed attempt. */
  error?: string;
  /** Unix ms of the last update. */
  updatedAt: number;
}

let status: LoginStatus = { state: "idle", updatedAt: 0 };
let readyResolvers: Array<() => void> = [];

/** Current login status snapshot. */
export function getLoginStatus(): LoginStatus {
  return status;
}

/**
 * Merge a partial update into the login status. Passing a field as `undefined`
 * clears it (used to wipe a stale qrUrl/pincode when a new attempt starts).
 * When the state transitions to "ready", any `waitForLoginReady` waiters fire.
 */
export function setLoginStatus(partial: Partial<Omit<LoginStatus, "updatedAt">>): void {
  const previous = status;
  status = { ...status, ...partial, updatedAt: Date.now() };

  // Every LINE connection transition passes through here, so one log line covers
  // the whole flow (HTTP-triggered, WS-RPC, or boot auth ladder) — otherwise the
  // connection state is only visible by polling /login/status from outside.
  if (previous.state !== status.state) {
    const record: Record<string, unknown> = {
      from: previous.state,
      to: status.state,
      heldForMs: previous.updatedAt > 0 ? status.updatedAt - previous.updatedAt : undefined,
      profileName: status.profileName,
      profileMid: status.profileMid,
      // The QR URL embeds a login secret — report only that one is available.
      hasQrUrl: Boolean(status.qrUrl),
      // PIN is intentionally visible: an operator reads it from the log to
      // complete 2FA in the LINE app (see .docs/login.md §9).
      pincode: status.pincode,
      error: status.error,
    };
    if (status.state === "error") {
      logger.error("LINE login state → error", record);
    } else if (status.state === "ready") {
      logger.info("LINE connection ready", record);
    } else {
      logger.info("LINE login state changed", record);
    }
  }

  if (status.state === "ready") {
    const resolvers = readyResolvers;
    readyResolvers = [];
    for (const resolve of resolvers) {
      try {
        resolve();
      } catch {
        // a waiter's continuation throwing must not block the others
      }
    }
  }
}

/**
 * LINE rejected the live session (see `session-health.ts`). Demotes a **ready**
 * login to "expired" so `/login/status` and `/status` stop claiming the bot is
 * connected; the profile is kept because it is still who was logged in.
 *
 * Only "ready" is demoted on purpose: a login attempt already in flight
 * (qr_pending / pin_pending / starting) owns the status, and overwriting it
 * would wipe a QR the operator is mid-scan of.
 */
export function markSessionExpired(error: string): void {
  if (status.state !== "ready") return;
  setLoginStatus({ state: "expired", error });
}

/**
 * LINE started answering again without a re-login (a revoked-looking failure
 * that turned out to be transient). Promotes "expired" back to "ready" — the
 * counterpart to `markSessionExpired`, so a session that healed itself stops
 * showing as expired without an operator restarting the container.
 */
export function markSessionRecovered(): void {
  if (status.state !== "expired") return;
  setLoginStatus({ state: "ready", error: undefined });
}

/**
 * Resolve once login reaches "ready" — immediately if already ready. Used by
 * the bootstrap to wait for an HTTP-triggered login before bringing the worker
 * fully online.
 */
export function waitForLoginReady(): Promise<void> {
  if (status.state === "ready") return Promise.resolve();
  return new Promise<void>((resolve) => {
    readyResolvers.push(resolve);
  });
}
