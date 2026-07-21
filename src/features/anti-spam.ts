/**
 * rlbotline Worker — Anti-Spam Feature (Phase 3)
 *
 * Detects rapid-fire messages from a single user in a chat.
 * If a user exceeds the threshold, the bot warns and optionally kicks.
 * Admin/Owner messages are exempt.
 */

import { logger } from "../core/logger.js";
import { getClient, kickFromGroup, sendBotMessage } from "../core/line-client.js";
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

/** Default spam threshold: max messages in window */
const DEFAULT_MAX_MESSAGES = 10;
/** Default spam window in milliseconds */
const DEFAULT_WINDOW_MS = 5000;

/** Cooldown: max 1 spam warning per 5 seconds per chat */
const warnCooldown = new ChatCooldown(5000);
setInterval(() => warnCooldown.cleanup(), 5 * 60 * 1000);

/** Tracking entry for a user's message rate */
interface SpamTracker {
  count: number;
  firstTimestamp: number;
  violations: number;
}

/**
 * In-memory spam tracking map.
 * Key: `chatId:userId`, Value: tracker
 * Exported for unit testing.
 */
export const spamTrackers: Map<string, SpamTracker> = new Map();

/**
 * Clean up old tracking entries (called periodically).
 */
export function cleanupTrackers(): void {
  const now = Date.now();
  const cutoff = now - DEFAULT_WINDOW_MS * 2;

  for (const [key, tracker] of spamTrackers) {
    if (tracker.firstTimestamp < cutoff) {
      spamTrackers.delete(key);
    }
  }
}

// Periodic cleanup every 60 seconds
setInterval(cleanupTrackers, 60_000);

/**
 * Track a message and determine if the user is spamming.
 * Returns the tracker if spam threshold is exceeded, null otherwise.
 * Exported for unit testing.
 */
export function trackMessage(
  chatId: string,
  userId: string,
  maxMessages: number = DEFAULT_MAX_MESSAGES,
  windowMs: number = DEFAULT_WINDOW_MS,
): SpamTracker | null {
  const key = `${chatId}:${userId}`;
  const now = Date.now();

  let tracker = spamTrackers.get(key);

  if (!tracker || now - tracker.firstTimestamp > windowMs) {
    // Start a new window
    tracker = { count: 1, firstTimestamp: now, violations: tracker?.violations ?? 0 };
    spamTrackers.set(key, tracker);
    return null;
  }

  // Increment counter within the window
  tracker.count++;

  if (tracker.count > maxMessages) {
    // Spam detected!
    tracker.violations++;
    // Reset counter for next window
    tracker.count = 0;
    tracker.firstTimestamp = now;
    return tracker;
  }

  return null;
}

/**
 * Check if anti-spam is enabled for a given chat.
 */
async function isEnabled(chatId: string): Promise<boolean> {
  return isGroupCommandEnabled(chatId, "antispam");
}

/**
 * Handle incoming messages for spam detection.
 */
async function handleAntiSpam(message: RawMessage): Promise<void> {
  // Only track text messages
  if (message.contentType !== 0) return;
  if (!(await isEnabled(message.chatId))) return;

  // Admin/Owner messages are exempt
  if (await hasPermission(message.senderId, PermissionRole.ADMIN)) return;

  const spamResult = trackMessage(message.chatId, message.senderId);
  if (!spamResult) return;

  const lineClient = getClient();

  // Try to unsend the spam message
  try {
    await lineClient.base.talk.unsendMessage({
      messageId: message.id,
    });
  } catch {
    // May not have permission to unsend
  }

  // Warn the user (with cooldown)
  if (warnCooldown.tryAcquire(message.chatId)) {
    try {
      if (spamResult.violations >= 3) {
        // Auto-kick after 3+ violations
        await sendBotMessage(
          message.chatId,
          `🚫 ตรวจพบสแปม — สมาชิกถูกลบออกจากกลุ่ม (${spamResult.violations} ครั้ง)`,
        );

        try {
          await kickFromGroup(message.chatId, [message.senderId]);
          logger.info("Anti-spam: kicked spammer", {
            chatId: message.chatId,
            userId: message.senderId,
            violations: spamResult.violations,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.debug("Anti-spam: could not kick (may not have permission)", {
            error: msg,
          });
        }
      } else {
        await sendBotMessage(message.chatId, `⚠️ หยุดสแปม! (เตือนครั้งที่ ${spamResult.violations}/3)`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Anti-spam: failed to send warning", { error: msg });
    }
  }

  logger.info("Anti-spam triggered", {
    chatId: message.chatId,
    senderId: message.senderId,
    violations: spamResult.violations,
  });
}

/**
 * Create the Anti-Spam feature.
 */
export function createAntiSpamFeature(): Feature {
  // Register raw message listener
  onRawMessage(handleAntiSpam);

  return {
    name: "anti-spam",
    commands: ["antispam"],
    description: "🚫 ป้องกันสแปม — !antispam on/off/status",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      const action = cmd.args[0]?.toLowerCase();

      switch (action) {
        case "on":
        case "off": {
          await setGroupCommandEnabled(cmd.chatId, "antispam", action === "on", cmd.senderId);
          const emoji = action === "on" ? "✅" : "⛔";
          await sendBotMessage(cmd.chatId, `${emoji} Anti-Spam ${action === "on" ? "เปิด" : "ปิด"}แล้ว`);
          break;
        }

        default: {
          const enabled = await isEnabled(cmd.chatId);
          await sendBotMessage(
            cmd.chatId,
            [
              `🚫 Anti-Spam: ${enabled ? "✅ เปิด" : "⛔ ปิด"}`,
              "",
              "คำสั่ง:",
              "• !antispam on — เปิดป้องกันสแปม",
              "• !antispam off — ปิดป้องกันสแปม",
              "",
              `💡 เกณฑ์: >${DEFAULT_MAX_MESSAGES} ข้อความ/${DEFAULT_WINDOW_MS / 1000}วินาที`,
              "💡 เตือน 3 ครั้ง → เตะออกจากกลุ่มอัตโนมัติ",
              "💡 Admin/Owner ได้รับการยกเว้น",
            ].join("\n"),
          );
        }
      }
    },
  };
}
