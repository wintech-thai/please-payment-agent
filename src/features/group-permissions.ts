/**
 * rlbotline Worker — Group Permissions Feature
 *
 * In-chat escape hatch for the per-group command enable/disable + authorized-uid
 * allowlist system enforced in `core/event-router.ts`'s `executeRegisteredCommand()`.
 *
 * All commands here are admin-role-gated (bot-wide `hasPermission(..., ADMIN)`),
 * and are exempt from the per-group toggle/allowlist checks themselves (see
 * `CHAT_COMMAND_ALLOWLIST` in event-router.ts) so a group can never lock itself
 * out of its own unlock commands.
 */

import { logger } from "../core/logger.js";
import { resolveDisplayName, sendBotMessage } from "../core/line-client.js";
import {
  setGroupCommandEnabled,
  addGroupAuthorizedUser,
  removeGroupAuthorizedUser,
  getGroupAuthorizedUsers,
  getGroupCommandToggles,
  hasPermission,
} from "../core/database.js";
import { PermissionRole, type Feature, type BotCommand } from "../types.js";

/** Display names for the `cmdoutput`/`admincmd` sub-toggles, used in replies. */
const REPLY_TOGGLE_LABEL: Record<string, string> = {
  cmdoutput: "Command Output (การตอบกลับคำสั่งในแชท)",
  admincmd: "Admin Chat Command Bypass",
};

/**
 * `cmdoutput`/`admincmd` cannot be targeted by `!groupcmd <command> on|off` —
 * they're toggled only via their own dedicated commands (`!cmdoutput on/off`,
 * `!admincmd on/off`) or the dashboard, never generically through `groupcmd`.
 *
 * `admincmd` is the genuine one-way door from chat: it self-blocks because
 * `event-router.ts`'s admin bypass (`isBotAdmin && adminChatCommandsEnabled`,
 * see `:406`) shares its key with the same toggle row `!admincmd` writes —
 * once off, a bot-wide admin can no longer reach ANY non-allowlisted chat
 * command, `admincmd` included, so re-enabling it from chat is structurally
 * impossible regardless of this denylist. `source: "ui"` is the only
 * recovery path (see docs/api-spec.md §3a).
 *
 * `cmdoutput` is NOT a one-way door — `!cmdoutput on` still works fine for
 * any admin with `admincmd` on (its own toggle doesn't gate `!cmdoutput`
 * itself, only the *reply* it and other commands would emit) — it's simply
 * excluded from `groupcmd`'s generic dispatch so the two toggles have a
 * single, unambiguous command surface each instead of two ways to set the
 * same thing (`!groupcmd cmdoutput on` and `!cmdoutput on`) that could drift.
 *
 * `groupcmd` is exempt from the normal per-group gate (see
 * `CHAT_COMMAND_ALLOWLIST` in event-router.ts) and only internally checks
 * `hasPermission(ADMIN)`, so without this denylist a locked-out admin could
 * type `!groupcmd admincmd on` and restore their own chat bypass via a
 * per-chat row (which outranks the `'*'` default row) — bypassing the
 * dedicated `!admincmd` command's own semantics (and, before this fix, the
 * fact that `admincmd` is meant to be reachable only via `source: "ui"` once
 * off).
 *
 * Deliberately a standalone literal, NOT derived from `REPLY_TOGGLE_LABEL`'s
 * keys — that object answers a different question ("does this command have a
 * display label for its ack message?"), and `setReplyToggle` already falls
 * back to the raw command name when a label is missing (`REPLY_TOGGLE_LABEL[
 * command] ?? command`, see below). Deriving the denylist from it would mean
 * a future dashboard-only toggle added without a label entry silently
 * reopens this hole. This list is the single source of truth for "which
 * commands `groupcmd` refuses to target" — nothing else may add to it
 * implicitly.
 */
const DASHBOARD_ONLY_COMMANDS = new Set(["cmdoutput", "admincmd"]);

/**
 * Apply an on/off toggle for `cmdoutput` or `admincmd` — modeled on
 * `anti-kick.ts`'s `setSubToggle`. Both toggles default ON (seeded/backfilled
 * server-side, see docs/api-spec.md §3a) and are read via the same
 * `isGroupCommandEnabled` fallback chain as every other command.
 *
 * Note: `!cmdoutput off`'s own ack is intentionally NOT exempt from the gate
 * it just set — because this reply is itself sent from inside
 * `feature.handleCommand()`, `sendBotMessage` re-checks the (now-off)
 * `cmdoutput` toggle and suppresses it. Silence IS the confirmation.
 * `!cmdoutput on` acks normally because the gate is open by the time the ack
 * sends.
 */
async function setReplyToggle(cmd: BotCommand, command: string, action?: string): Promise<void> {
  const label = REPLY_TOGGLE_LABEL[command] ?? command;

  if (action !== "on" && action !== "off") {
    await sendBotMessage(cmd.chatId, `❌ กรุณาระบุ on หรือ off\n\nวิธีใช้: !${command} on/off`);
    return;
  }

  await setGroupCommandEnabled(cmd.chatId, command, action === "on", cmd.senderId);
  await sendBotMessage(
    cmd.chatId,
    `${action === "on" ? "✅" : "⛔"} ${label} ${action === "on" ? "เปิด" : "ปิด"}แล้ว`,
  );

  logger.info("Reply toggle updated", {
    chatId: cmd.chatId,
    command,
    enabled: action === "on",
    by: cmd.senderId,
  });
}

/**
 * Extract target UID from command args or mentions.
 */
function extractTargetUid(cmd: BotCommand): string | null {
  if (cmd.mentionedMids.length > 0) {
    return cmd.mentionedMids[0];
  }

  if (cmd.args[0] && cmd.args[0].startsWith("u")) {
    return cmd.args[0];
  }

  return null;
}

/**
 * Create the Group Permissions feature.
 */
export function createGroupPermissionsFeature(): Feature {
  return {
    name: "group-permissions",
    // `cmdoutput` and `admincmd` are registered here too — not because they're
    // sub-toggles of group-permissions functionally, but because this is
    // where the group-permissions escape-hatch commands already live, and the
    // worker's command catalog (`list_commands`) is what the dashboard's
    // per-group toggle grid is built from — registering them here is what
    // makes them switchable from the UI as well as in-chat.
    commands: ["groupcmd", "authorize", "unauthorize", "listauthorized", "cmdoutput", "admincmd"],
    description:
      "🔐 จัดการสิทธิ์รายกลุ่ม — !groupcmd <คำสั่ง> on|off, !authorize, !unauthorize, !listauthorized, !cmdoutput on|off, !admincmd on|off",

    async handleCommand(cmd: BotCommand): Promise<void> {
      const sendReply = async (text: string): Promise<void> => {
        await sendBotMessage(cmd.chatId, text);
      };

      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendReply("❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      if (cmd.name === "cmdoutput" || cmd.name === "admincmd") {
        await setReplyToggle(cmd, cmd.name, cmd.args[0]?.toLowerCase());
        return;
      }

      switch (cmd.name) {
        // ── Toggle command enable/disable for this group ──
        case "groupcmd": {
          const targetCommand = cmd.args[0]?.trim().toLowerCase();
          const state = cmd.args[1]?.toLowerCase();

          if (!targetCommand || (state !== "on" && state !== "off")) {
            await sendReply("❌ รูปแบบไม่ถูกต้อง — !groupcmd <คำสั่ง> on|off");
            return;
          }

          if (DASHBOARD_ONLY_COMMANDS.has(targetCommand)) {
            await sendReply(
              `❌ ไม่สามารถตั้งค่า "${targetCommand}" ผ่าน !groupcmd ได้ — ใช้ !${targetCommand} on/off โดยตรง หรือตั้งค่าจากแดชบอร์ด`,
            );
            logger.warn("groupcmd rejected: target has its own dedicated command", {
              chatId: cmd.chatId,
              targetCommand,
              by: cmd.senderId,
            });
            return;
          }

          await setGroupCommandEnabled(
            cmd.chatId,
            targetCommand,
            state === "on",
            cmd.senderId,
          );
          await sendReply(
            `✅ ${state === "on" ? "เปิด" : "ปิด"}ใช้งานคำสั่ง "${targetCommand}" ในกลุ่มนี้แล้ว`,
          );

          logger.info("Group command toggle updated", {
            chatId: cmd.chatId,
            command: targetCommand,
            enabled: state === "on",
            by: cmd.senderId,
          });
          break;
        }

        // ── Authorize a user in this group ──
        case "authorize": {
          const targetUid = extractTargetUid(cmd);
          if (!targetUid) {
            await sendReply(
              "❌ กรุณาระบุผู้ใช้ — !authorize @ผู้ใช้ หรือ !authorize <MID>",
            );
            return;
          }

          // Resolve once and reuse for both the stored name and the reply —
          // `resolveDisplayName` costs a rate-limited getContacts call.
          const targetName = await resolveDisplayName(targetUid);
          await addGroupAuthorizedUser(cmd.chatId, targetUid, cmd.senderId, targetName);
          await sendReply(`✅ อนุญาตให้ ${targetName} ใช้คำสั่งบอทในกลุ่มนี้แล้ว`);

          logger.info("Group authorized user added", {
            chatId: cmd.chatId,
            target: targetUid,
            by: cmd.senderId,
          });
          break;
        }

        // ── Unauthorize a user in this group ──
        case "unauthorize": {
          const targetUid = extractTargetUid(cmd);
          if (!targetUid) {
            await sendReply(
              "❌ กรุณาระบุผู้ใช้ — !unauthorize @ผู้ใช้ หรือ !unauthorize <MID>",
            );
            return;
          }

          const removed = await removeGroupAuthorizedUser(cmd.chatId, targetUid);
          if (removed) {
            await sendReply(`✅ ยกเลิกสิทธิ์ ${await resolveDisplayName(targetUid)} ในกลุ่มนี้แล้ว`);
            logger.info("Group authorized user removed", {
              chatId: cmd.chatId,
              target: targetUid,
              by: cmd.senderId,
            });
          } else {
            await sendReply("❌ ไม่พบผู้ใช้นี้ในรายชื่อที่ได้รับอนุญาต");
          }
          break;
        }

        // ── List authorized users + command toggles for this group ──
        case "listauthorized": {
          const [users, toggles] = await Promise.all([
            getGroupAuthorizedUsers(cmd.chatId),
            getGroupCommandToggles(cmd.chatId),
          ]);

          const userNames = await Promise.all(
            users.map((u) => (u.name ? Promise.resolve(u.name) : resolveDisplayName(u.uid))),
          );
          const userLines =
            users.length === 0
              ? "ไม่มีผู้ใช้ที่ได้รับอนุญาตเป็นพิเศษ"
              : userNames.map((name, i) => `${i + 1}. ${name}`).join("\n");

          const toggleLines =
            toggles.length === 0
              ? "ไม่มีคำสั่งที่ตั้งค่าไว้ (ทุกคำสั่งปิดอยู่โดยค่าเริ่มต้น)"
              : toggles
                  .map((t) => `- ${t.command}: ${t.enabled ? "✅ เปิด" : "🚫 ปิด"}`)
                  .join("\n");

          await sendReply(
            `📋 ผู้ใช้ที่ได้รับอนุญาตในกลุ่มนี้:\n${userLines}\n\n📋 สถานะคำสั่งในกลุ่มนี้:\n${toggleLines}`,
          );
          break;
        }

        default:
          break;
      }
    },
  };
}
