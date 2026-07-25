/**
 * rlbotline Worker — Short-Poll Loop
 *
 * แทนที่ `client.listen()` ของ linejs ที่ใช้ LEGY HTTP/2 push ซึ่ง
 * **ไม่ทำงานบน Bun runtime** (โยน "no resStream" ทุก 4 วินาที).
 *
 * Loop นี้ใช้ HTTPS short-poll ตรง ๆ ผ่าน `client.base.talk.sync()`:
 *   - count = 10 ต่อรอบ (น้อยพอที่ LINE จะไม่จับว่าเป็น scraper)
 *   - timeout = 20 วินาที (long-poll: server จะค้างจนกว่าจะมี op ใหม่)
 *   - sleep = 1 วินาที ระหว่างรอบ (เพราะ server long-poll อยู่แล้ว)
 *   - skipFirstPoll = ข้าม backlog ตอน startup → รับเฉพาะข้อความ live
 *
 * จัดการ revision อย่างถูกต้อง:
 *   - revision   ← fullSyncResponse.nextRevision หรือ op.revision สุดท้าย
 *   - globalRev  ← operationResponse.globalEvents.lastRevision
 *   - individualRev ← operationResponse.individualEvents.lastRevision
 *
 * เมื่อเจอ SEND_MESSAGE / RECEIVE_MESSAGE → decrypt E2EE → emit ผ่าน
 * `client.emit("message", new TalkMessage(...))` เพื่อให้ event-router
 * ที่ใช้ `client.on("message")` ทำงานได้โดยไม่ต้องแก้
 */

import { TalkMessage } from "@evex/linejs";
import type { Client } from "@evex/linejs";
import { logger } from "./logger.js";
import { dumpRawOp, isRawOpLogEnabled } from "./raw-op-logger.js";
import { randomDelay } from "./rate-limiter.js";

/** LINE op types we care about */
const OP_SEND_MESSAGE = "SEND_MESSAGE";
const OP_RECEIVE_MESSAGE = "RECEIVE_MESSAGE";

const POLL_LIMIT = 10;
const POLL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 1_000;
const ERROR_BACKOFF_MS = 5_000;

/**
 * Run the polling loop forever. Auto-reconnects on errors.
 * Does NOT return — call inside a fire-and-forget context.
 */
export async function runPollLoop(client: Client): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const talk = (client.base as any).talk;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e2ee = (client.base as any).e2ee;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const emitter = client as any;

  let revision: bigint | number = 0;
  let globalRev: bigint | number = 0;
  let individualRev: bigint | number = 0;
  let firstPoll = true;

  logger.info("Poll loop started", {
    limit: POLL_LIMIT,
    timeoutMs: POLL_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    rawOpLog: isRawOpLogEnabled(),
  });

  while (true) {
    // Did this round return work? If so we re-poll immediately to drain the
    // backlog like a desktop client catching up; if idle, a short human gap.
    let hadOps = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await talk.sync({
        revision,
        globalRev,
        individualRev,
        limit: POLL_LIMIT,
        timeout: POLL_TIMEOUT_MS,
      });

      // Update revisions
      if (res?.fullSyncResponse?.nextRevision) {
        revision = res.fullSyncResponse.nextRevision;
      }
      if (res?.operationResponse?.globalEvents?.lastRevision) {
        globalRev = res.operationResponse.globalEvents.lastRevision;
      }
      if (res?.operationResponse?.individualEvents?.lastRevision) {
        individualRev = res.operationResponse.individualEvents.lastRevision;
      }

      const ops = res?.operationResponse?.operations ?? [];
      hadOps = ops.length > 0;

      for (const op of ops) {
        if (op?.revision !== undefined) revision = op.revision;

        // Trace every op that comes off the wire so "did it even arrive?" is
        // answerable from the console alone (RAW_OP_LOG only writes to a file).
        logger.debug("Poll loop: op received", {
          type: op?.type,
          backlog: firstPoll,
          chatId: op?.message?.to,
        });

        // DEV: dump the raw op so real LineOpType numbers + param semantics can
        // be confirmed against live traffic (no-op unless RAW_OP_LOG is set).
        // Fire-and-forget: name resolution must never block/slow the poll loop.
        dumpRawOp(op, firstPoll).catch(() => {});

        // Always emit raw event so operation-listeners (anti-kick, anti-unsend) work
        // — but only after we've skipped the initial backlog.
        if (!firstPoll) {
          try {
            emitter.emit("event", op);
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            logger.error("Poll loop: emit(event) failed", { error: m });
          }
        }

        // Decrypt + emit message ops
        if (
          !firstPoll &&
          (op.type === OP_SEND_MESSAGE || op.type === OP_RECEIVE_MESSAGE) &&
          op.message
        ) {
          try {
            const decrypted = await e2ee.decryptE2EEMessage(op.message);
            const talkMessage = new TalkMessage({ raw: decrypted, client });
            emitter.emit("message", talkMessage);
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            logger.warn("Poll loop: decrypt/emit message failed", {
              error: m,
              opType: op.type,
            });
          }
        }
      }

      firstPoll = false;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // long-poll timeout เป็นเรื่องปกติ (server ค้าง connection จน timeout)
      if (/timed out|timeout/i.test(m)) {
        // silent — เป็น keep-alive ปกติ
      } else {
        logger.error("Poll loop error, backing off", {
          error: m,
          backoffMs: ERROR_BACKOFF_MS,
        });
        await sleep(ERROR_BACKOFF_MS);
        continue;
      }
    }

    // Held-open long-poll: idle → a full human-like gap; got ops → a short
    // floor so we drain the backlog quickly but never tight-loop. The floor is
    // the only throttle on the poll loop (`sync` is excluded from gateOutbound),
    // so it must never be zero — a batch that fails to advance revision would
    // otherwise hammer LINE unthrottled, the exact ban vector we're avoiding.
    if (hadOps) {
      await randomDelay(200, 500);
    } else {
      await randomDelay(POLL_INTERVAL_MS, POLL_INTERVAL_MS * 2);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
