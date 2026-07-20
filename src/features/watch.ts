/**
 * rlbotline Worker — Watched Chats Feature
 *
 * จัดการรายการ chat ที่บอท "ตามอ่าน" (อ่านเฉพาะข้อความ live → forward
 * ไปยัง Central API หรือ external webhook ใน Phase 3)
 *
 * Commands (admin+):
 *   !watch list                          — ดูรายการ chat ที่ตามอ่านอยู่
 *   !watch chats [group|oa]              — ดู chat ทั้งหมดที่บอท join (filter ได้)
 *   !watch here                          — เพิ่ม chat ปัจจุบันเข้ารายการ
 *   !watch add <chatId>                  — เพิ่ม chat ตาม id
 *   !watch remove <chatId>               — ลบ chat ออก
 *   !watch on <chatId>                   — เปิดใช้งาน
 *   !watch off <chatId>                  — ปิดใช้งานชั่วคราว
 *   !watch url <chatId> <url|clear>      — ตั้ง/ลบ forward URL
 */

import { getClient, sendBotMessage } from "../core/line-client.js";
import { logger } from "../core/logger.js";
import { listAllChats } from "../core/chat-lister.js";
import {
  addWatched,
  removeWatched,
  toggleEnabled,
  setForwardUrl,
  listWatched,
  getWatched,
} from "../core/chat-registry.js";
import { hasPermission } from "../core/database.js";
import { PermissionRole, type Feature, type BotCommand, type ChatType } from "../types.js";

const TYPE_ICON: Record<ChatType, string> = {
  group: "👥",
  oa: "🏢",
  user: "👤",
  room: "💬",
  square: "🟦",
  unknown: "❓",
};

async function reply(chatId: string, text: string): Promise<void> {
  await sendBotMessage(chatId, text);
}

async function requireAdmin(cmd: BotCommand): Promise<boolean> {
  const ok = await hasPermission(cmd.senderId, PermissionRole.ADMIN);
  if (!ok) {
    await reply(cmd.chatId, "❌ คำสั่งนี้สำหรับ admin เท่านั้น");
  }
  return ok;
}

/** Resolve the display name of a chat by scanning the discovered list. */
async function resolveChatInfo(
  chatId: string,
): Promise<{ name: string; type: ChatType } | null> {
  try {
    const client = getClient();
    const all = await listAllChats(client);
    const found = all.find((c) => c.id === chatId);
    if (found) return { name: found.name, type: found.type };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("resolveChatInfo failed", { chatId, error: msg });
  }
  return null;
}

function typeFromMid(chatId: string): ChatType {
  const p = chatId[0];
  if (p === "c") return "group";
  if (p === "r") return "room";
  if (p === "s" || p === "m") return "square";
  if (p === "u") return "user"; // unknown if OA without contact lookup
  return "unknown";
}

async function cmdList(cmd: BotCommand): Promise<void> {
  const rows = listWatched();
  if (rows.length === 0) {
    await reply(cmd.chatId, "📭 ยังไม่มี chat ในรายการ\nใช้ `!watch chats` เพื่อดูทั้งหมด แล้ว `!watch add <id>`");
    return;
  }
  const lines = ["📋 รายการ chat ที่ตามอ่าน:", "─".repeat(20)];
  for (const r of rows) {
    const icon = TYPE_ICON[r.chatType] ?? "❓";
    const status = r.enabled ? "✅" : "⏸️";
    const fwd = r.forwardUrl ? " 🔗" : "";
    lines.push(`${status} ${icon} ${r.chatName}${fwd}`);
    lines.push(`   \`${r.chatId}\``);
  }
  lines.push("─".repeat(20));
  lines.push(`รวม: ${rows.length} chat`);
  await reply(cmd.chatId, lines.join("\n"));
}

async function cmdChats(cmd: BotCommand): Promise<void> {
  const filter = cmd.args[1]?.toLowerCase();
  await reply(cmd.chatId, "⏳ กำลังโหลดรายการ chat ทั้งหมด...");
  const client = getClient();
  let all = await listAllChats(client);

  if (filter === "group" || filter === "oa" || filter === "user") {
    all = all.filter((c) => c.type === filter);
  }

  if (all.length === 0) {
    await reply(cmd.chatId, "📭 ไม่พบ chat");
    return;
  }

  // chunk เพื่อกัน message ยาวเกินไป (LINE จำกัด ~5000 ตัวอักษร)
  const MAX_PER_MSG = 30;
  for (let i = 0; i < all.length; i += MAX_PER_MSG) {
    const slice = all.slice(i, i + MAX_PER_MSG);
    const lines: string[] = [];
    if (i === 0) {
      lines.push(`📑 รายการ chat ทั้งหมด (${all.length})`);
      lines.push("─".repeat(20));
    }
    for (const c of slice) {
      const icon = TYPE_ICON[c.type];
      lines.push(`${icon} ${c.name}`);
      lines.push(`   \`${c.id}\``);
    }
    await reply(cmd.chatId, lines.join("\n"));
  }
}

async function cmdAdd(cmd: BotCommand, targetId: string): Promise<void> {
  const existing = getWatched(targetId);
  if (existing) {
    await reply(cmd.chatId, `⚠️ chat นี้อยู่ในรายการอยู่แล้ว: ${existing.chatName}`);
    return;
  }

  const info = await resolveChatInfo(targetId);
  const chatType = info?.type ?? typeFromMid(targetId);
  const chatName = info?.name ?? "(ไม่ทราบชื่อ)";

  await addWatched({
    chatId: targetId,
    chatName,
    chatType,
    addedBy: cmd.senderId,
  });

  const icon = TYPE_ICON[chatType];
  await reply(cmd.chatId, `✅ เพิ่ม ${icon} ${chatName} เข้ารายการแล้ว`);
}

async function cmdRemove(cmd: BotCommand, targetId: string): Promise<void> {
  const ok = await removeWatched(targetId);
  if (ok) {
    await reply(cmd.chatId, `🗑️ ลบ \`${targetId}\` ออกจากรายการแล้ว`);
  } else {
    await reply(cmd.chatId, `⚠️ ไม่พบ chat นี้ในรายการ`);
  }
}

async function cmdToggle(cmd: BotCommand, targetId: string, enabled: boolean): Promise<void> {
  const ok = await toggleEnabled(targetId, enabled);
  if (ok) {
    await reply(cmd.chatId, enabled ? `▶️ เปิดใช้งาน \`${targetId}\` แล้ว` : `⏸️ ปิดใช้งาน \`${targetId}\` แล้ว`);
  } else {
    await reply(cmd.chatId, `⚠️ ไม่พบ chat นี้ในรายการ`);
  }
}

async function cmdUrl(cmd: BotCommand): Promise<void> {
  const targetId = cmd.args[1];
  const value = cmd.args[2];
  if (!targetId || !value) {
    await reply(cmd.chatId, "ใช้: `!watch url <chatId> <url|clear>`");
    return;
  }
  const url = value.toLowerCase() === "clear" ? null : value;
  if (url && !/^https?:\/\//i.test(url)) {
    await reply(cmd.chatId, "❌ URL ต้องขึ้นต้นด้วย http:// หรือ https://");
    return;
  }
  const ok = await setForwardUrl(targetId, url);
  if (ok) {
    await reply(cmd.chatId, url ? `🔗 ตั้ง forward URL แล้ว: ${url}` : `🔗 ลบ forward URL แล้ว`);
  } else {
    await reply(cmd.chatId, `⚠️ ไม่พบ chat นี้ในรายการ`);
  }
}

export function createWatchFeature(): Feature {
  return {
    name: "watch",
    commands: ["watch"],
    description: "👁️ จัดการรายการ chat ที่ตามอ่าน — !watch help",
    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await requireAdmin(cmd))) return;

      const sub = (cmd.args[0] ?? "help").toLowerCase();

      switch (sub) {
        case "list":
          await cmdList(cmd);
          return;
        case "chats":
          await cmdChats(cmd);
          return;
        case "here":
          await cmdAdd(cmd, cmd.chatId);
          return;
        case "add": {
          const id = cmd.args[1];
          if (!id) {
            await reply(cmd.chatId, "ใช้: `!watch add <chatId>`");
            return;
          }
          await cmdAdd(cmd, id);
          return;
        }
        case "remove":
        case "rm":
        case "del": {
          const id = cmd.args[1];
          if (!id) {
            await reply(cmd.chatId, "ใช้: `!watch remove <chatId>`");
            return;
          }
          await cmdRemove(cmd, id);
          return;
        }
        case "on":
        case "off": {
          const id = cmd.args[1];
          if (!id) {
            await reply(cmd.chatId, `ใช้: \`!watch ${sub} <chatId>\``);
            return;
          }
          await cmdToggle(cmd, id, sub === "on");
          return;
        }
        case "url":
          await cmdUrl(cmd);
          return;
        case "help":
        default:
          await reply(
            cmd.chatId,
            [
              "👁️ คำสั่ง !watch (admin+):",
              "  `!watch list` — รายการที่ตามอ่าน",
              "  `!watch chats [group|oa|user]` — ดู chat ทั้งหมด",
              "  `!watch here` — เพิ่ม chat ปัจจุบัน",
              "  `!watch add <id>` — เพิ่มตาม id",
              "  `!watch remove <id>` — ลบ",
              "  `!watch on <id>` / `!watch off <id>` — เปิด/ปิด",
              "  `!watch url <id> <url|clear>` — ตั้ง forward URL",
            ].join("\n"),
          );
      }
    },
  };
}
