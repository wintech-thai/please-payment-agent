/**
 * rlbotline Worker — Multi-Bot Sync (บอทอัพพวง)
 *
 * Implements real-time command synchronization across multiple bots
 * owned by the same user, connected via the Central API WebSocket Hub.
 */

import { logger } from "../core/logger.js";
import { getClient, kickFromGroup, sendBotMessage } from "../core/line-client.js";
import { hasPermission } from "../core/database.js";
import { syncClient, type SyncEvent } from "../core/sync-client.js";
import { runInCommandContext } from "../core/command-context.js";
import { PermissionRole, type Feature, type BotCommand } from "../types.js";

/**
 * Handle incoming sync events from the WebSocket Hub.
 * This runs when *another* bot sends a sync command.
 */
async function handleIncomingSyncEvent(event: SyncEvent): Promise<void> {
  const lineClient = getClient();
  const { command, data } = event;
  const { chatId } = data;

  if (!chatId) return;

  try {
    if (command === "chat") {
      const text = data.text as string;
      if (text) {
        // A relayed `!sync chat` is NOT ambient like a welcome/goodbye or
        // anti-kick notice (those are reactions to LINE-side events this bot
        // observed directly and never had a "muted" origin to inherit). It's
        // this bot's own delivery of a chat-triggered command's output into
        // this chat — so it's wrapped in the same command context a locally
        // typed `!sync chat` would get (source: "chat"), and re-checks THIS
        // bot's own `cmdoutput` toggle for `chatId` before posting. Each bot
        // in the fleet has independent per-chat toggle state (see
        // `isGroupCommandEnabled`), so this correctly respects "the bot is
        // silent in chat" per-bot rather than either ignoring the toggle
        // entirely or inheriting the sender bot's mute state.
        await runInCommandContext(
          { chatId, command: "sync", source: "chat" },
          () => sendBotMessage(chatId, text),
        );
        logger.info(`Executed synced chat in ${chatId}`, { context: "SyncFeature" });
      }
    } else if (command === "kick") {
      const targetId = data.targetId as string;
      if (targetId) {
        // Via kickFromGroup, not a local cast: it carries the fleet guard, so a
        // relayed `!sync kick` naming one of our own bots is refused on every
        // peer. This is the one place where a fleet-wide kick fans out, so a
        // bypass here would defeat the guard exactly where it matters most.
        await kickFromGroup(chatId, [targetId]);
        logger.info(`Executed synced kick for ${targetId} in ${chatId}`, { context: "SyncFeature" });
      }
    } else if (command === "join") {
        const ticketId = data.ticketId as string;
        if (ticketId) {
            await (lineClient.base.talk as unknown as Record<string, Function>)["acceptChatInvitationByTicket"]({
                reqSeq: 0,
                chatMid: chatId,
                ticketId,
            });
            logger.info(`Executed synced join in ${chatId}`, { context: "SyncFeature" });
        }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Ignore errors like "Not in group" or "Not authorized" since some bots in the sync group
    // might not be in this specific chat.
    logger.debug(`Failed to execute synced ${command}: ${msg}`, { context: "SyncFeature" });
  }
}

/**
 * Create the Sync feature handler.
 */
export function createSyncFeature(): Feature {
  // Register the event listener once
  syncClient.onEvent(handleIncomingSyncEvent);

  return {
    name: "sync",
    commands: ["sync", "อัพพวง"],
    description: "🔗 สั่งงานบอทพวง — !sync [chat|kick|join] [ข้อความ/แท็ก]",

    async handleCommand(cmd: BotCommand): Promise<void> {
      // Permission check: admin or owner required
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ (ต้องเป็น Admin ขึ้นไป)");
        return;
      }

      if (cmd.args.length === 0) {
        await sendBotMessage(cmd.chatId, "⚠️ กรุณาระบุคำสั่ง เช่น: !sync chat สวัสดี, !sync kick @แท็ก");
        return;
      }

      const action = cmd.args[0].toLowerCase();
      const payload = cmd.args.slice(1).join(" ");
      const lineClient = getClient();

      if (action === "chat") {
        if (!payload) return;

        // Execute locally first. Only broadcast to peer bots if the local
        // send actually went out — if `cmdoutput` suppressed it (chat-sourced
        // commands only; see sendBotMessage), peers must stay silent too, or
        // "the bot is silent in chat" stops being true fleet-wide: an
        // operator muting bot A would otherwise still see the text posted by
        // bots B/C/D via the sync broadcast.
        const sent = await sendBotMessage(cmd.chatId, payload);
        if (!sent) {
          logger.debug("Sync chat suppressed locally by cmdoutput — not broadcasting to peers", {
            context: "SyncFeature",
            chatId: cmd.chatId,
          });
          return;
        }

        // Broadcast to hub
        syncClient.send("chat", { chatId: cmd.chatId, text: payload });

      } else if (action === "kick") {
        const mentionedMids = cmd.mentionedMids || [];
        if (mentionedMids.length === 0) {
          await sendBotMessage(cmd.chatId, "⚠️ กรุณาแท็กเป้าหมายที่ต้องการเตะ");
          return;
        }

        const targetId = mentionedMids[0];
        
        // Execute locally first
        try {
          await kickFromGroup(cmd.chatId, [targetId]);
        } catch (error) {
          logger.debug(`Local kick failed: ${String(error)}`, { context: "SyncFeature" });
        }

        // Broadcast to hub
        syncClient.send("kick", { chatId: cmd.chatId, targetId });
      } else if (action === "join") {
        // Extract ticket URL if passed, e.g. !sync join https://line.me/R/ti/g/abcdef
        let ticketId = "";
        if (payload.includes("/ti/g/")) {
            ticketId = payload.split("/ti/g/")[1];
        } else {
            ticketId = payload; // Direct ticket ID
        }

        if (!ticketId) {
             await sendBotMessage(cmd.chatId, "⚠️ กรุณาระบุ Link หรือ Ticket ID สำหรับเข้าร่วมกลุ่ม");
            return;
        }

        // Execute locally
        try {
            await (lineClient.base.talk as unknown as Record<string, Function>)["acceptChatInvitationByTicket"]({
                reqSeq: 0,
                chatMid: cmd.chatId,
                ticketId,
            });
        } catch (error) {
             logger.debug(`Local join failed: ${String(error)}`, { context: "SyncFeature" });
        }

        // Broadcast
        syncClient.send("join", { chatId: cmd.chatId, ticketId });
      } else {
        await sendBotMessage(cmd.chatId, `⚠️ ไม่รู้จักคำสั่งย่อย "${action}" (รองรับ: chat, kick, join)`);
      }
    },
  };
}
