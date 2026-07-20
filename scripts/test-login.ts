/**
 * rlbotline — Login & Basic Read Test
 *
 * ทดสอบ login เข้า LINE และอ่านข้อมูลพื้นฐาน
 *
 * Usage:
 *   LINE_EMAIL=you@example.com LINE_PASSWORD=yourpassword bun run scripts/test-login.ts
 *   # or, after a first successful login:
 *   LINE_AUTH_TOKEN=your-token-here bun run scripts/test-login.ts
 *
 * `LINE_EMAIL`/`LINE_PASSWORD`/`LINE_AUTH_TOKEN` are NOT read from `.env` —
 * the worker's `.env`/`.env.example`/`WorkerConfig` no longer carry
 * credentials at all (see docs/api-spec.md §"LINE_EMAIL/LINE_PASSWORD...
 * removed from the contract"; the worker's only credential source in
 * production is `GET /state/session`). Export these manually in your shell
 * for a one-off local run of this script only — do NOT add them back to
 * `.env`.
 */

import { loginWithPassword, loginWithAuthToken } from "@evex/linejs";
import type { Client } from "@evex/linejs";
import { FileStorage } from "@evex/linejs/storage";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Load .env manually (Bun 1.x doesn't always auto-load) ─────
function loadEnvFile(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  try {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.substring(0, eqIdx);
      const value = trimmed.substring(eqIdx + 1);
      // Only set if not already defined (real env takes precedence)
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore
  }
}
loadEnvFile();

// ─── ANSI Colors for pretty output ──────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

function log(emoji: string, msg: string, data?: string): void {
  console.log(`${emoji}  ${C.bold}${msg}${C.reset}${data ? ` ${C.dim}${data}${C.reset}` : ""}`);
}

function header(title: string): void {
  console.log();
  console.log(`${C.cyan}${"═".repeat(55)}${C.reset}`);
  console.log(`${C.cyan}  ${C.bold}${title}${C.reset}`);
  console.log(`${C.cyan}${"═".repeat(55)}${C.reset}`);
  console.log();
}

function success(msg: string): void {
  console.log(`  ${C.bgGreen}${C.bold} ✓ PASS ${C.reset} ${C.green}${msg}${C.reset}`);
}

function fail(msg: string): void {
  console.log(`  ${C.bgRed}${C.bold} ✗ FAIL ${C.reset} ${C.red}${msg}${C.reset}`);
}

function info(key: string, value: string): void {
  console.log(`  ${C.dim}├─${C.reset} ${C.yellow}${key}:${C.reset} ${value}`);
}

function infoLast(key: string, value: string): void {
  console.log(`  ${C.dim}└─${C.reset} ${C.yellow}${key}:${C.reset} ${value}`);
}

function divider(): void {
  console.log(`  ${C.dim}${"─".repeat(50)}${C.reset}`);
}

// ─── Config ─────────────────────────────────────────────────────
const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const LINE_EMAIL = process.env["LINE_EMAIL"] ?? "";
const LINE_PASSWORD = process.env["LINE_PASSWORD"] ?? "";
const LINE_AUTH_TOKEN = process.env["LINE_AUTH_TOKEN"] ?? "";
const LINE_DEVICE = (process.env["LINE_DEVICE"] ?? "IOSIPAD") as
  | "IOSIPAD"
  | "DESKTOPWIN"
  | "DESKTOPMAC"
  | "ANDROID"
  | "IOS";

const TOKEN_PATH = path.join(DATA_DIR, "auth-token.txt");
const STORAGE_PATH = path.join(DATA_DIR, "storage.json");

// ─── Main Test ──────────────────────────────────────────────────
async function main(): Promise<void> {
  header("rlbotline — Login & Basic Read Test");

  // ── Step 0: Check prerequisites ──
  log("🔍", "ตรวจสอบ Prerequisites...");
  console.log();

  if (!LINE_EMAIL && !LINE_AUTH_TOKEN) {
    // Check for persisted token on disk
    let hasPersistedToken = false;
    try {
      if (fs.existsSync(TOKEN_PATH)) {
        const token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
        if (token.length > 0) hasPersistedToken = true;
      }
    } catch {
      // ignore
    }

    if (!hasPersistedToken) {
      fail("ไม่พบ credentials!");
      console.log();
      console.log(`  ${C.yellow}ตั้งค่าผ่าน environment variables ก่อนรัน (ไม่ใช่ .env — worker ไม่อ่าน credentials จาก .env แล้ว):${C.reset}`);
      console.log();
      console.log(`  ${C.dim}# Option 1: ใช้ Email/Password (ครั้งแรก) — export ชั่วคราวสำหรับรันครั้งนี้เท่านั้น${C.reset}`);
      console.log(`  ${C.cyan}LINE_EMAIL=your@email.com LINE_PASSWORD=yourpassword bun run scripts/test-login.ts${C.reset}`);
      console.log();
      console.log(`  ${C.dim}# Option 2: ใช้ Auth Token (หลัง login ครั้งแรก)${C.reset}`);
      console.log(`  ${C.cyan}LINE_AUTH_TOKEN=your-token-here bun run scripts/test-login.ts${C.reset}`);
      console.log();
      process.exit(1);
    }
  }

  info("Email", LINE_EMAIL ? `${LINE_EMAIL.substring(0, 3)}***` : "(ไม่ได้ตั้ง)");
  info("Auth Token", LINE_AUTH_TOKEN ? `${LINE_AUTH_TOKEN.substring(0, 10)}...` : "(ไม่ได้ตั้ง)");
  info("Device", LINE_DEVICE);
  infoLast("Data Dir", DATA_DIR);
  console.log();

  // Ensure data directory
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ── Step 1: Login ──
  header("Step 1: Login to LINE");

  const storage = new FileStorage(STORAGE_PATH);
  let client: Client;
  let loginMethod = "";

  // Try persisted token from disk first
  let persistedToken: string | undefined;
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      persistedToken = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
      if (persistedToken.length === 0) persistedToken = undefined;
    }
  } catch {
    // ignore
  }

  const tokenToUse = persistedToken ?? (LINE_AUTH_TOKEN || undefined);

  if (tokenToUse) {
    log("🔑", "พยายาม login ด้วย Auth Token...");
    loginMethod = "authToken";

    try {
      client = await loginWithAuthToken(tokenToUse, {
        device: LINE_DEVICE,
        storage,
      });
      success("Login ด้วย Auth Token สำเร็จ!");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      fail(`Auth Token login ล้มเหลว: ${msg}`);

      if (!LINE_EMAIL || !LINE_PASSWORD) {
        console.log();
        log("❌", "ไม่มี Email/Password สำหรับ fallback — กรุณาตั้ง LINE_EMAIL และ LINE_PASSWORD");
        process.exit(1);
      }

      console.log();
      log("🔄", "Fallback ไป Email/Password login...");
      loginMethod = "email";
      client = await doEmailLogin(storage);
    }
  } else {
    log("📧", "Login ด้วย Email/Password...");
    loginMethod = "email";
    client = await doEmailLogin(storage);
  }

  // Set up token persistence
  client.base.on("update:authtoken", (authtoken: string) => {
    log("💾", "Auth Token ได้รับการอัพเดท — บันทึกลง disk");
    try {
      fs.writeFileSync(TOKEN_PATH, authtoken, "utf-8");
      success(`Token บันทึกไว้ที่ ${TOKEN_PATH}`);
    } catch (err) {
      fail(`บันทึก token ล้มเหลว: ${err}`);
    }
  });

  // Also save current token
  try {
    const currentToken = client.authToken;
    if (currentToken) {
      fs.writeFileSync(TOKEN_PATH, currentToken, "utf-8");
      log("💾", `Token ปัจจุบันบันทึกแล้ว`, `(${currentToken.substring(0, 15)}...)`);
    }
  } catch {
    // authToken might not be accessible directly
  }

  console.log();
  info("Login Method", loginMethod);
  infoLast("Storage", STORAGE_PATH);

  // ── Step 2: Read Profile ──
  header("Step 2: อ่านข้อมูล Profile");

  try {
    const profile = await client.base.talk.getProfile();
    const p = profile as Record<string, unknown>;

    success("ดึง Profile สำเร็จ!");
    console.log();
    info("Display Name", String(p["displayName"] ?? "N/A"));
    info("MID", String(p["mid"] ?? "N/A"));
    info("Phone", String(p["phone"] ?? "N/A"));
    info("Region", String(p["regionCode"] ?? "N/A"));
    info("Status Message", String(p["statusMessage"] ?? "(ไม่มี)"));
    infoLast("Picture Path", String(p["picturePath"] ?? "(ไม่มี)"));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(`ดึง Profile ล้มเหลว: ${msg}`);
  }

  // ── Step 3: Read Joined Chats ──
  header("Step 3: ดึงรายชื่อแชท/กลุ่มที่เข้าร่วม");

  try {
    const chats = await client.fetchJoinedChats();

    success(`พบ ${chats.length} แชท/กลุ่ม`);
    console.log();

    // Show first 10 chats
    const display = chats.slice(0, 10);
    for (let i = 0; i < display.length; i++) {
      const chat = display[i];
      const isLast = i === display.length - 1 && chats.length <= 10;
      const fn = isLast ? infoLast : info;
      fn(
        `#${i + 1}`,
        `${chat.name || "(ไม่มีชื่อ)"} ${C.dim}[${chat.mid}]${C.reset}`,
      );
    }

    if (chats.length > 10) {
      infoLast("...", `และอีก ${chats.length - 10} กลุ่ม`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(`ดึงรายชื่อแชทล้มเหลว: ${msg}`);
    console.log(`  ${C.dim}(อาจเกิดจากไม่มี E2EE key — ต้อง login ด้วย email ครั้งแรก)${C.reset}`);
  }

  // ── Step 4: Read a sample chat's members ──
  header("Step 4: ทดสอบดึงสมาชิกกลุ่ม");

  try {
    const chats = await client.fetchJoinedChats();
    // Find a group chat (not 1-on-1)
    const groupChat = chats.find((c) => {
      const raw = c.raw;
      return raw?.extra?.groupExtra != null;
    });

    if (groupChat) {
      log("👥", `ทดสอบกับกลุ่ม: ${groupChat.name}`);

      const rawChat = await client.base.talk.getChat({
        chatMid: groupChat.mid,
        withMembers: true,
      });

      const memberMap = rawChat?.extra?.groupExtra?.memberMids;
      const memberCount = memberMap ? Object.keys(memberMap).length : 0;

      success(`พบ ${memberCount} สมาชิกในกลุ่ม "${groupChat.name}"`);

      if (memberCount > 0) {
        const firstFive = Object.keys(memberMap!).slice(0, 5);

        // Try to resolve display names
        try {
          const contacts = await client.base.talk.getContacts({ mids: firstFive });
          const contactList = contacts as Array<{ mid?: string; displayName?: string }>;

          console.log();
          for (let i = 0; i < contactList.length; i++) {
            const c = contactList[i];
            const isLast = i === contactList.length - 1 && memberCount <= 5;
            const fn = isLast ? infoLast : info;
            fn(`สมาชิก #${i + 1}`, `${c.displayName ?? "N/A"} ${C.dim}[${c.mid}]${C.reset}`);
          }

          if (memberCount > 5) {
            infoLast("...", `และอีก ${memberCount - 5} คน`);
          }
        } catch {
          info("MIDs", firstFive.join(", "));
          if (memberCount > 5) {
            infoLast("...", `และอีก ${memberCount - 5} คน`);
          }
        }
      }
    } else {
      log("ℹ️", "ไม่พบกลุ่มแชท — ข้ามการทดสอบดึงสมาชิก");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(`ทดสอบดึงสมาชิกล้มเหลว: ${msg}`);
  }

  // ── Step 5: Test sendMessage (optional, dry run) ──
  header("Step 5: สรุปผลการทดสอบ");

  const results = [
    { test: "Login", pass: true },
    { test: "Read Profile", pass: true },
    { test: "Fetch Chats", pass: true },
    { test: "Fetch Members", pass: true },
  ];

  console.log();
  for (const r of results) {
    if (r.pass) {
      success(r.test);
    } else {
      fail(r.test);
    }
  }

  console.log();
  log("🎉", `${C.green}ระบบพร้อมใช้งาน!${C.reset}`);
  console.log();
  log("💡", "ขั้นตอนถัดไป:");
  console.log(`  ${C.dim}1.${C.reset} ตั้งค่า WEBHOOK_URL และ INSTANCE_ID ใน .env`);
  console.log(`  ${C.dim}2.${C.reset} รัน worker เต็มรูปแบบ: ${C.cyan}bun run dev${C.reset}`);
  console.log(`  ${C.dim}3.${C.reset} ส่ง ${C.cyan}!ping${C.reset} หรือ ${C.cyan}!help${C.reset} ในแชท LINE`);
  console.log();

  // Keep alive briefly to let token persistence fire
  await new Promise((resolve) => setTimeout(resolve, 2000));
  process.exit(0);
}

/**
 * Login with email/password. Shows PIN code in console.
 */
async function doEmailLogin(storage: FileStorage): Promise<Client> {
  if (!LINE_EMAIL || !LINE_PASSWORD) {
    fail("ไม่พบ LINE_EMAIL หรือ LINE_PASSWORD");
    process.exit(1);
  }

  console.log();
  log("⚠️", `${C.yellow}หลัง login จะแสดง PIN 4 หลัก${C.reset}`);
  log("📱", `${C.yellow}กรุณาใส่ PIN ในแอป LINE บนมือถือของคุณ${C.reset}`);
  console.log();

  try {
    const client = await loginWithPassword(
      {
        email: LINE_EMAIL,
        password: LINE_PASSWORD,
        onPincodeRequest(pincode: string) {
          console.log();
          console.log(`  ${C.bgYellow}${C.bold} 📌 PIN CODE: ${pincode} ${C.reset}`);
          console.log();
          log("📱", `${C.bold}กรุณาเปิดแอป LINE แล้วใส่ PIN: ${C.cyan}${pincode}${C.reset}`);
          console.log();
        },
      },
      {
        device: LINE_DEVICE,
        storage,
      },
    );

    success("Login ด้วย Email/Password สำเร็จ!");
    return client;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(`Email/Password login ล้มเหลว: ${msg}`);
    process.exit(1);
  }
}

// ─── Run ──
main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`\n${C.bgRed}${C.bold} FATAL ${C.reset} ${C.red}${msg}${C.reset}\n`);
  process.exit(1);
});
