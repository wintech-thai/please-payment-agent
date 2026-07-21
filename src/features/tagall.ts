/**
 * rlbotline Worker — Tag All Feature
 *
 * Mentions all members of a group in a single (or chunked) message.
 * Rate-limited and chunked to avoid LINE's anti-spam detection.
 */

import { logger } from "../core/logger.js";
import { getClient, sendBotMessage } from "../core/line-client.js";
import { hasPermission } from "../core/database.js";
import { listGroupMembers } from "../core/chat-lister.js";
import { randomDelay, sleep } from "../core/rate-limiter.js";
import { PermissionRole, type Feature, type BotCommand } from "../types.js";

/** Max mentions per message to avoid ban detection */
const CHUNK_SIZE = 50;
/** Delay between chunks in milliseconds */
const INTER_CHUNK_DELAY_MS = 2000;

/**
 * Build LINE mention metadata for a list of member MIDs.
 * LINE expects a specific JSON structure in contentMetadata.MENTION
 */
function buildMentionMetadata(
  members: Array<{ mid: string; displayName: string }>,
  baseText: string,
): { text: string; mentionMetadata: string } {
  const mentionees: Array<{
    S: string;
    E: string;
    M: string;
  }> = [];

  let fullText = baseText ? baseText + "\n" : "";
  let offset = fullText.length;

  for (const member of members) {
    const mentionText = `@${member.displayName}`;
    mentionees.push({
      S: String(offset),
      E: String(offset + mentionText.length),
      M: member.mid,
    });
    fullText += mentionText + "\n";
    offset = fullText.length;
  }

  const mentionMetadata = JSON.stringify({ mentionees });
  return { text: fullText.trimEnd(), mentionMetadata };
}

/**
 * Create the Tag All feature handler.
 */
export function createTagAllFeature(): Feature {
  return {
    name: "tagall",
    commands: ["tagall", "tag"],
    description: "📢 แท็กสมาชิกทั้งหมดในกลุ่ม — !tagall [ข้อความ]",

    async handleCommand(cmd: BotCommand): Promise<void> {
      // Permission check: admin or owner required
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ (ต้องเป็น Admin ขึ้นไป)");
        return;
      }

      const lineClient = getClient();
      const customMessage = cmd.args.join(" ");

      // Anti-ban: random initial delay
      await randomDelay(500, 1500);

      // Fetch group/chat info to get member list
      let members: Array<{ mid: string; displayName: string }> = [];

      try {
        members = await listGroupMembers(lineClient, cmd.chatId);

        if (members.length === 0) {
          await sendBotMessage(cmd.chatId, "❌ ไม่พบสมาชิกในกลุ่ม หรือไม่สามารถดึงรายชื่อได้");
          return;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("TagAll: failed to fetch group members", {
          error: msg,
          chatId: cmd.chatId,
        });

        await sendBotMessage(cmd.chatId, "❌ ไม่สามารถดึงรายชื่อสมาชิกได้: " + msg);
        return;
      }

      // Chunk members and send
      const chunks: Array<Array<{ mid: string; displayName: string }>> = [];
      for (let i = 0; i < members.length; i += CHUNK_SIZE) {
        chunks.push(members.slice(i, i + CHUNK_SIZE));
      }

      logger.info("TagAll: sending mentions", {
        totalMembers: members.length,
        chunks: chunks.length,
        chatId: cmd.chatId,
      });

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const headerText =
          i === 0 && customMessage
            ? customMessage
            : `📢 Tag All (${i + 1}/${chunks.length})`;

        const { text, mentionMetadata } = buildMentionMetadata(
          chunk,
          headerText,
        );

        try {
          await sendBotMessage(cmd.chatId, text, {
            contentMetadata: { MENTION: mentionMetadata },
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error("TagAll: failed to send chunk", {
            error: msg,
            chunk: i + 1,
          });
        }

        // Delay between chunks
        if (i < chunks.length - 1) {
          await sleep(INTER_CHUNK_DELAY_MS);
        }
      }

      logger.info("TagAll: completed", {
        chatId: cmd.chatId,
        totalMentioned: members.length,
      });
    },
  };
}
