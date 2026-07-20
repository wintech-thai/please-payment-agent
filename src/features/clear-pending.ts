/**
 * rlbotline Worker — Clear Pending Invites Feature
 *
 * Bulk-rejects all outstanding group invitations.
 * Rate-limited with delays between each rejection to avoid bans.
 */

import { logger } from "../core/logger.js";
import { getClient, sendBotMessage } from "../core/line-client.js";
import { hasPermission } from "../core/database.js";
import { sleep, randomDelay } from "../core/rate-limiter.js";
import { PermissionRole, type Feature, type BotCommand } from "../types.js";

/** Delay between each invitation rejection (milliseconds) */
const REJECT_DELAY_MS = 1500;

/**
 * Create the Clear Pending Invites feature.
 */
export function createClearPendingFeature(): Feature {
  return {
    name: "clear-pending",
    commands: ["clearpending", "rejectall"],
    description:
      "🧹 ปฏิเสธคำเชิญกลุ่มทั้งหมด — !clearpending (Owner เท่านั้น)",

    async handleCommand(cmd: BotCommand): Promise<void> {
      // Permission check: owner only
      if (!(await hasPermission(cmd.senderId, PermissionRole.OWNER))) {
        await sendBotMessage(cmd.chatId, "❌ เฉพาะ Owner เท่านั้นที่สามารถใช้คำสั่งนี้");
        return;
      }

      const lineClient = getClient();

      await sendBotMessage(cmd.chatId, "🔄 กำลังค้นหาคำเชิญที่ค้างอยู่...");

      // Anti-ban: initial delay
      await randomDelay(500, 1000);

      try {
        // Fetch all chat MIDs to find pending invitations
        const allChatMids = await lineClient.base.talk.getAllChatMids();

        // getAllChatMids returns an object with invitedChatMids
        const invitedMids = (allChatMids as { invitedChatMids?: string[] })
          ?.invitedChatMids ?? [];

        if (invitedMids.length === 0) {
          await sendBotMessage(cmd.chatId, "✅ ไม่มีคำเชิญค้างอยู่");
          return;
        }

        let rejected = 0;
        let failed = 0;

        for (const chatMid of invitedMids) {
          try {
            // Reject the invitation using the thrift struct args
            await lineClient.base.talk.rejectChatInvitation({
              request: {
                reqSeq: 0,
                chatMid,
              },
            });
            rejected++;

            logger.debug("Rejected invitation", { chatMid });
          } catch (error) {
            const msg =
              error instanceof Error ? error.message : String(error);
            logger.warn("Failed to reject invitation", {
              chatMid,
              error: msg,
            });
            failed++;
          }

          // Rate limiting between rejections
          await sleep(REJECT_DELAY_MS);
        }

        const resultText = [
          `✅ ปฏิเสธคำเชิญทั้งหมด ${rejected} กลุ่มแล้ว`,
          failed > 0 ? `⚠️ ล้มเหลว ${failed} กลุ่ม` : "",
        ]
          .filter(Boolean)
          .join("\n");

        await sendBotMessage(cmd.chatId, resultText);

        logger.info("Clear pending completed", { rejected, failed });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("Clear pending failed", { error: msg });

        await sendBotMessage(cmd.chatId, `❌ เกิดข้อผิดพลาด: ${msg}`);
      }
    },
  };
}
