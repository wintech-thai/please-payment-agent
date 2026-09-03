/**
 * rlbotline Worker — Poll-Loop Stall Recovery
 *
 * นโยบายสองข้อที่กันไม่ให้ response พังรอบเดียวกิน uptime ทั้งวัน แยกออกมาจาก
 * `poll-loop.ts` เพื่อให้ทดสอบได้โดยไม่ต้องมี LINE client จริง
 *
 * ## 1. บันไดตรวจอาการค้าง (stall ladder)
 *
 * `talk.sync()` ถูก retry ด้วย revision **เดิม** หลังล้มเหลว ดังนั้น response ที่
 * client ถอดไม่ได้ไม่ใช่อาการชั่วคราว แต่คือลิ่มที่ค้างถาวร — ล็อกฝั่ง selfbot เคย
 * เห็น `decodeLegyHeaders()` โยน `The value of "offset" is out of range …` กับ body
 * ขนาด 127 ไบต์ก้อนเดิม 12,606 ครั้งใน 26 ชั่วโมง บอทหูหนวกตลอดเวลานั้นทั้งที่
 * status ยังบอกว่าพร้อมทำงาน (process ยังอยู่ ไม่ได้แปลว่า LINE ยังตอบ)
 *
 * ตัวชี้วัดจึงเป็น "เวลาที่ล้มเหลวติดต่อกัน" ไม่ใช่ข้อความ error (bug ตระกูล decode
 * โยน RangeError เปล่า ๆ ไม่มี status/code ให้จำแนก):
 *
 *   45 วิ  → `resync`  ตั้ง revision ใหม่แล้วข้าม batch นั้น (เส้นทางเดียวกับตอน startup)
 *   3 นาที → `report`  แจ้ง control plane / log ว่าบอทค้าง
 *   10 นาที→ `restart` ส่ง SIGTERM ให้ Docker (`restart: unless-stopped`) ปลุกใหม่
 *
 * restart ถูก **จำกัดจำนวน** (`MAX_STALL_RESTARTS`) และนับข้าม process ผ่านไฟล์ marker:
 * loop ที่ relaunch ไม่จำกัดจะวิ่งไป login LINE ใหม่ทุกรอบ ซึ่งเสี่ยงโดนแบน —
 * ความปลอดภัยจากการแบนสำคัญกว่าการกู้ให้ครบ พ้นโควตาแล้วบอทจะจอดและบอกออกมาตรง ๆ
 *
 * ## 2. ตัวกัน backlog เก่า (staleness guard)
 *
 * `firstPoll` ข้าม backlog แค่ตอน startup แล้วเป็น `false` ตลอดกาล loop ที่ฟื้นหลัง
 * ค้างไปหลายชั่วโมงจึงยิง backlog ทั้งกองออกมาเหมือนเป็น traffic สด (เคสจริง:
 * `!ลิสบอท` ตอน 17:27 ถูกตอบตอน 23:26) `isStaleOp()` ให้ poll loop ตัดสิน
 * "นี่คือของเก่า ไม่ใช่ข่าวใหม่" ได้ทุกจังหวะของชีวิต เป็นราย op แทนราย process
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

// ─── Staleness ────────────────────────────────────────────────────────────

/**
 * op ที่เก่ากว่านี้ถือเป็น backlog: log ไว้และเลื่อน `revision` ต่อ แต่ไม่ dispatch
 * ตั้งเผื่อไว้กว้างโดยตั้งใจ — การระบายคิวปกติ (ข้อความค้างไม่กี่วินาที, long-poll
 * 20 วิ, error backoff 5 วิ) ต้องไม่ถูกทิ้ง อันนี้ดักเฉพาะตอนขาดการติดต่อยาว ๆ
 * ซึ่งทางเลือกอีกทางคือไปทำตามคำสั่งที่หมดอายุแล้ว
 */
export const MAX_OP_AGE_MS = 5 * 60 * 1000;

/** ค่า epoch ที่ต่ำกว่านี้คือหน่วยวินาที ไม่ใช่มิลลิวินาที (2001-09-09) */
const MS_EPOCH_FLOOR = 1_000_000_000_000;

/**
 * LINE สร้าง op นี้เมื่อไร (ms since epoch)?
 *
 * เขียนแบบกันเหนียวเพราะรูปร่างบน wire ไม่ใช่ของเรา: `createdTime` มาเป็น `number`,
 * `bigint` (Int64 ของ linejs) หรือสตริงตัวเลข แล้วแต่ struct และเส้นทาง thrift และ
 * บาง op ก็ไม่มีมาเลย `null` แปลว่า "ระบุเวลาไม่ได้" ไม่ใช่ "เก่า" — รูปแบบที่ไม่รู้จัก
 * จะยังถูกส่งต่อ แทนที่จะถูกทิ้งเงียบ ๆ
 */
export function opTimestampMs(op: unknown): number | null {
  if (!op || typeof op !== "object") return null;
  const record = op as Record<string, unknown>;
  const message = record["message"] as Record<string, unknown> | undefined;
  const raw = record["createdTime"] ?? message?.["createdTime"];

  let value: number;
  if (typeof raw === "bigint") value = Number(raw);
  else if (typeof raw === "number") value = raw;
  else if (typeof raw === "string" && raw.trim() !== "") value = Number(raw);
  else return null;

  if (!Number.isFinite(value) || value <= 0) return null;
  // บาง op ส่ง timestamp ระดับวินาทีมาจริง — คูณขึ้นแทนที่จะตีความ 1.7e9 ว่าเป็นปี 1970
  // แล้วประกาศว่าทุก op เก่าเกินใช้งาน
  return value < MS_EPOCH_FLOOR ? value * 1000 : value;
}

/**
 * op นี้เก่าเกินกว่าจะทำตามหรือยัง? op ที่ระบุเวลาไม่ได้ไม่นับว่าเก่า (ดู `opTimestampMs`)
 * และ op ที่ลงวันที่ในอนาคตก็ไม่นับ — clock skew ระหว่าง container กับ LINE ต้องไม่
 * กลายเป็นเหตุผลให้ทิ้ง traffic สด
 */
export function isStaleOp(op: unknown, now: number, maxAgeMs: number = MAX_OP_AGE_MS): boolean {
  const created = opTimestampMs(op);
  if (created === null) return false;
  return now - created > maxAgeMs;
}

// ─── Stall ladder ─────────────────────────────────────────────────────────

/** loop ต้องล้มเหลวติดต่อกันนานเท่าไรก่อนแต่ละขั้นจะทำงาน */
export const RESYNC_AFTER_MS = 45 * 1000;
export const REPORT_AFTER_MS = 3 * 60 * 1000;
export const RESTART_AFTER_MS = 10 * 60 * 1000;

export type StallEscalation = "none" | "resync" | "report" | "restart";

const LADDER: readonly { readonly at: number; readonly step: StallEscalation }[] = [
  { at: RESTART_AFTER_MS, step: "restart" },
  { at: REPORT_AFTER_MS, step: "report" },
  { at: RESYNC_AFTER_MS, step: "resync" },
];

const RANK: Record<StallEscalation, number> = { none: 0, resync: 1, report: 2, restart: 3 };

export interface StallStep {
  /** ขั้นที่ความล้มเหลว "ครั้งนี้" ข้ามผ่าน — `"none"` ถ้ายังไม่ถึงขั้นใหม่ */
  escalation: StallEscalation;
  /** loop ไม่ได้ sync สำเร็จมานานเท่าไร */
  stalledMs: number;
}

export interface StallRecovery {
  /** ความสำเร็จครั้งนี้ปิดอาการค้างที่เคยไต่ขั้นไปแล้วหรือไม่ */
  recovered: boolean;
  /** อาการค้างกินเวลาไปเท่าไร; 0 ถ้าไม่เคยค้าง */
  stalledMs: number;
  /** ขั้นสูงสุดที่อาการค้างรอบนี้ไปถึง */
  reached: StallEscalation;
}

export interface StallTracker {
  noteFailure(now?: number): StallStep;
  noteSuccess(now?: number): StallRecovery;
}

/**
 * ติดตาม "นานแค่ไหนแล้วตั้งแต่ `sync()` ทำงานสำเร็จครั้งล่าสุด" และรายงานแต่ละขั้น **ครั้งเดียว**
 *
 * การ latch สำคัญพอ ๆ กับตัวเลข threshold: loop ล้มเหลวทุก ~5 วินาที บันไดที่ไม่ latch
 * จะรายงานบอทค้างซ้ำ 12 ครั้งต่อนาทีและ resync ใหม่ทุก retry ซึ่งกลบสิ่งที่มันมีไว้เพื่อ
 * ทำให้มองเห็น
 */
export function createStallTracker(): StallTracker {
  let firstFailureAt = 0;
  let reached: StallEscalation = "none";

  return {
    noteFailure(now: number = Date.now()): StallStep {
      if (firstFailureAt === 0) firstFailureAt = now;
      const stalledMs = now - firstFailureAt;

      for (const rung of LADDER) {
        if (stalledMs >= rung.at && RANK[reached] < RANK[rung.step]) {
          reached = rung.step;
          return { escalation: rung.step, stalledMs };
        }
      }
      return { escalation: "none", stalledMs };
    },

    noteSuccess(now: number = Date.now()): StallRecovery {
      const stalledMs = firstFailureAt === 0 ? 0 : now - firstFailureAt;
      const recovery: StallRecovery = { recovered: reached !== "none", stalledMs, reached };
      firstFailureAt = 0;
      reached = "none";
      return recovery;
    },
  };
}

// ─── Bounded stall restarts ───────────────────────────────────────────────

/**
 * อาการค้างหนึ่งรอบสั่ง relaunch container ได้กี่ครั้งก่อนที่ worker จะยอมแพ้และรอคน
 * ตั้งไว้น้อยโดยตั้งใจ: ทุกครั้งที่ relaunch คือการ login LINE อีกครั้ง และ login รัว ๆ
 * คือช่องทางโดนแบน ลิ่มที่รอด restart สะอาด ๆ สองครั้งไม่ใช่สิ่งที่ครั้งที่สามจะแก้ได้
 */
export const MAX_STALL_RESTARTS = 2;

/**
 * restart ที่ห่างกันเกินกว่านี้นับเป็นคนละเหตุการณ์ ไม่ใช่ loop เดียวกัน กว้างเพราะกว่า
 * อาการค้างจะไต่ถึงขั้น restart ก็ใช้เวลา 10 นาทีแล้ว สองขั้นบวกเวลา reboot จึงกินไป ~25 นาที
 */
const EPISODE_WINDOW_MS = 2 * 60 * 60 * 1000;

function restartFile(): string {
  return process.env["STALL_RESTART_FILE"] || "/tmp/rlbotline-stall-restarts";
}

interface RestartRecord {
  count: number;
  lastRestartAt: number;
}

function readRecord(): RestartRecord {
  try {
    const parsed = JSON.parse(readFileSync(restartFile(), "utf8")) as Partial<RestartRecord>;
    if (typeof parsed.count === "number" && typeof parsed.lastRestartAt === "number") {
      return { count: parsed.count, lastRestartAt: parsed.lastRestartAt };
    }
  } catch {
    // ไม่มีไฟล์หรือไฟล์เสีย — เริ่มนับใหม่
  }
  return { count: 0, lastRestartAt: 0 };
}

/**
 * บันทึก restart ที่เกิดจากอาการค้างหนึ่งครั้ง แล้วคืนจำนวนครั้งของรอบนี้ (เริ่มที่ 1)
 * marker อยู่ใน writable layer ของ container ดังนั้น `docker restart` จะนับต่อ ส่วน
 * recreate/redeploy จะรีเซ็ตเองตามธรรมชาติ
 */
export function recordStallRestart(now: number = Date.now()): number {
  const prev = readRecord();
  const stale = prev.lastRestartAt === 0 || now - prev.lastRestartAt > EPISODE_WINDOW_MS;
  const count = (stale ? 0 : prev.count) + 1;

  try {
    writeFileSync(restartFile(), JSON.stringify({ count, lastRestartAt: now }));
  } catch {
    // เขียน marker ไม่ได้: เดินหน้าต่อแบบไม่จำกัดดีกว่าปฏิเสธที่จะกู้ —
    // ไม่แย่ไปกว่าพฤติกรรมเดิมที่ไม่เคย restart เลย
  }
  return count;
}

/** อาการค้างจบลงโดยไม่ต้อง restart — รอบนี้ปิดแล้ว */
export function clearStallRestarts(): void {
  try {
    unlinkSync(restartFile());
  } catch {
    // ไม่มีอยู่แล้ว — ไม่มีอะไรต้องล้าง
  }
}
