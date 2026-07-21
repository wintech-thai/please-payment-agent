/**
 * rlbotline Worker — Word Filter Feature (Phase 2)
 *
 * Filters messages containing banned words.
 * Attempts to unsend the offending message and warns the user.
 * Admin/Owner messages are exempt.
 */

import { logger } from "../core/logger.js";
import { getClient, sendBotMessage } from "../core/line-client.js";
import {
  addWordFilter,
  removeWordFilter,
  getWordFilters,
  getWordFiltersForChat,
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

/** Cooldown: max 1 filter warning per 3 seconds per chat */
const warnCooldown = new ChatCooldown(3000);
setInterval(() => warnCooldown.cleanup(), 5 * 60 * 1000);

/**
 * Check if word filter is enabled for a given chat.
 */
async function isEnabled(chatId: string): Promise<boolean> {
  return isGroupCommandEnabled(chatId, "filter");
}

/**
 * Check if a message contains any filtered words.
 */
async function findFilteredWord(text: string, chatId: string): Promise<string | null> {
  const filters = await getWordFilters(chatId);
  const lowerText = text.toLowerCase();

  for (const filter of filters) {
    if (lowerText.includes(filter.word)) {
      return filter.word;
    }
  }

  return null;
}

/**
 * Handle incoming messages for word filtering.
 */
async function handleWordFilter(message: RawMessage): Promise<void> {
  if (!message.text || message.contentType !== 0) return;
  if (!(await isEnabled(message.chatId))) return;

  // Admin/Owner messages are exempt
  if (await hasPermission(message.senderId, PermissionRole.ADMIN)) return;

  const matchedWord = await findFilteredWord(message.text, message.chatId);
  if (!matchedWord) return;

  const lineClient = getClient();

  // Try to unsend/delete the offending message
  try {
    await lineClient.base.talk.unsendMessage({
      messageId: message.id,
    });
    logger.info("Word filter: unsent message", {
      chatId: message.chatId,
      senderId: message.senderId,
      matchedWord,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug("Word filter: could not unsend (may not have permission)", {
      error: msg,
    });
  }

  // Warn the user (with cooldown)
  if (warnCooldown.tryAcquire(message.chatId)) {
    try {
      await sendBotMessage(message.chatId, `⚠️ ข้อความถูกกรอง — ห้ามใช้คำต้องห้ามในกลุ่มนี้`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Word filter: failed to send warning", { error: msg });
    }
  }
}

/**
 * Create the Word Filter feature.
 */
export function createWordFilterFeature(): Feature {
  // Register raw message listener
  onRawMessage(handleWordFilter);

  return {
    name: "word-filter",
    commands: ["filter", "wordfilter"],
    description:
      "🚫 กรองคำต้องห้าม — !filter add/remove/list/on/off",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      const action = cmd.args[0]?.toLowerCase();

      switch (action) {
        case "add": {
          const word = cmd.args.slice(1).join(" ").trim();
          if (!word) {
            await sendBotMessage(cmd.chatId, "❌ กรุณาระบุคำ — !filter add <คำ>");
            return;
          }

          await addWordFilter(cmd.chatId, word, cmd.senderId);
          await sendBotMessage(cmd.chatId, `✅ เพิ่มคำต้องห้าม "${word}" สำเร็จ`);

          logger.info("Word filter added", {
            chatId: cmd.chatId,
            word,
          });
          break;
        }

        case "remove":
        case "rm":
        case "del": {
          const word = cmd.args.slice(1).join(" ").trim();
          if (!word) {
            await sendBotMessage(cmd.chatId, "❌ กรุณาระบุคำ — !filter remove <คำ>");
            return;
          }

          const removed = await removeWordFilter(cmd.chatId, word);
          if (removed) {
            await sendBotMessage(cmd.chatId, `✅ ลบคำต้องห้าม "${word}" สำเร็จ`);
          } else {
            await sendBotMessage(cmd.chatId, `❌ ไม่พบคำ "${word}" ในรายการ`);
          }
          break;
        }

        case "list": {
          const filters = await getWordFiltersForChat(cmd.chatId);
          if (filters.length === 0) {
            await sendBotMessage(cmd.chatId, "📋 ไม่มีคำต้องห้ามในกลุ่มนี้");
            return;
          }

          const lines = filters.map(
            (f, i) => `${i + 1}. 🚫 "${f.word}"`,
          );

          await sendBotMessage(cmd.chatId, `📋 คำต้องห้าม (${filters.length}):\n${lines.join("\n")}`);
          break;
        }

        case "on":
        case "off": {
          await setGroupCommandEnabled(cmd.chatId, "filter", action === "on", cmd.senderId);
          const emoji = action === "on" ? "✅" : "⛔";
          await sendBotMessage(cmd.chatId, `${emoji} Word Filter ${action === "on" ? "เปิด" : "ปิด"}แล้ว`);
          break;
        }

        default: {
          const enabled = await isEnabled(cmd.chatId);
          await sendBotMessage(
            cmd.chatId,
            [
              `🚫 Word Filter: ${enabled ? "✅ เปิด" : "⛔ ปิด"}`,
              "",
              "คำสั่ง:",
              "• !filter add <คำ>",
              "• !filter remove <คำ>",
              "• !filter list",
              "• !filter on/off",
              "",
              "💡 ข้อความ Admin/Owner จะไม่ถูกกรอง",
            ].join("\n"),
          );
        }
      }
    },
  };
}
