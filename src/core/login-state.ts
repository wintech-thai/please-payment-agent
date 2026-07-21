/**
 * rlbotline Worker — Login State
 *
 * Shared, in-memory snapshot of the LINE login flow so the inbound HTTP API
 * (src/core/http-server.ts) can report progress to whoever triggered a login,
 * and so the bootstrap can block until login is ready (`waitForLoginReady`).
 *
 * `line-client.ts` is the sole writer; `http-server.ts` and `index.ts` read.
 * No imports here — keeps this module free of dependency cycles.
 */

export type LoginState =
  | "idle" // no login attempted / awaiting an HTTP trigger
  | "starting" // login kicked off, nothing to show yet
  | "qr_pending" // a QR URL is available to scan
  | "pin_pending" // a 2FA PIN must be entered in the LINE app
  | "ready" // logged in and online
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
  status = { ...status, ...partial, updatedAt: Date.now() };
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
