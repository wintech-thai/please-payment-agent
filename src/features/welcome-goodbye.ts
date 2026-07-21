/**
 * rlbotline Worker — Welcome / Goodbye Feature (Phase 2)
 *
 * Listens for group join/leave events and sends customizable
 * greeting/farewell messages. Toggleable per group.
 *
 * Phase 2: Custom templates with {name}, {group}, {count} variables.
 */

import { logger } from "../core/logger.js";
import { getClient, resolveDisplayName, sendBotMessage } from "../core/line-client.js";
import {
  getSetting,
  setSetting,
  hasPermission,
  isGroupCommandEnabled,
  setGroupCommandEnabled,
} from "../core/database.js";
import {
  onOperation,
  extractChatEventActorTarget,
  ShortTtlCache,
  type RawOperation,
} from "../core/event-router.js";
import { randomDelay } from "../core/rate-limiter.js";
import {
  LineOpType,
  PermissionRole,
  type Feature,
  type BotCommand,
} from "../types.js";

/**
 * Correlates a `DELETE_OTHER_FROM_CHAT` op (no kicker identity) with the
 * `C_MR` CHATEVENT announcement carrying the kicker's mid — same mechanism
 * as anti-kick.ts's cache, kept separate since each feature listens
 * independently (small enough not to warrant sharing the instance).
 */
const kickerCorrelationCache = new ShortTtlCache<string>(10_000);

/**
 * De-dup welcomes: a single join emits BOTH NOTIFIED_ACCEPT_CHAT_INVITATION
 * and NOTIFIED_JOIN_CHAT (confirmed via live capture), so welcome at most once
 * per joiner within a short window.
 */
const recentWelcomeCache = new ShortTtlCache<true>(15_000);

function cacheKickerFromChatEvent(op: RawOperation): void {
  const actorTarget = extractChatEventActorTarget(op);
  // Only "C_MR" (member removed) correlates to a kick for the goodbye line;
  // "C_MI" invite pairs are never read back, so caching them would just leak.
  if (!actorTarget || actorTarget.locKey !== "C_MR") return;
  kickerCorrelationCache.set(`${actorTarget.chatId}:${actorTarget.targetMid}`, actorTarget.actorMid);
}

/** Default welcome message template */
const DEFAULT_WELCOME = "🎉 ยินดีต้อนรับ {name} เข้ากลุ่ม!";
/** Default goodbye message template */
const DEFAULT_GOODBYE = "👋 {name} ออกจากกลุ่มแล้ว";

/**
 * Check if welcome/goodbye is enabled for a given chat.
 */
async function isEnabled(type: "welcome" | "goodbye", chatId: string): Promise<boolean> {
  return isGroupCommandEnabled(chatId, type);
}

/**
 * Get the template for a given chat, or the default.
 */
async function getTemplate(type: "welcome" | "goodbye", chatId: string): Promise<string> {
  const key = `${type}_template:${chatId}`;
  const custom = await getSetting(key);
  if (custom) return custom;
  return type === "welcome" ? DEFAULT_WELCOME : DEFAULT_GOODBYE;
}

/**
 * Render a template with variable substitution.
 */
export function renderTemplate(
  template: string,
  vars: { name: string; group: string; count: number },
): string {
  return template
    .replace(/\{name\}/g, vars.name)
    .replace(/\{group\}/g, vars.group)
    .replace(/\{count\}/g, String(vars.count));
}

/**
 * Get group name and member count.
 */
async function getGroupInfo(chatId: string): Promise<{
  groupName: string;
  memberCount: number;
}> {
  try {
    const lineClient = getClient();
    const chat = await lineClient.base.talk.getChat({
      chatMid: chatId,
      withMembers: true,
    });

    const groupName = chat?.chatName ?? "กลุ่ม";
    const memberMap = chat?.extra?.groupExtra?.memberMids;
    const memberCount = memberMap ? Object.keys(memberMap).length : 0;

    return { groupName, memberCount };
  } catch {
    return { groupName: "กลุ่ม", memberCount: 0 };
  }
}

/**
 * Handle join/leave operations from the event system.
 */
async function handleJoinLeaveOperation(op: RawOperation): Promise<void> {
  // Cache CHATEVENT actor/target pairs (C_MR/C_MI) on every op so the kicker
  // can be resolved for the goodbye message regardless of arrival order.
  cacheKickerFromChatEvent(op);

  // ── Join Events ──
  // param2 = the joiner for both of these ops. NOTE: NOTIFIED_INVITE_INTO_CHAT
  // is deliberately NOT here — for that op param2 is the *inviter*, not the
  // joiner (confirmed via live capture), so welcoming on it greets the wrong
  // person. The actual join is signaled by ACCEPT + JOIN.
  if (
    op.type === LineOpType.NOTIFIED_ACCEPT_CHAT_INVITATION ||
    op.type === LineOpType.NOTIFIED_JOIN_CHAT
  ) {
    const chatId = op.param1;
    const userMid = op.param2;

    if (!chatId || !userMid) return;
    if (!(await isEnabled("welcome", chatId))) return;

    // Skip if we already welcomed this joiner moments ago (ACCEPT + JOIN both fire).
    if (recentWelcomeCache.get(`${chatId}:${userMid}`)) return;
    recentWelcomeCache.set(`${chatId}:${userMid}`, true);

    await randomDelay(300, 800);

    const [displayName, groupInfo] = await Promise.all([
      resolveDisplayName(userMid),
      getGroupInfo(chatId),
    ]);

    const template = await getTemplate("welcome", chatId);
    const message = renderTemplate(template, {
      name: displayName,
      group: groupInfo.groupName,
      count: groupInfo.memberCount,
    });

    try {
      await sendBotMessage(chatId, message);

      logger.info("Welcome message sent", {
        chatId,
        userMid,
        displayName,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to send welcome message", {
        error: msg,
        chatId,
      });
    }
  }

  // ── Leave Events ──
  if (
    op.type === LineOpType.NOTIFIED_LEAVE_CHAT ||
    op.type === LineOpType.DELETE_OTHER_FROM_CHAT
  ) {
    const chatId = op.param1;
    const userMid = op.param2;
    // DELETE_OTHER_FROM_CHAT carries no kicker identity (no param3 for this
    // op) — best-effort resolve it from a correlated CHATEVENT announcement.
    const kickerMid =
      op.type === LineOpType.DELETE_OTHER_FROM_CHAT && userMid
        ? kickerCorrelationCache.get(`${chatId}:${userMid}`)
        : undefined;

    if (!chatId || !userMid) return;
    if (!(await isEnabled("goodbye", chatId))) return;

    await randomDelay(300, 800);

    const [displayName, groupInfo, kickerName] = await Promise.all([
      resolveDisplayName(userMid),
      getGroupInfo(chatId),
      kickerMid ? resolveDisplayName(kickerMid) : Promise.resolve(undefined),
    ]);

    const template = await getTemplate("goodbye", chatId);
    let message = renderTemplate(template, {
      name: displayName,
      group: groupInfo.groupName,
      count: groupInfo.memberCount,
    });

    // Best-effort: append who kicked the member, without breaking custom templates.
    if (kickerMid && kickerName) {
      message += `\n(ถูกเตะโดย ${kickerName})`;
    }

    try {
      await sendBotMessage(chatId, message);

      logger.info("Goodbye message sent", {
        chatId,
        userMid,
        displayName,
        kickerMid,
        kickerName,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to send goodbye message", {
        error: msg,
        chatId,
      });
    }
  }
}

/**
 * Create the Welcome/Goodbye feature.
 */
export function createWelcomeGoodbyeFeature(): Feature {
  onOperation(handleJoinLeaveOperation);

  return {
    name: "welcome-goodbye",
    commands: ["welcome", "goodbye"],
    description:
      "🎉👋 ต้อนรับ/ลาก่อน — !welcome on/off/set/reset | !goodbye on/off/set/reset",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ (ต้องเป็น Admin ขึ้นไป)");
        return;
      }

      const type = cmd.name as "welcome" | "goodbye";
      const action = cmd.args[0]?.toLowerCase();

      switch (action) {
        case "on":
        case "off": {
          await setGroupCommandEnabled(cmd.chatId, type, action === "on", cmd.senderId);

          const statusEmoji = action === "on" ? "✅" : "⛔";
          const featureName = type === "welcome" ? "ต้อนรับ" : "ลาก่อน";

          await sendBotMessage(
            cmd.chatId,
            `${statusEmoji} ระบบ${featureName}${action === "on" ? "เปิด" : "ปิด"}แล้ว`,
          );

          logger.info("Welcome/Goodbye toggled", {
            type,
            action,
            chatId: cmd.chatId,
          });
          break;
        }

        case "set": {
          const template = cmd.args.slice(1).join(" ").trim();
          if (!template) {
            await sendBotMessage(
              cmd.chatId,
              [
                "❌ กรุณาระบุ template",
                "",
                `วิธีใช้: !${type} set <template>`,
                "",
                "ตัวแปรที่ใช้ได้:",
                "• {name} — ชื่อผู้ใช้",
                "• {group} — ชื่อกลุ่ม",
                "• {count} — จำนวนสมาชิก",
                "",
                "ตัวอย่าง:",
                `• !${type} set สวัสดี {name}! ยินดีต้อนรับเข้ากลุ่ม {group} 🎊`,
                `• !${type} set {name} เข้ากลุ่มแล้ว (สมาชิกทั้งหมด {count} คน)`,
              ].join("\n"),
            );
            return;
          }

          const key = `${type}_template:${cmd.chatId}`;
          await setSetting(key, template);

          // Show preview
          const preview = renderTemplate(template, {
            name: "ตัวอย่าง",
            group: "กลุ่มทดสอบ",
            count: 42,
          });

          await sendBotMessage(cmd.chatId, `✅ ตั้ง template สำเร็จ\n\n📝 Preview:\n${preview}`);

          logger.info("Welcome/Goodbye template set", {
            type,
            chatId: cmd.chatId,
            template,
          });
          break;
        }

        case "reset": {
          const key = `${type}_template:${cmd.chatId}`;
          await setSetting(key, "");

          const defaultTpl = type === "welcome" ? DEFAULT_WELCOME : DEFAULT_GOODBYE;
          await sendBotMessage(cmd.chatId, `✅ กลับไปใช้ template เดิม:\n"${defaultTpl}"`);
          break;
        }

        default: {
          const enabled = await isEnabled(type, cmd.chatId);
          const currentTemplate = await getTemplate(type, cmd.chatId);
          const featureName = type === "welcome" ? "ต้อนรับ" : "ลาก่อน";
          const status = enabled ? "✅ เปิด" : "⛔ ปิด";

          await sendBotMessage(
            cmd.chatId,
            [
              `ℹ️ ระบบ${featureName}: ${status}`,
              `📝 Template: "${currentTemplate}"`,
              "",
              "คำสั่ง:",
              `• !${type} on/off — เปิด/ปิด`,
              `• !${type} set <template> — ตั้ง template`,
              `• !${type} reset — กลับ default`,
              "",
              "ตัวแปร: {name}, {group}, {count}",
            ].join("\n"),
          );
        }
      }
    },
  };
}
