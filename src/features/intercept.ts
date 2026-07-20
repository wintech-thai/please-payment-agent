/**
 * rlbotline Worker — Intercept feature
 *
 * Hooks into the event router's raw-message stream and forwards every message
 * originating from a watched chat to:
 *   1. The chat's own `forward_url` (if set)
 *   2. The Central API webhook (always)
 *
 * Commands (start with the bot prefix) are NEVER forwarded.
 */

import { onRawMessage, type RawMessage } from "../core/event-router.js";
import { getWatched, isLoaded, getCompiledRegex } from "../core/chat-registry.js";
import { getWebhookTargets } from "../core/database.js";
import { fanOut, type ForwardedMessage } from "../core/forwarder.js";
import { logger } from "../core/logger.js";
import type { Feature, OutboundWebhookTarget, WorkerConfig } from "../types.js";

const CONTENT_TYPE_LABELS: Record<number, string> = {
  0: "TEXT",
  1: "IMAGE",
  2: "VIDEO",
  3: "AUDIO",
  4: "HTML",
  5: "PDF",
  6: "CALL",
  7: "STICKER",
  8: "PRESENCE",
  9: "GIFT",
  10: "GROUPBOARD",
  11: "APPLINK",
  12: "LINK",
  13: "CONTACT",
  14: "FILE",
  15: "LOCATION",
};

function contentTypeLabel(t: number | string | undefined): string {
  if (typeof t === "string" && t.length > 0) {
    return t === "NONE" ? "TEXT" : t;
  }
  if (typeof t === "number") {
    return CONTENT_TYPE_LABELS[t] ?? `TYPE_${t}`;
  }
  return "UNKNOWN";
}

/**
 * Strip fields from the raw LINE wire `Message` struct that must never leave
 * the worker: `contentMetadata.DOWNLOAD_URL`/`PREVIEW_URL` are self-authenticating
 * (fetchable with no LINE session — see linejs `base.fetch()`), and `chunks`
 * carries raw E2EE media bytes with no size cap. Shallow copy only.
 */
export function redactRaw(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const copy = { ...(raw as Record<string, unknown>) };
  delete copy["chunks"];
  const metadata = copy["contentMetadata"];
  if (typeof metadata === "object" && metadata !== null) {
    const metaCopy = { ...(metadata as Record<string, unknown>) };
    delete metaCopy["DOWNLOAD_URL"];
    delete metaCopy["PREVIEW_URL"];
    copy["contentMetadata"] = metaCopy;
  }
  return copy;
}

export function createInterceptFeature(config: WorkerConfig): Feature {
  // Attach the raw-message listener immediately — there is no global init()
  // hook in the event router, so registration happens here.
  onRawMessage(async (msg: RawMessage) => {
    if (!isLoaded()) return;

    // For direct chats (user/OA), forward only what the remote side sent.
    if (msg.chatId.startsWith("u") && msg.isOwnMessage) return;

    // Skip bot commands — never forward them
    if (msg.text.startsWith(config.commandPrefix)) return;

    const watched = getWatched(msg.chatId);
    if (!watched || !watched.enabled) return;

    // Apply message filter (only when text is non-empty; media/stickers bypass)
    if (watched.filterType && watched.filterType !== "none" && msg.text) {
      let passes = false;
      if (watched.filterType === "substring") {
        passes = msg.text.toLowerCase().includes(watched.filterPattern.toLowerCase());
      } else if (watched.filterType === "regex") {
        const re = getCompiledRegex(msg.chatId);
        if (re) {
          try {
            passes = re.test(msg.text);
          } catch {
            passes = true; // fail-open on regex runtime error
          }
        } else {
          passes = true; // invalid/null regex → fail-open
        }
      }
      if (!passes) return;
    }

    const payload: ForwardedMessage = {
      messageId: msg.id,
      chatId: msg.chatId,
      chatName: watched.chatName,
      chatType: watched.chatType,
      senderId: msg.senderId,
      contentType: contentTypeLabel(msg.contentType),
      text: msg.text,
      receivedAt: Date.now(),
      instanceId: config.instanceId,
      raw: redactRaw(msg.raw.raw),
    };

    const targets: Array<string | OutboundWebhookTarget> = [];
    if (watched.forwardUrl) targets.push(watched.forwardUrl);
    targets.push(...await getWebhookTargets());
    if (config.webhookUrl) targets.push(config.webhookUrl);

    try {
      await fanOut(targets, payload);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Intercept forward failed", {
        chatId: msg.chatId,
        messageId: msg.id,
        error: errMsg,
      });
    }
  });

  logger.info("Intercept feature ready");

  return {
    name: "intercept",
    commands: [],
    description: "🛰️ Forward ข้อความจาก watched chats (silent)",
    handleCommand: async () => {
      // No commands — pure listener
    },
  };
}
