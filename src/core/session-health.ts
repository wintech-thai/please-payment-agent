/**
 * rlbotline Worker — LINE Session Health
 *
 * "process ยังไม่ตาย" กับ "LINE ยังคุยกับเราอยู่" เป็นคนละเรื่องกัน — และก่อนหน้านี้
 * worker รายงานได้แค่เรื่องแรก `login-state.ts` ถูกเขียนโดยเส้นทาง login เท่านั้น
 * พอขึ้น `"ready"` แล้วไม่มีอะไรดึงกลับ ดังนั้น session ที่ถูกเพิกถอนจะทำให้
 * `talk.sync()` พังทุกรอบตลอดไป ขณะที่ `/status` ยังตอบ `ready` และ `/health` ยัง 200
 * (Docker HEALTHCHECK ก็เลยยัง healthy) — อาการ "user LINE หลุดแต่ status บอก ready"
 *
 * โมดูลนี้คือแหล่งความจริงของ "รอบล่าสุด LINE ตอบเราหรือเปล่า":
 *
 *   - `poll-loop.ts` เป็นผู้เขียนเพียงรายเดียว (`notePollStarted` / `markPollOk` /
 *     `notePollFailure` / `noteSessionExpired`)
 *   - `http-server.ts` อ่านผ่าน `getSessionHealth()` เพื่อประกอบ `/status`, `/health`
 *     และ `/login/status`
 *   - `isLineAuthError` จำแนกว่า error จาก LINE คือ "session ตาย" ไหม เพื่อให้ poll loop
 *     แยกระหว่างการปลด login state ออกจาก ready กับการ backoff ตามปกติ
 *
 * import แค่ `logger` (ซึ่งดึงแค่ types) เหมือน `login-state.ts` โมดูลนี้จึงปลอดจาก
 * dependency cycle
 */

import { logger } from "./logger.js";
import { REPORT_AFTER_MS } from "./poll-recovery.js";

/**
 * เฉพาะความล้มเหลวด้าน auth ที่กู้เองไม่ได้เท่านั้น — network สะดุดชั่วคราวหรือ
 * long-poll timeout ต้องไม่ match ไม่งั้นเราจะไปตีตรา session ที่ยังดีว่าหมดอายุ
 */
const LINE_AUTH_ERROR_RE = /NOT_AUTHORIZED_DEVICE|AUTHENTICATION_FAILED/;

export function isLineAuthError(message: string): boolean {
  return LINE_AUTH_ERROR_RE.test(message);
}

/**
 * นี่คือ legy บอกว่า long-poll หมดอายุฝั่ง server ใช่ไหม?
 *
 * legy ตอบ `410 Gone` (thrift body ว่าง, `x-line-http: P,LP,HC`) เมื่อ long-poll ที่ค้างไว้
 * อยู่เกินหน้าต่างเวลา — คือ timeout ในรูปแบบ HTTP status ไม่ใช่ session ตาย (token ที่ถูก
 * เพิกถอนจะโดนปฏิเสธทันทีด้วย auth error) จึงต้องเดินเส้นทางเดียวกับ timeout: นับว่า
 * session ยังดีแล้ว poll ต่อทันที linejs ส่งออกมาเป็น `Request internal failed: status=410 …`
 */
export function isLongPollExpiry(message: string): boolean {
  return /status=410\b/.test(message);
}

/**
 * ไม่มีรอบไหนสำเร็จเลยนานเกินนี้ = ค้าง แม้จะไม่มี error ให้เห็นสักครั้ง
 *
 * จำเป็นเพราะโหมดพังที่แย่ที่สุดคือ `talk.sync()` ค้างไปเฉย ๆ ไม่ resolve ไม่ reject —
 * ตัวนับความล้มเหลวจะอยู่ที่ 0 ตลอด long-poll ตั้ง timeout ไว้ 20 วิ และ timeout เองก็
 * นับเป็น "LINE ตอบแล้ว" (ดู `markPollOk`) การเงียบ 3 นาทีจึงแปลว่าลิ่มค้างแน่นอน
 */
const SILENCE_IS_STALL_MS = REPORT_AFTER_MS;

/**
 * สถานะการเชื่อมต่อกับ LINE ที่สังเกตได้จริง — ต่างจาก `LoginState` ที่บอกแค่ว่า
 * "ความพยายาม login ครั้งล่าสุดจบยังไง"
 */
export type SessionConnection =
  | "idle" // poll loop ยังไม่เริ่ม (ยังไม่ login หรือกำลังรอสแกน)
  | "online" // sync สำเร็จล่าสุดยังสด
  | "degraded" // กำลังล้มเหลว แต่ยังไม่ถึงเกณฑ์ค้าง
  | "stalled" // ไม่ได้คุยกับ LINE มานานเกิน SILENCE_IS_STALL_MS
  | "expired"; // LINE ปฏิเสธ session — ต้อง login ใหม่

export interface SessionHealth {
  connection: SessionConnection;
  /** LINE ยังตอบเราอยู่จริงไหม — ใช้ประกอบ `loggedIn` และ `/health` */
  healthy: boolean;
  /** Unix ms ที่ poll loop เริ่มรอบแรก; 0 = ยังไม่เริ่ม */
  pollStartedAt: number;
  /** Unix ms ของรอบที่ LINE ตอบล่าสุด (รวม long-poll timeout); 0 = ยังไม่เคย */
  lastSyncOkAt: number;
  /** เงียบจาก LINE มานานเท่าไร; null ถ้ายังไม่เคยสำเร็จเลย */
  silentForMs: number | null;
  /** ล้มเหลวติดต่อกันนานเท่าไร; 0 = ไม่ได้ล้มเหลวอยู่ */
  stalledMs: number;
  /** จำนวนรอบที่ล้มเหลวติดต่อกัน */
  consecutiveFailures: number;
  /** ข้อความ error ของรอบที่ล้มเหลวล่าสุด */
  lastError?: string;
}

let pollStartedAt = 0;
let lastSyncOkAt = 0;
let firstFailureAt = 0;
let consecutiveFailures = 0;
let lastError: string | undefined;
let expired = false;

/** poll loop เข้ารอบแรกแล้ว — ก่อนหน้านี้ยังไม่มีอะไรให้รายงาน */
export function notePollStarted(): void {
  pollStartedAt = Date.now();
  lastSyncOkAt = 0;
  firstFailureAt = 0;
  consecutiveFailures = 0;
  lastError = undefined;
  expired = false;
}

/**
 * "LINE ตอบเราแล้ว" — เรียกทั้งตอน sync สำเร็จและตอน long-poll timeout/410
 * (session ที่ถูกเพิกถอนจะโดนปฏิเสธทันที ไม่ใช่ค้างจน timeout ดังนั้น timeout
 * เป็นหลักฐานว่า session ยังดี)
 *
 * คืน `true` ถ้าอันนี้คือการฟื้นจากสถานะที่ไม่ healthy — ผู้เรียกใช้ latch การรายงาน
 * ไม่ให้ประกาศ "กลับมาแล้ว" ทุกรอบ
 */
export function markPollOk(): boolean {
  const wasUnhealthy = expired || consecutiveFailures > 0;
  lastSyncOkAt = Date.now();
  firstFailureAt = 0;
  consecutiveFailures = 0;
  lastError = undefined;
  expired = false;
  return wasUnhealthy;
}

/** sync รอบนี้ล้มเหลว (ไม่ใช่ timeout ปกติ) */
export function notePollFailure(message: string): void {
  const now = Date.now();
  if (firstFailureAt === 0) firstFailureAt = now;
  consecutiveFailures++;
  lastError = message;
}

/**
 * LINE ปฏิเสธ session ของเรา — จุดนี้คือความต่างระหว่าง "ล้มเหลวชั่วคราว" กับ
 * "ต้องให้คนมา login ใหม่" `poll-loop.ts` ยังปลด `login-state` ออกจาก `"ready"` คู่กัน
 * เพื่อให้ `/login/status` เล่าเรื่องเดียวกัน
 */
export function noteSessionExpired(message: string): void {
  expired = true;
  lastError = message;
}

/**
 * สแนปช็อตสถานะการเชื่อมต่อปัจจุบัน `now` ฉีดเข้ามาได้เพื่อให้เทสต์เดินเวลาข้าม
 * เกณฑ์ค้าง (3 นาที) ได้โดยไม่ต้องรอจริง — production เรียกแบบไม่ส่งพารามิเตอร์
 */
export function getSessionHealth(now: number = Date.now()): SessionHealth {
  const silentForMs = lastSyncOkAt > 0 ? now - lastSyncOkAt : null;
  const stalledMs = firstFailureAt === 0 ? 0 : now - firstFailureAt;

  const connection: SessionConnection = expired
    ? "expired"
    : pollStartedAt === 0
      ? "idle"
      : stalledMs >= SILENCE_IS_STALL_MS
        ? "stalled"
        : // sync ที่ค้างแบบไม่ resolve ไม่ reject จะไม่โผล่ใน stalledMs — ความเงียบ
          // จาก LINE คือหลักฐานเดียวที่มี
          silentForMs !== null && silentForMs >= SILENCE_IS_STALL_MS
          ? "stalled"
          : consecutiveFailures > 0
            ? "degraded"
            : lastSyncOkAt > 0
              ? "online"
              : // poll loop เพิ่งเริ่ม ยังไม่ครบรอบแรก — ยังไม่ใช่ปัญหา
                "idle";

  return {
    connection,
    // `degraded` ยังถือว่า healthy: sync ล้มเหลวหนึ่งรอบเป็นเรื่องปกติของ network
    // และการทำให้ container unhealthy เพราะเรื่องนั้นจะกลายเป็น restart loop
    healthy: connection === "online" || connection === "idle" || connection === "degraded",
    pollStartedAt,
    lastSyncOkAt,
    silentForMs,
    stalledMs,
    consecutiveFailures,
    lastError,
  };
}

/** Test seam: ล้างสถานะกลับไปเหมือน process เพิ่งบูต */
export function __resetSessionHealthForTest(): void {
  pollStartedAt = 0;
  lastSyncOkAt = 0;
  firstFailureAt = 0;
  consecutiveFailures = 0;
  lastError = undefined;
  expired = false;
}

/** log สรุปหนึ่งบรรทัดตอนสถานะการเชื่อมต่อเปลี่ยน — ใช้โดย poll loop */
export function logConnectionChange(from: SessionConnection, to: SessionConnection): void {
  const health = getSessionHealth();
  const record = {
    from,
    to,
    silentForMs: health.silentForMs,
    stalledMs: health.stalledMs,
    consecutiveFailures: health.consecutiveFailures,
    error: health.lastError,
  };
  if (to === "expired" || to === "stalled") {
    logger.error("LINE session connection degraded", record);
  } else {
    logger.info("LINE session connection changed", record);
  }
}
