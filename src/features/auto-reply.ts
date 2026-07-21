/**
 * rlbotline Worker — Auto-Reply Feature (Phase 2)
 *
 * Keyword-based automatic responses. Supports exact, contains,
 * and starts-with matching with per-chat or global rules.
 */

import { logger } from "../core/logger.js";
import { sendBotMessage } from "../core/line-client.js";
import {
  addAutoReply,
  removeAutoReply,
  getAutoReplies,
  getAutoRepliesForChat,
  hasPermission,
  isGroupCommandEnabled,
  setGroupCommandEnabled,
} from "../core/database.js";
import {
  onRawMessage,
  type RawMessage,
} from "../core/event-router.js";
import { ChatCooldown } from "../core/rate-limiter.js";
import { PermissionRole, type Feature, type BotCommand } from "../types.js";

/** Cooldown: max 1 auto-reply per 5 seconds per chat */
const replyCooldown = new ChatCooldown(5000);
setInterval(() => replyCooldown.cleanup(), 5 * 60 * 1000);

/**
 * Check if auto-reply is enabled for a given chat.
 */
async function isEnabled(chatId: string): Promise<boolean> {
  return isGroupCommandEnabled(chatId, "autoreply");
}

/**
 * Check if a message matches any auto-reply keyword.
 */
async function findMatchingReply(
  text: string,
  chatId: string,
): Promise<{ keyword: string; response: string } | null> {
  const rules = await getAutoReplies(chatId);
  const lowerText = text.toLowerCase();

  for (const rule of rules) {
    switch (rule.matchType) {
      case "exact":
        if (lowerText === rule.keyword) {
          return { keyword: rule.keyword, response: rule.response };
        }
        break;
      case "contains":
        if (lowerText.includes(rule.keyword)) {
          return { keyword: rule.keyword, response: rule.response };
        }
        break;
      case "startswith":
        if (lowerText.startsWith(rule.keyword)) {
          return { keyword: rule.keyword, response: rule.response };
        }
        break;
    }
  }

  return null;
}

/**
 * Handle incoming messages for auto-reply.
 */
async function handleAutoReply(message: RawMessage): Promise<void> {
  if (!message.text || message.contentType !== 0) return;
  if (!(await isEnabled(message.chatId))) return;

  // Skip if message starts with command prefix (don't auto-reply to commands)
  if (message.text.startsWith("!")) return;

  // Per-chat cooldown
  if (!replyCooldown.tryAcquire(message.chatId)) return;

  const match = await findMatchingReply(message.text, message.chatId);
  if (!match) return;

  try {
    await message.reply(match.response);
    logger.debug("Auto-reply triggered", {
      chatId: message.chatId,
      keyword: match.keyword,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Auto-reply send failed", { error: msg });
  }
}

/**
 * Parse "keyword | response" from args, supporting the pipe delimiter.
 */
function parseKeywordResponse(args: string[]): {
  keyword: string;
  response: string;
  matchType: "exact" | "contains" | "startswith";
} | null {
  const fullText = args.join(" ");
  const pipeIndex = fullText.indexOf("|");

  if (pipeIndex === -1 || pipeIndex === 0) return null;

  let keyword = fullText.substring(0, pipeIndex).trim();
  const response = fullText.substring(pipeIndex + 1).trim();

  if (!keyword || !response) return null;

  // Check for match type prefix
  let matchType: "exact" | "contains" | "startswith" = "contains";
  if (keyword.startsWith("exact:")) {
    matchType = "exact";
    keyword = keyword.substring(6).trim();
  } else if (keyword.startsWith("starts:")) {
    matchType = "startswith";
    keyword = keyword.substring(7).trim();
  }

  return { keyword, response, matchType };
}

/**
 * Create the Auto-Reply feature.
 */
export function createAutoReplyFeature(): Feature {
  // Register raw message listener
  onRawMessage(handleAutoReply);

  return {
    name: "auto-reply",
    commands: ["autoreply", "ar"],
    description:
      "💬 ตอบกลับอัตโนมัติ — !autoreply add/remove/list/on/off",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      const action = cmd.args[0]?.toLowerCase();

      switch (action) {
        case "add": {
          const parsed = parseKeywordResponse(cmd.args.slice(1));
          if (!parsed) {
            await sendBotMessage(
              cmd.chatId,
              [
                "❌ รูปแบบไม่ถูกต้อง",
                "",
                "วิธีใช้: !autoreply add <keyword> | <response>",
                "",
                "ตัวอย่าง:",
                "• !autoreply add สวัสดี | สวัสดีครับ! 😊",
                "• !autoreply add exact:hello | Hi there!",
                "• !autoreply add starts:!info | ℹ️ ข้อมูลบอท...",
                "",
                "Match types:",
                "• (default) contains — จับคู่ถ้ามีคำนั้นอยู่",
                "• exact: — จับคู่เฉพาะข้อความตรงทั้งหมด",
                "• starts: — จับคู่ข้อความที่ขึ้นต้นด้วย",
              ].join("\n"),
            );
            return;
          }

          await addAutoReply(
            cmd.chatId,
            parsed.keyword,
            parsed.response,
            parsed.matchType,
            cmd.senderId,
          );

          const matchLabel = {
            exact: "ตรงทั้งหมด",
            contains: "มีคำว่า",
            startswith: "ขึ้นต้นด้วย",
          };

          await sendBotMessage(
            cmd.chatId,
            `✅ เพิ่ม Auto-Reply สำเร็จ\n🔑 Keyword: "${parsed.keyword}" (${matchLabel[parsed.matchType]})\n💬 Response: "${parsed.response}"`,
          );

          logger.info("Auto-reply added", {
            chatId: cmd.chatId,
            keyword: parsed.keyword,
            matchType: parsed.matchType,
          });
          break;
        }

        case "remove":
        case "rm":
        case "del": {
          const keyword = cmd.args.slice(1).join(" ").trim();
          if (!keyword) {
            await sendBotMessage(cmd.chatId, "❌ กรุณาระบุ keyword — !autoreply remove <keyword>");
            return;
          }

          const removed = await removeAutoReply(cmd.chatId, keyword);
          if (removed) {
            await sendBotMessage(cmd.chatId, `✅ ลบ Auto-Reply "${keyword}" สำเร็จ`);
          } else {
            await sendBotMessage(cmd.chatId, `❌ ไม่พบ Auto-Reply "${keyword}"`);
          }
          break;
        }

        case "list": {
          const rules = await getAutoRepliesForChat(cmd.chatId);
          if (rules.length === 0) {
            await sendBotMessage(cmd.chatId, "📋 ไม่มี Auto-Reply ในกลุ่มนี้");
            return;
          }

          const lines = rules.map(
            (r, i) =>
              `${i + 1}. 🔑 "${r.keyword}" (${r.matchType})\n   💬 "${r.response}"`,
          );

          await sendBotMessage(cmd.chatId, `📋 Auto-Reply (${rules.length}):\n${lines.join("\n")}`);
          break;
        }

        case "on":
        case "off": {
          await setGroupCommandEnabled(cmd.chatId, "autoreply", action === "on", cmd.senderId);
          const emoji = action === "on" ? "✅" : "⛔";
          await sendBotMessage(cmd.chatId, `${emoji} Auto-Reply ${action === "on" ? "เปิด" : "ปิด"}แล้ว`);
          break;
        }

        default: {
          const enabled = await isEnabled(cmd.chatId);
          await sendBotMessage(
            cmd.chatId,
            [
              `💬 Auto-Reply: ${enabled ? "✅ เปิด" : "⛔ ปิด"}`,
              "",
              "คำสั่ง:",
              "• !autoreply add <keyword> | <response>",
              "• !autoreply remove <keyword>",
              "• !autoreply list",
              "• !autoreply on/off",
            ].join("\n"),
          );
        }
      }
    },
  };
}
