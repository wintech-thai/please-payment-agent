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
 *
 * **loop นี้คือแหล่งความจริงของสถานะการเชื่อมต่อ** — มันคือที่เดียวที่รู้ว่า LINE
 * ยังตอบเราอยู่หรือเปล่า เดิมมันกลืน error ทุกชนิด (รวม session ที่ถูกเพิกถอน) แล้ว
 * backoff 5 วิวนไปเรื่อย ๆ ทำให้ `/status` ยังบอก `ready` ทั้งที่บอทหูหนวกไปแล้ว
 * ตอนนี้จึงเขียนผลลงสองที่:
 *   - `session-health.ts` → `/status`, `/health` (สถานะการเชื่อมต่อที่สังเกตได้จริง)
 *   - `login-state.ts`    → ปลด `ready` เป็น `expired` เมื่อ LINE ปฏิเสธ session
 *
 * กันบอทหูหนวก — ดู `core/poll-recovery.ts`:
 *   - sync ที่ค้าง (retry revision เดิมได้ response พังเดิม) จะไต่บันได
 *     resync → report → restart แทนที่จะ backoff เงียบ ๆ ตลอดกาล
 *   - op ที่เก่ากว่า MAX_OP_AGE_MS จะไม่ถูก emit — backlog ที่เพิ่งระบายออกมา
 *     ต้องไม่ถูกสั่งงานเหมือนข้อความสด
 */

import { TalkMessage } from "@evex/linejs";
import type { Client } from "@evex/linejs";
import { logger } from "./logger.js";
import { dumpRawOp, isRawOpLogEnabled } from "./raw-op-logger.js";
import { randomDelay } from "./rate-limiter.js";
import { markSessionExpired, markSessionRecovered } from "./login-state.js";
import { reportError, reportStatus } from "./webhook.js";
import {
  getSessionHealth,
  isLineAuthError,
  isLongPollExpiry,
  logConnectionChange,
  markPollOk,
  notePollFailure,
  notePollStarted,
  noteSessionExpired,
  type SessionConnection,
} from "./session-health.js";
import {
  MAX_OP_AGE_MS,
  MAX_STALL_RESTARTS,
  clearStallRestarts,
  createStallTracker,
  isStaleOp,
  opTimestampMs,
  recordStallRestart,
} from "./poll-recovery.js";

/** LINE op types we care about */
const OP_SEND_MESSAGE = "SEND_MESSAGE";
const OP_RECEIVE_MESSAGE = "RECEIVE_MESSAGE";

const POLL_LIMIT = 10;
const POLL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 1_000;
const ERROR_BACKOFF_MS = 5_000;

/** How long the graceful shutdown gets before a stall restart turns hard. */
const RESTART_GRACE_MS = 15_000;

/**
 * decrypt error นี้ดูเหมือน Letter Sealing (E2EE) key ไม่ตรงกัน มากกว่าจะเป็นความ
 * ล้มเหลวชั่วคราวไหม? AES-GCM auth-tag ที่ไม่ผ่านจะโผล่มาเป็น "Unsupported state or
 * unable to authenticate data" ของ Node (หรือ `ERR_OSSL_BAD_DECRYPT` เมื่อ key ที่
 * cache ไว้หายไป) — ลายเซ็นของ bug key-state ใน linejs #211/#195 ที่ key ที่เก็บไว้
 * ไม่จับคู่กับ key ที่ลงทะเบียนไว้กับ LINE แล้ว ใช้เพื่อกำกับ log ให้ operator แยก
 * "key เราผิด" ออกจากอาการสะดุดครั้งเดียวได้เท่านั้น
 */
export function isE2EEDecryptKeyMismatch(message: string): boolean {
  return /unable to authenticate data|unsupported state|bad_decrypt/i.test(message);
}

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
  // mid ของบอทเอง — ใช้ทำเครื่องหมายข้อความที่เราส่งเองแล้วถอดไม่ออก ซึ่งเป็นอาการ
  // เฉพาะของ key-mismatch แบบ self-echo ในกลุ่ม (linejs #211)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selfMid: string = (client.base as any).profile?.mid ?? "";

  let revision: bigint | number = 0;
  let globalRev: bigint | number = 0;
  let individualRev: bigint | number = 0;
  let firstPoll = true;

  // one-shot ต่อหนึ่งรอบเหตุการณ์: รายงาน session ที่ตายครั้งเดียวแล้วเงียบจนกว่า LINE
  // จะตอบอีก (session ที่ถูกเพิกถอนพังทุก 5 วิ การรายงานทุกครั้งจะท่วม webhook ด้วย
  // แถวเดิมซ้ำ ๆ)
  let authErrorReported = false;

  // "นานแค่ไหนแล้วตั้งแต่ sync สำเร็จครั้งล่าสุด" — สิ่งเดียวที่แยก poll ที่ค้างออกจาก
  // poll ที่แค่ยุ่ง เพราะ decode error ที่ทำให้ค้างไม่มี status หรือ code ให้จำแนก
  const stall = createStallTracker();

  notePollStarted();
  let lastConnection: SessionConnection = getSessionHealth().connection;

  /** log หนึ่งบรรทัดต่อการเปลี่ยนสถานะ ไม่ใช่ต่อรอบ poll */
  const noteConnection = (): SessionConnection => {
    const next = getSessionHealth().connection;
    if (next !== lastConnection) {
      logConnectionChange(lastConnection, next);
      lastConnection = next;
    }
    return next;
  };

  /**
   * LINE ตอบเราแล้ว — ใช้ทั้งตอน sync สำเร็จและตอน long-poll timeout/410
   * ปิดอาการค้างที่ค้างอยู่ และคืนสถานะ ready ให้ login state ถ้าเคยถูกปลดไป
   */
  const sessionOk = () => {
    const wasUnhealthy = markPollOk();
    const { recovered, stalledMs, reached } = stall.noteSuccess();

    if (wasUnhealthy) {
      // เคยปลด ready เป็น expired ไว้ → คืนกลับ ไม่งั้น dashboard จะค้างแดงจนกว่าคนจะ
      // มา restart ทั้งที่บอทหายเองแล้ว
      markSessionRecovered();
    }

    if (recovered) {
      const stalledMin = Math.round(stalledMs / 60_000);
      logger.info("Poll loop recovered from stall", { stalledMs, reached });
      // รอบนี้จบโดยไม่ได้ใช้โควตา restart จนหมด รอบถัดไปที่ไม่เกี่ยวกันจะได้เริ่มจากโควตาเต็ม
      clearStallRestarts();

      if (reached === "report" || reached === "restart") {
        reportStatus(
          "running",
          `บอทกลับมารับข้อความได้แล้ว (ค้างไป ~${stalledMin} นาที)`,
          { reason: "poll_stall_recovered", stalledMs },
        ).catch(() => {});
      }
    }

    if (authErrorReported) {
      authErrorReported = false;
      reportStatus("running", "LINE session กลับมาใช้งานได้", {
        reason: "line_session_recovered",
      }).catch(() => {});
    }

    noteConnection();
  };

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

      sessionOk();

      const ops = res?.operationResponse?.operations ?? [];
      hadOps = ops.length > 0;

      // backlog ที่เพิ่งระบายออกมาต้องไม่ถูก replay เป็น traffic สด: `!ลิสบอท` อายุ 6 ชม.
      // เคยถูกตอบตอนฟื้น และการ join/kick ที่เก่าพอกันก็จะถูกต้อนรับ/แก้แค้นย้อนหลัง
      // นับเป็นราย batch เพื่อให้ log บอกว่าทิ้งไปเท่าไร ไม่ใช่บอกทีละ op
      const now = Date.now();
      let staleSkipped = 0;
      let oldestStaleMs = 0;

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

        // ลงวันที่ไว้เก่าเกินกว่าจะทำตาม — `revision` เลื่อนผ่านไปแล้วข้างบน loop จึงยัง
        // เดินหน้าต่อ กดไว้แค่การ dispatch เท่านั้น op ที่อ่านเวลาไม่ได้ไม่นับว่าเก่า
        if (!firstPoll && isStaleOp(op, now, MAX_OP_AGE_MS)) {
          staleSkipped++;
          const created = opTimestampMs(op);
          if (created !== null) oldestStaleMs = Math.max(oldestStaleMs, now - created);
          continue;
        }

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
            const from: string | undefined = op.message?.from;
            logger.warn("Poll loop: decrypt/emit message failed", {
              error: m,
              opType: op.type,
              from,
              to: op.message?.to,
              selfSend: Boolean(selfMid) && from === selfMid,
              hint: isE2EEDecryptKeyMismatch(m)
                ? "E2EE key mismatch (linejs #211/#195) — ไม่ใช่ bug ของ worker ต้อง login ใหม่เพื่อลงทะเบียน key"
                : undefined,
            });
          }
        }
      }

      if (staleSkipped > 0) {
        logger.warn("Poll loop: dropped backlog ops older than the freshness window", {
          skipped: staleSkipped,
          oldestAgeMs: oldestStaleMs,
          maxAgeMs: MAX_OP_AGE_MS,
        });
      }

      firstPoll = false;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // long-poll timeout เป็นเรื่องปกติ (server ค้าง connection จน timeout)
      // legy ตอบ 410 Gone เมื่อ long-poll หมดอายุฝั่ง server — ความหมายเดียวกับ
      // timeout ไม่ใช่ session ตาย: ต้องนับว่า session ยังดีแล้ว re-poll ต่อทันที
      if (/timed out|timeout/i.test(m) || isLongPollExpiry(m)) {
        // silent — เป็น keep-alive ปกติ (และพิสูจน์ว่า session ยังคุยกับ LINE ได้:
        // session ที่ถูกเพิกถอนจะโดนปฏิเสธทันที ไม่ใช่ค้างจน timeout)
        sessionOk();
      } else {
        logger.error("Poll loop error, backing off", {
          error: m,
          backoffMs: ERROR_BACKOFF_MS,
        });

        notePollFailure(m);
        const authExpired = isLineAuthError(m);

        // LINE ปฏิเสธ session → ปลด `ready` ทันที นี่คือหัวใจของบั๊ก "user หลุดแต่
        // status บอก ready": ก่อนหน้านี้ไม่มีเส้นทางไหนเลยที่ดึง login state กลับได้
        if (authExpired) {
          noteSessionExpired(m);
          markSessionExpired("LINE session หมดอายุ/ถูกเพิกถอน — ต้อง login ใหม่");
        }

        // บันไดตรวจอาการค้าง retry ส่ง revision **เดิม** ซ้ำ response ที่ client ถอด
        // ไม่ได้จึงพังเหมือนเดิมตลอดไป และไม่มีอะไรข้างล่างนี้เข้าถึงได้ด้วยการจำแนก
        // ข้อความ error (`decodeLegyHeaders` โยน RangeError เปล่า ๆ) ตัวชี้วัดคือเวลา
        // ที่ผ่านไปโดยไม่มี sync สำเร็จ
        //
        // auth error ได้รับการยกเว้นจาก `report`/`restart`: มันถูกรายงานพร้อมวิธีแก้
        // ไปแล้วข้างล่าง และการ relaunch worker ที่ session ถูกเพิกถอนมีแต่จะเผา
        // login ของ LINE ทิ้ง ซึ่งคือช่องทางโดนแบน
        const { escalation, stalledMs } = stall.noteFailure();
        const stalledMin = Math.round(stalledMs / 60_000);

        if (escalation === "resync") {
          logger.warn("Poll loop stalled — re-baselining revisions and skipping the batch", {
            stalledMs,
            error: m,
          });
          // กลับไปเส้นทางตอน startup: revision 0 ทำให้ LINE ตอบด้วย full sync และ
          // `firstPoll` ทำให้เราทิ้ง backlog ที่ติดมาแทนที่จะ replay หลายชั่วโมงเข้า router
          revision = 0;
          globalRev = 0;
          individualRev = 0;
          firstPoll = true;
        } else if (escalation === "report" && !authExpired) {
          reportError(
            `บอทไม่ได้รับข้อความจาก LINE มา ~${stalledMin} นาที (poll loop ค้าง) — กำลังกู้อัตโนมัติ`,
            { reason: "poll_stalled", error: m, stalledMs },
          ).catch(() => {});
        } else if (escalation === "restart" && !authExpired) {
          const attempt = recordStallRestart();
          if (attempt <= MAX_STALL_RESTARTS) {
            logger.error("Poll loop stalled past the restart threshold — restarting worker", {
              stalledMs,
              attempt,
              maxAttempts: MAX_STALL_RESTARTS,
              error: m,
            });
            await reportError(
              `บอทค้างไม่รับข้อความ ~${stalledMin} นาที — restart อัตโนมัติ ` +
                `(ครั้งที่ ${attempt}/${MAX_STALL_RESTARTS})`,
              { reason: "poll_stall_restart", attempt, stalledMs, error: m },
            ).catch(() => {});
            noteConnection();
            await requestRestart();
          } else {
            // โควตาหมด การหูหนวกต่อไปแย่ก็จริง แต่ loop ที่ relaunch แล้ว login LINE
            // ใหม่ทุกสิบนาทีแย่กว่า (กันแบน > กู้ให้ครบ) worker จึงพูดตรง ๆ แล้วรอคน
            logger.error("Poll loop stalled and the restart budget is spent — parking", {
              stalledMs,
              attempt,
              maxAttempts: MAX_STALL_RESTARTS,
            });
            reportError(
              `บอทค้างไม่รับข้อความ และ restart อัตโนมัติครบ ${MAX_STALL_RESTARTS} ครั้งแล้ว — ` +
                `หยุดลองเองเพื่อกัน login ซ้ำ (เสี่ยงโดน LINE แบน) ต้อง restart จากภายนอก`,
              { reason: "poll_stall_parked", attempt, stalledMs, error: m },
            ).catch(() => {});
          }
        }

        if (authExpired && !authErrorReported) {
          authErrorReported = true;
          reportError(
            "LINE session หมดอายุ/ถูกเพิกถอน — บอทคุยกับ LINE ไม่ได้ ต้อง login ใหม่",
            { reason: "line_auth_expired", error: m },
          ).catch(() => {});
        }

        noteConnection();
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

/**
 * คืน container ให้ restart policy ของ Docker จัดการ (`restart: unless-stopped`)
 *
 * ใช้ SIGTERM แทน `process.exit()` โดยตั้งใจ: shutdown handler ใน `index.ts` เรียก
 * `flushSession()` การข้ามมันไปคือการทำ mutation วินาทีสุดท้ายหาย — ที่สำคัญที่สุดคือ
 * auth token ที่เพิ่ง refresh หรือ E2EE key ที่เพิ่งลงทะเบียน ซึ่งจะทำให้ restart กลายเป็น
 * การ login ใหม่และหมุน Letter Sealing key ทิ้ง ถ้า shutdown เองค้าง (มันรอ network)
 * ตัวจับเวลา grace จะบังคับให้ restart เกิดขึ้นอยู่ดี
 */
async function requestRestart(): Promise<void> {
  process.kill(process.pid, "SIGTERM");
  await sleep(RESTART_GRACE_MS);
  logger.error("Graceful shutdown did not finish in time — forcing exit", {
    graceMs: RESTART_GRACE_MS,
  });
  process.exit(1);
}
