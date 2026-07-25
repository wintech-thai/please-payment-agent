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
import { isOnixEnabled, notifyLineMessage } from "../core/onix-client.js";
import { parseBankTx, shouldForwardOaMessage, type BankTx } from "../core/bank-tx.js";
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
  /**
   * Every reason a message is dropped, logged at debug. Without this the whole
   * "message arrived but nothing was forwarded" case is invisible even at
   * LOG_LEVEL=debug, which is exactly when someone is trying to diagnose it.
   */
  const drop = (reason: string, msg: RawMessage, extra?: Record<string, unknown>): void => {
    logger.debug("Intercept skip", {
      reason,
      chatId: msg.chatId,
      messageId: msg.id,
      contentType: contentTypeLabel(msg.contentType),
      ...extra,
    });
  };

  onRawMessage(async (msg: RawMessage) => {
    if (!isLoaded()) return drop("watched-registry not loaded", msg);

    // For direct chats (user/OA), forward only what the remote side sent.
    if (msg.chatId.startsWith("u") && msg.isOwnMessage) {
      return drop("own message in direct chat", msg);
    }

    // Skip bot commands — never forward them
    if (msg.text.startsWith(config.commandPrefix)) {
      return drop("bot command", msg);
    }

    const watched = getWatched(msg.chatId);
    if (!watched) {
      return drop("chat not watched — add it to WATCH_CHAT_IDS/BANK_OA_MIDS", msg);
    }
    if (!watched.enabled) {
      return drop("watched chat disabled", msg, { chatName: watched.chatName });
    }

    // Bank-OA gate (both sinks below). Filtering happens ONLY when FILTER_EVENT
    // is set: parsed transactions pass by eventType, known-bank non-tx messages
    // (promos, rich-menu texts) drop, and unknown-pattern OAs fail open so a
    // bank we haven't mapped yet still forwards every message. `bankTx` is
    // attached to the webhook payload whenever it parses, filter or not.
    let bankTx: BankTx | null = null;
    if (watched.chatType === "oa") {
      bankTx = parseBankTx(watched.chatName, msg.text, Date.now());
      if (!shouldForwardOaMessage(watched.chatName, bankTx, config.filterEvent)) {
        return drop("excluded by FILTER_EVENT", msg, {
          chatName: watched.chatName,
          eventType: bankTx?.eventType ?? "not-a-bank-tx",
          filterEvent: config.filterEvent.join(","),
        });
      }
    }

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
      if (!passes) {
        return drop("filter rejected", msg, {
          filterType: watched.filterType,
          filterPattern: watched.filterPattern,
        });
      }
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
      ...(bankTx ? { bankTx } : {}),
    };

    const targets: Array<string | OutboundWebhookTarget> = [];
    if (watched.forwardUrl) targets.push(watched.forwardUrl);
    targets.push(...await getWebhookTargets());
    if (config.webhookUrl) targets.push(config.webhookUrl);

    if (targets.length === 0) {
      // Watched + passed every check, but nowhere to send it — the single most
      // confusing standalone misconfiguration (WEBHOOK_URL unset).
      logger.warn("Intercept: no forward target configured (set WEBHOOK_URL)", {
        chatId: msg.chatId,
        messageId: msg.id,
      });
    }

    try {
      logger.debug("Intercept forwarding", {
        chatId: msg.chatId,
        chatName: watched.chatName,
        chatType: watched.chatType,
        messageId: msg.id,
        contentType: payload.contentType,
        targets: targets.length,
      });
      await fanOut(targets, payload);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Intercept forward failed", {
        chatId: msg.chatId,
        messageId: msg.id,
        error: errMsg,
      });
    }

    // onix (destination server): bank-OA notifications only. onix's
    // NotifyLineMessage carries `title` + `text`, so a message with no text
    // (media/sticker) has nothing to deliver — skip it, but log rather than
    // drop silently so an all-media OA is diagnosable.
    if (!isOnixEnabled()) {
      logger.debug("onix skip: not configured (ONIX_API_URL/AGENT_ID/API_KEY)", {
        chatId: msg.chatId,
        messageId: msg.id,
      });
    } else if (watched.chatType !== "oa") {
      logger.debug("onix skip: chat is not an OA — onix only takes chatType 'oa'", {
        chatId: msg.chatId,
        messageId: msg.id,
        chatType: watched.chatType,
      });
    }

    if (isOnixEnabled() && watched.chatType === "oa") {
      if (msg.text.trim().length === 0) {
        logger.debug("onix skip: watched OA message has no text", {
          chatId: msg.chatId,
          messageId: msg.id,
          contentType: payload.contentType,
        });
      } else {
        const result = await notifyLineMessage({ title: watched.chatName, text: msg.text });
        if (!result.ok && !result.skipped) {
          logger.warn("onix notify failed for watched OA", {
            chatId: msg.chatId,
            messageId: msg.id,
            status: result.status,
            error: result.error,
          });
        }
      }
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
