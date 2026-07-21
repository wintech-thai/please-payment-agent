/**
 * rlbotline Worker — Raw Operation Logger (DEV ONLY)
 *
 * Dumps every raw operation returned by `client.base.talk.sync()` to a
 * per-day file `log-DD-MM-YYYY.log` so the actual wire shape of LINE ops can
 * be inspected during manual testing (kick, invite, join, unsend, ...).
 *
 * Purpose: confirm the unverified `LineOpType` numbering and the param1/2/3
 * semantics (joiner vs inviter, etc.) against real traffic — see the caveat in
 * docs/backend-architecture.md.
 *
 * Gated by env: does nothing unless RAW_OP_LOG is truthy ("1"/"true").
 *   RAW_OP_LOG_DIR — output dir (default "/app/logs", bind-mounted to ./logs in
 *   docker-compose.dev.yml).
 *
 * ponytail: dev instrumentation — synchronous append, one JSON line per op. Fine
 * for manual testing volume; remove the mount + env to disable in prod.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";
import { resolveDisplayName } from "./line-client.js";

const enabled = /^(1|true|yes)$/i.test(process.env.RAW_OP_LOG ?? "");
const logDir = process.env.RAW_OP_LOG_DIR ?? "/app/logs";
let dirReady = false;

/** LINE mid format: one type-letter prefix + 32 hex chars (see LINE_MID_RE elsewhere). */
const MID_RE = /^[ucrsm][0-9a-f]{32}$/i;

/** `"u1a2b... (Alice)"` for a MID-shaped value, so log records read like a story. */
async function annotate(value: unknown): Promise<unknown> {
  if (typeof value !== "string" || !MID_RE.test(value)) return value;
  const name = await resolveDisplayName(value).catch(() => undefined);
  return name && name !== value ? `${value} (${name})` : value;
}

export function isRawOpLogEnabled(): boolean {
  return enabled;
}

/** `log-DD-MM-YYYY.log` for the current day. */
function currentLogFile(): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  return join(logDir, `log-${dd}-${mm}-${yyyy}.log`);
}

/** JSON replacer: BigInt (e.g. op.revision) is not serializable by default. */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Annotate param3 with display names too — for invite ops it may be a
 * comma-separated list of invitee MIDs (per join-guard's parseInviteeMids).
 */
async function annotateParam3(value: unknown): Promise<unknown> {
  if (typeof value !== "string" || !value.includes(",")) return annotate(value);
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  const annotated = await Promise.all(parts.map((p) => annotate(p)));
  return annotated.join(", ");
}

/**
 * Append one raw op to today's log file. No-op unless RAW_OP_LOG is enabled.
 * Never throws — logging must not disturb the poll loop.
 *
 * @param backlog true if this op came from the startup backlog (firstPoll),
 *   so live vs replayed events can be told apart when reading the log.
 */
export async function dumpRawOp(op: unknown, backlog: boolean): Promise<void> {
  if (!enabled) return;
  try {
    if (!dirReady) {
      mkdirSync(logDir, { recursive: true });
      dirReady = true;
    }

    const o = op as Record<string, unknown>;
    const [param1, param2, param3] = await Promise.all([
      annotate(o?.param1),
      annotate(o?.param2),
      annotateParam3(o?.param3),
    ]);
    const record = {
      ts: new Date().toISOString(),
      backlog,
      // The whole point: is `type` a string name or a number? Capture both the
      // JS type and the value, plus the (name-annotated) params, plus the raw op.
      typeofType: typeof o?.type,
      type: o?.type,
      param1,
      param2,
      param3,
      raw: op,
    };

    appendFileSync(currentLogFile(), JSON.stringify(record, bigintSafe) + "\n");
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger.warn("raw-op-logger: failed to write", { error: m });
  }
}
