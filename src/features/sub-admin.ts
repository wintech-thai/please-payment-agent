/**
 * rlbotline Worker — Sub-Admin & Blacklist Feature
 *
 * Local permission management system:
 * - Owner: auto-set to the bot's own MID on first run
 * - Admin: can be added/removed by owner
 * - Blacklist: admin+ can block users from using the bot
 */

import { logger } from "../core/logger.js";
import { getBotMid, resolveDisplayName, sendBotMessage } from "../core/line-client.js";
import {
  setAdmin,
  removeAdmin,
  getAdmin,
  getAllAdmins,
  addToBlacklist,
  removeFromBlacklist,
  getAllBlacklisted,
  hasPermission,
} from "../core/database.js";
import { PermissionRole, type Feature, type BotCommand } from "../types.js";

/**
 * Bootstrap the owner role on first run.
 * Sets the bot's own MID as the owner in the admins table.
 */
export async function bootstrapOwner(): Promise<void> {
  try {
    const botMid = await getBotMid();
    if (!botMid) {
      logger.warn("Could not determine bot MID for owner bootstrap");
      return;
    }

    const existing = await getAdmin(botMid);
    if (!existing) {
      await setAdmin(botMid, PermissionRole.OWNER, "system");
      logger.info("Owner bootstrapped", { mid: botMid });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to bootstrap owner", { error: msg });
  }
}

/**
 * Extract target UID from command args or mentions.
 */
function extractTargetUid(cmd: BotCommand): string | null {
  // Check mentions first
  if (cmd.mentionedMids.length > 0) {
    return cmd.mentionedMids[0];
  }

  // Check if first arg looks like a MID (starts with 'u')
  if (cmd.args[0] && cmd.args[0].startsWith("u")) {
    return cmd.args[0];
  }

  return null;
}

/**
 * Create the Sub-Admin & Blacklist feature.
 */
export function createSubAdminFeature(): Feature {
  return {
    name: "sub-admin",
    commands: [
      "addadmin",
      "removeadmin",
      "listadmin",
      "blacklist",
      "unblacklist",
      "listblacklist",
    ],
    description:
      "👑 จัดการสิทธิ์ — !addadmin, !removeadmin, !listadmin, !blacklist, !unblacklist, !listblacklist",

    async handleCommand(cmd: BotCommand): Promise<void> {
      const sendReply = async (text: string): Promise<void> => {
        await sendBotMessage(cmd.chatId, text);
      };

      switch (cmd.name) {
        // ── Add Admin ──
        case "addadmin": {
          if (!(await hasPermission(cmd.senderId, PermissionRole.OWNER))) {
            await sendReply("❌ เฉพาะ Owner เท่านั้นที่สามารถเพิ่ม Admin");
            return;
          }

          const targetUid = extractTargetUid(cmd);
          if (!targetUid) {
            await sendReply(
              "❌ กรุณาระบุผู้ใช้ — !addadmin @ผู้ใช้ หรือ !addadmin <MID>",
            );
            return;
          }

          // Resolve once and reuse for both the stored name and the reply —
          // `resolveDisplayName` costs a rate-limited getContacts call.
          const targetName = await resolveDisplayName(targetUid);
          await setAdmin(targetUid, PermissionRole.ADMIN, cmd.senderId, targetName);
          await sendReply(`✅ เพิ่ม Admin สำเร็จ: ${targetName}`);

          logger.info("Admin added", {
            target: targetUid,
            by: cmd.senderId,
          });
          break;
        }

        // ── Remove Admin ──
        case "removeadmin": {
          if (!(await hasPermission(cmd.senderId, PermissionRole.OWNER))) {
            await sendReply("❌ เฉพาะ Owner เท่านั้นที่สามารถลบ Admin");
            return;
          }

          const targetUid = extractTargetUid(cmd);
          if (!targetUid) {
            await sendReply(
              "❌ กรุณาระบุผู้ใช้ — !removeadmin @ผู้ใช้ หรือ !removeadmin <MID>",
            );
            return;
          }

          const adminRecord = await getAdmin(targetUid);
          if (adminRecord?.role === PermissionRole.OWNER) {
            await sendReply("❌ ไม่สามารถลบ Owner ได้");
            return;
          }

          const removed = await removeAdmin(targetUid);
          if (removed) {
            await sendReply(`✅ ลบ Admin สำเร็จ: ${await resolveDisplayName(targetUid)}`);
            logger.info("Admin removed", {
              target: targetUid,
              by: cmd.senderId,
            });
          } else {
            await sendReply("❌ ไม่พบ Admin นี้ในระบบ");
          }
          break;
        }

        // ── List Admins ──
        case "listadmin": {
          const admins = await getAllAdmins();
          if (admins.length === 0) {
            await sendReply("📋 ไม่มี Admin ในระบบ");
            return;
          }

          const adminNames = await Promise.all(
            admins.map((a) => (a.name ? Promise.resolve(a.name) : resolveDisplayName(a.uid))),
          );
          const lines = admins.map((a, i) => {
            const roleEmoji =
              a.role === PermissionRole.OWNER ? "👑" : "⭐";
            return `${i + 1}. ${roleEmoji} ${adminNames[i]} (${a.role})`;
          });

          await sendReply(`📋 รายชื่อ Admin:\n${lines.join("\n")}`);
          break;
        }

        // ── Add to Blacklist ──
        case "blacklist": {
          if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
            await sendReply(
              "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้",
            );
            return;
          }

          const targetUid = extractTargetUid(cmd);
          if (!targetUid) {
            await sendReply(
              "❌ กรุณาระบุผู้ใช้ — !blacklist @ผู้ใช้ [เหตุผล]",
            );
            return;
          }

          // Check if target is an admin/owner (can't blacklist them)
          if (await hasPermission(targetUid, PermissionRole.ADMIN)) {
            await sendReply(
              "❌ ไม่สามารถ Blacklist Admin/Owner ได้",
            );
            return;
          }

          const reason =
            cmd.mentionedMids.length > 0
              ? cmd.args.slice(1).join(" ") || "ไม่ระบุเหตุผล"
              : cmd.args.slice(1).join(" ") || "ไม่ระบุเหตุผล";

          const targetName = await resolveDisplayName(targetUid);
          await addToBlacklist(targetUid, targetName, reason, cmd.senderId);
          await sendReply(`🚫 Blacklist สำเร็จ: ${targetName}\nเหตุผล: ${reason}`);

          logger.info("User blacklisted", {
            target: targetUid,
            reason,
            by: cmd.senderId,
          });
          break;
        }

        // ── Remove from Blacklist ──
        case "unblacklist": {
          if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
            await sendReply(
              "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้",
            );
            return;
          }

          const targetUid = extractTargetUid(cmd);
          if (!targetUid) {
            await sendReply(
              "❌ กรุณาระบุผู้ใช้ — !unblacklist @ผู้ใช้",
            );
            return;
          }

          const removed = await removeFromBlacklist(targetUid);
          if (removed) {
            await sendReply(`✅ ปลด Blacklist สำเร็จ: ${await resolveDisplayName(targetUid)}`);
            logger.info("User un-blacklisted", {
              target: targetUid,
              by: cmd.senderId,
            });
          } else {
            await sendReply("❌ ไม่พบผู้ใช้นี้ใน Blacklist");
          }
          break;
        }

        // ── List Blacklisted ──
        case "listblacklist": {
          if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
            await sendReply(
              "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้",
            );
            return;
          }

          const blacklisted = await getAllBlacklisted();
          if (blacklisted.length === 0) {
            await sendReply("📋 ไม่มีผู้ใช้ใน Blacklist");
            return;
          }

          const blacklistNames = await Promise.all(
            blacklisted.map((b) => (b.name ? Promise.resolve(b.name) : resolveDisplayName(b.uid))),
          );
          const lines = blacklisted.map(
            (b, i) => `${i + 1}. 🚫 ${blacklistNames[i]}\n   เหตุผล: ${b.reason}`,
          );

          await sendReply(
            `📋 Blacklist (${blacklisted.length}):\n${lines.join("\n")}`,
          );
          break;
        }

        default:
          break;
      }
    },
  };
}
