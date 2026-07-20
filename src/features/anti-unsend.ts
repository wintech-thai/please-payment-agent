/**
 * rlbotline Worker — Anti-Unsend Feature
 *
 * Caches all incoming text messages in PostgreSQL.
 * When a message is unsent (NOTIFIED_DESTROY_MESSAGE), looks up the
 * cached original and re-posts it to the chat.
 */

import { logger } from "../core/logger.js";
import { cacheMessage, getCachedMessage } from "../core/database.js";
import {
  onRawMessage,
  onOperation,
  type RawMessage,
  type RawOperation,
} from "../core/event-router.js";
import { resolveDisplayName, sendBotMessage } from "../core/line-client.js";
import { ChatCooldown } from "../core/rate-limiter.js";
import { LineOpType, type Feature, type BotCommand } from "../types.js";

/** Cooldown: max 1 unsend report per 3 seconds per chat */
const unsendCooldown = new ChatCooldown(3000);

/** Periodically clean up cooldown map */
setInterval(() => unsendCooldown.cleanup(), 5 * 60 * 1000);

/**
 * Map numeric LINE content types to human-readable labels.
 */
const CONTENT_TYPE_LABELS: Record<number, string> = {
  0: "text",
  1: "image",
  2: "video",
  3: "audio",
  6: "file",
  7: "location",
  13: "sticker",
  14: "contact",
  15: "flex",
  16: "call",
};

function contentTypeLabel(contentType: number | string): string {
  if (typeof contentType === "string") {
    if (contentType === "NONE") return "text";
    if (contentType === "FLEX") return "flex";
    return contentType.toLowerCase();
  }
  return CONTENT_TYPE_LABELS[contentType] ?? `unknown(${contentType})`;
}

/**
 * Extract metadata from a message based on its content type.
 */
function extractMetadata(message: RawMessage): string {
  try {
    const raw = message.raw?.raw;
    const contentMetadata = (raw as { contentMetadata?: Record<string, string> })?.contentMetadata ?? {};

    const meta: Record<string, string> = {};

    // Sticker info
    if (contentMetadata["STKID"]) meta["stickerId"] = contentMetadata["STKID"];
    if (contentMetadata["STKPKGID"]) meta["stickerPackId"] = contentMetadata["STKPKGID"];
    if (contentMetadata["STKVRSN"]) meta["stickerVersion"] = contentMetadata["STKVRSN"];

    // File info
    if (contentMetadata["FILE_NAME"]) meta["fileName"] = contentMetadata["FILE_NAME"];
    if (contentMetadata["FILE_SIZE"]) meta["fileSize"] = contentMetadata["FILE_SIZE"];

    // General
    if (contentMetadata["DOWNLOAD_URL"]) meta["downloadUrl"] = contentMetadata["DOWNLOAD_URL"];

    return JSON.stringify(meta);
  } catch {
    return "{}";
  }
}

/**
 * Cache every incoming message into PostgreSQL for later anti-unsend lookup.
 * Phase 2: Caches ALL content types, not just text.
 */
async function handleIncomingMessage(message: RawMessage): Promise<void> {
  const typeLabel = contentTypeLabel(message.contentType);

  await cacheMessage({
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    senderName: "",
    contentType: typeLabel,
    textContent: message.text ?? "",
    metadata: extractMetadata(message),
    createdAt: Date.now(),
  });
}

/**
 * Handle NOTIFIED_DESTROY_MESSAGE operations.
 * Look up the original cached message and re-post it.
 */
async function handleUnsendOperation(op: RawOperation): Promise<void> {
  // NOTIFIED_DESTROY_MESSAGE is still an unverified numeric placeholder (no
  // live capture yet, see types.ts) — String() compare avoids a TS type-overlap
  // error now that RawOperation.type is a string; this never matches until
  // the real op-type string is confirmed and the enum is updated to match.
  if (String(op.type) !== String(LineOpType.NOTIFIED_DESTROY_MESSAGE)) {
    return;
  }

  // param1 = chatId (group MID), param2 = messageId or JSON with messageId
  const chatId = op.param1;
  let messageId = op.param2;

  // Some versions of the protocol wrap messageId in JSON
  try {
    const parsed = JSON.parse(messageId);
    if (parsed.messageId) {
      messageId = String(parsed.messageId);
    }
  } catch {
    // param2 is already the messageId string
  }

  if (!chatId || !messageId) {
    logger.debug("Unsend operation missing chatId or messageId", {
      param1: op.param1,
      param2: op.param2,
    });
    return;
  }

  // Per-chat cooldown to avoid spam
  if (!unsendCooldown.tryAcquire(chatId)) {
    logger.debug("Anti-unsend cooldown active, skipping", { chatId });
    return;
  }

  // Look up the original message
  const original = await getCachedMessage(messageId);
  if (!original) {
    logger.debug("No cached message found for unsend", { messageId });
    return;
  }

  // Build the re-post text based on content type
  const senderLabel = original.senderName || (await resolveDisplayName(original.senderId));

  const lines: string[] = [
    "🔓 ข้อความที่ถูกยกเลิก",
    `👤 ${senderLabel}`,
  ];

  switch (original.contentType) {
    case "text":
      lines.push(`💬 ${original.textContent}`);
      break;
    case "sticker": {
      let stickerInfo = "📌 Sticker";
      try {
        const meta = JSON.parse(original.metadata || "{}");
        if (meta.stickerId && meta.stickerPackId) {
          stickerInfo = `📌 Sticker (ID: ${meta.stickerId}, Pack: ${meta.stickerPackId})`;
        }
      } catch {
        // ignore
      }
      lines.push(stickerInfo);
      break;
    }
    case "image":
      lines.push("🖼️ รูปภาพ");
      break;
    case "video":
      lines.push("🎬 วิดีโอ");
      break;
    case "audio":
      lines.push("🔊 เสียง");
      break;
    case "file": {
      let fileInfo = "📎 ไฟล์";
      try {
        const meta = JSON.parse(original.metadata || "{}");
        if (meta.fileName) {
          fileInfo = `📎 ไฟล์: ${meta.fileName}`;
        }
      } catch {
        // ignore
      }
      lines.push(fileInfo);
      break;
    }
    case "location":
      lines.push("📍 ตำแหน่ง");
      if (original.textContent) {
        lines.push(`   ${original.textContent}`);
      }
      break;
    case "contact":
      lines.push("👤 ข้อมูลติดต่อ");
      break;
    case "flex":
      lines.push("📋 Flex Message");
      break;
    default:
      lines.push(`📦 ประเภท: ${original.contentType}`);
      if (original.textContent) {
        lines.push(`💬 ${original.textContent}`);
      }
  }

  const repostText = lines.join("\n");

  try {
    await sendBotMessage(chatId, repostText);

    logger.info("Anti-unsend: re-posted unsent message", {
      chatId,
      messageId,
      contentType: original.contentType,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Anti-unsend: failed to re-post", { error: msg, chatId });
  }
}

/**
 * Register the anti-unsend feature.
 */
/**
 * Anti-unsend depends on the `NOTIFIED_DESTROY_MESSAGE` op-type, which is still
 * an unverified numeric placeholder (op 72) — `handleUnsendOperation` never
 * matches real traffic, so detection cannot work yet. Marked unavailable so it's
 * refused/labelled instead of silently caching every message for nothing. Flip
 * to `true` once the real op-type string is captured (RAW_OP_LOG) and the enum
 * updated — see .research/line-op-type-verification.md.
 */
const ANTI_UNSEND_AVAILABLE = false;

export function createAntiUnsendFeature(): Feature {
  // Only wire the message cache + unsend detector once the op-type is confirmed;
  // until then caching every message just burns DB writes with no payoff.
  if (ANTI_UNSEND_AVAILABLE) {
    onRawMessage(handleIncomingMessage);
    onOperation(handleUnsendOperation);
  }

  return {
    name: "anti-unsend",
    commands: ["antiunsend"],
    available: ANTI_UNSEND_AVAILABLE,
    description:
      "🔓 จับข้อความที่ถูกยกเลิก — ทำงานอัตโนมัติ (ใช้คำสั่ง !antiunsend เพื่อดูสถานะ)",

    async handleCommand(cmd: BotCommand): Promise<void> {
      try {
        await sendBotMessage(
          cmd.chatId,
          "🔓 ระบบจับข้อความยกเลิกทำงานอยู่ ✅\nข้อความที่ถูกยกเลิกจะถูกแสดงอัตโนมัติ",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("Anti-unsend status command failed", { error: msg });
      }
    },
  };
}
