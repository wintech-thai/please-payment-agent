/**
 * rlbotline Worker — Anti-Link Feature (Phase 3)
 *
 * Filters messages containing URLs in group chats.
 * Unsends the offending message and warns the sender.
 * Admin/Owner messages are exempt.
 */

import { logger } from "../core/logger.js";
import { getClient, sendBotMessage } from "../core/line-client.js";
import {
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

/** Cooldown: max 1 link warning per 3 seconds per chat */
const warnCooldown = new ChatCooldown(3000);
setInterval(() => warnCooldown.cleanup(), 5 * 60 * 1000);

/**
 * URL detection regex patterns.
 * Matches http(s) URLs, line.me links, and common URL patterns.
 */
const URL_PATTERNS: RegExp[] = [
  /https?:\/\/\S+/i,
  /line\.me\/\S+/i,
  /bit\.ly\/\S+/i,
  /t\.co\/\S+/i,
  /goo\.gl\/\S+/i,
  /tinyurl\.com\/\S+/i,
  /discord\.gg\/\S+/i,
  /t\.me\/\S+/i,
];

/**
 * Check if a text contains any URL pattern.
 * Exported for unit testing.
 */
export function containsUrl(text: string): boolean {
  return URL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Check if anti-link is enabled for a given chat.
 */
async function isEnabled(chatId: string): Promise<boolean> {
  return isGroupCommandEnabled(chatId, "antilink");
}

/**
 * Handle incoming messages for link filtering.
 */
async function handleAntiLink(message: RawMessage): Promise<void> {
  if (!message.text || message.contentType !== 0) return;
  if (!(await isEnabled(message.chatId))) return;

  // Admin/Owner messages are exempt
  if (await hasPermission(message.senderId, PermissionRole.ADMIN)) return;

  // Check for URLs
  if (!containsUrl(message.text)) return;

  const lineClient = getClient();

  // Try to unsend the message
  try {
    await lineClient.base.talk.unsendMessage({
      messageId: message.id,
    });
    logger.info("Anti-link: unsent message with URL", {
      chatId: message.chatId,
      senderId: message.senderId,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug("Anti-link: could not unsend (may not have permission)", {
      error: msg,
    });
  }

  // Warn the user (with cooldown)
  if (warnCooldown.tryAcquire(message.chatId)) {
    try {
      await sendBotMessage(message.chatId, "🔗 ห้ามส่งลิงก์ในกลุ่มนี้");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Anti-link: failed to send warning", { error: msg });
    }
  }
}

/**
 * Create the Anti-Link feature.
 */
export function createAntiLinkFeature(): Feature {
  // Register raw message listener
  onRawMessage(handleAntiLink);

  return {
    name: "anti-link",
    commands: ["antilink"],
    description: "🔗 ป้องกันลิงก์ — !antilink on/off/status",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      const action = cmd.args[0]?.toLowerCase();

      switch (action) {
        case "on":
        case "off": {
          await setGroupCommandEnabled(cmd.chatId, "antilink", action === "on", cmd.senderId);
          const emoji = action === "on" ? "✅" : "⛔";
          await sendBotMessage(cmd.chatId, `${emoji} Anti-Link ${action === "on" ? "เปิด" : "ปิด"}แล้ว`);
          break;
        }

        default: {
          const enabled = await isEnabled(cmd.chatId);
          await sendBotMessage(
            cmd.chatId,
            [
              `🔗 Anti-Link: ${enabled ? "✅ เปิด" : "⛔ ปิด"}`,
              "",
              "คำสั่ง:",
              "• !antilink on — เปิดป้องกันลิงก์",
              "• !antilink off — ปิดป้องกันลิงก์",
              "",
              "💡 เมื่อเปิด บอทจะลบข้อความที่มีลิงก์อัตโนมัติ",
              "💡 ข้อความจาก Admin/Owner จะไม่ถูกลบ",
            ].join("\n"),
          );
        }
      }
    },
  };
}
