/**
 * rlbotline Worker — Anti-Kick Feature (Phase 3)
 *
 * Detects when a member is kicked from a group and automatically
 * re-invites them. Optionally kicks the attacker back (revenge mode).
 */

import { logger } from "../core/logger.js";
import { getClient, getBotMid, resolveDisplayName, kickFromGroup, sendBotMessage } from "../core/line-client.js";
import {
  hasPermission,
  addToBlacklist,
  isBlacklisted,
  isFleetMember,
  claimEvent,
  CLAIM_TTL_MS,
  isGroupCommandEnabled,
  setGroupCommandEnabled,
} from "../core/database.js";
import {
  onOperation,
  extractChatEventActorTarget,
  ShortTtlCache,
  type RawOperation,
} from "../core/event-router.js";
import { sleep } from "../core/rate-limiter.js";
import { PermissionRole, LineOpType, type Feature, type BotCommand } from "../types.js";

/**
 * Correlates a `DELETE_OTHER_FROM_CHAT` op (no kicker identity) with the
 * `C_MR` CHATEVENT announcement carrying the kicker's mid. Keyed by
 * `chatId:targetMid` since the two ops for the same kick may arrive in
 * either order within a few hundred ms of each other.
 */
const kickerCorrelationCache = new ShortTtlCache<string>(10_000);

/**
 * Listen for CHATEVENT announcements (member-removed / member-invited) on
 * every op, so the kicker's mid is cached before or after the corresponding
 * `DELETE_OTHER_FROM_CHAT` op arrives.
 */
function cacheKickerFromChatEvent(op: RawOperation): void {
  const actorTarget = extractChatEventActorTarget(op);
  // Only "C_MR" (member removed) correlates to a kick. "C_MI" (invite) pairs
  // are never read back here, so caching them would just leak entries.
  if (!actorTarget || actorTarget.locKey !== "C_MR") return;
  kickerCorrelationCache.set(`${actorTarget.chatId}:${actorTarget.targetMid}`, actorTarget.actorMid);
}

/** A kick, as resolved from whichever signal announced it. */
interface ResolvedKick {
  chatId: string;
  kickedMid: string;
  /** "" when the announcement didn't identify the kicker. */
  kickerMid: string;
}

/**
 * Resolve the kick an op represents, from **either** signal LINE may send:
 *
 * 1. The `C_MR` CHATEVENT — carries `LOC_ARGS = actor␞target`, i.e. the kicker
 *    identity directly, no correlation needed.
 * 2. `DELETE_OTHER_FROM_CHAT` — carries no kicker; correlated best-effort via
 *    the cache above.
 *
 * Treating `C_MR` as a trigger (not just correlation metadata) is the fix for
 * kicks that were never acted on at all: a kick announced *only* as a CHATEVENT
 * used to fall straight through this handler, so the victim was never re-invited
 * and the kicker was never punished.
 *
 * Both paths yield the same `(chatId, kickedMid)`, so the claim below collapses
 * a kick seen both ways into a single action.
 */
function resolveKick(op: RawOperation): ResolvedKick | null {
  const actorTarget = extractChatEventActorTarget(op);
  if (actorTarget && actorTarget.locKey === "C_MR") {
    return {
      chatId: actorTarget.chatId,
      kickedMid: actorTarget.targetMid,
      kickerMid: actorTarget.actorMid,
    };
  }

  if (op.type === LineOpType.DELETE_OTHER_FROM_CHAT) {
    const chatId = op.param1;
    const kickedMid = op.param2;
    if (!chatId || !kickedMid) return null;
    // ponytail: if the C_MR CHATEVENT hasn't been seen yet (arrives in a later
    // poll batch, or never), kickerMid stays "" and autokickbot/revenge no-op
    // for this kick — re-invite still runs, and a C_MR arriving afterwards
    // loses the claim, so the kicker goes unpunished. Same ceiling as before
    // this handler learned to trigger on C_MR. If kicks are regularly slipping
    // through unattributed, split the claim into re-invite vs punish keys.
    return {
      chatId,
      kickedMid,
      kickerMid: kickerCorrelationCache.get(`${chatId}:${kickedMid}`) ?? "",
    };
  }

  return null;
}

/**
 * Check if anti-kick is enabled for a given chat.
 */
async function isEnabled(chatId: string): Promise<boolean> {
  return isGroupCommandEnabled(chatId, "antikick");
}

/**
 * Check if revenge mode (kick the attacker back) is enabled for a given chat.
 *
 * Stored as a per-group ambient toggle, exactly like `antikick` itself — that's
 * what lets the dashboard show it in the toggle grid. It previously lived in a
 * `antikickrevenge:<chatId>` settings key, which nothing but the in-chat command
 * could ever write, so it was invisible and unreachable from the dashboard.
 */
async function isRevengeEnabled(chatId: string): Promise<boolean> {
  return isGroupCommandEnabled(chatId, "antikickrevenge");
}

/**
 * Check if auto-kick-bot (blacklist + kick any non-admin who kicks someone)
 * is enabled for a given chat. Independent toggle from `antikickrevenge` —
 * revenge just kicks the attacker back; this additionally blacklists them so
 * a re-invite can't happen and future joins are auto-rejected (join-guard).
 */
async function isAutoKickBotEnabled(chatId: string): Promise<boolean> {
  return isGroupCommandEnabled(chatId, "autokickbot");
}

/**
 * Handle kick operations — re-invite the kicked user.
 * Exported for the fleet-claim-gate unit test.
 */
export async function handleKickOperation(op: RawOperation): Promise<void> {
  // Cache CHATEVENT actor/target pairs (C_MR/C_MI) on every op so the kicker
  // can be resolved regardless of arrival order relative to the kick op.
  cacheKickerFromChatEvent(op);

  const kick = resolveKick(op);
  if (!kick) return;

  const { chatId, kickedMid, kickerMid } = kick;

  // Don't act if anti-kick is disabled for this chat
  if (!(await isEnabled(chatId))) return;

  // Resolve bot's own MID once — used to skip self-kick and to make sure the
  // bot's own revenge/auto-kick-bot kicks can never re-trigger this handler.
  let botMid = "";
  try {
    botMid = await getBotMid();
  } catch {
    // If we can't get bot MID, continue anyway
  }

  // Don't try to re-invite if the bot itself was kicked
  if (botMid && kickedMid === botMid) {
    logger.warn("Bot was kicked from chat, cannot re-invite self", {
      chatId,
      kickerMid,
    });
    return;
  }

  // Don't re-invite if the kicker was an admin/owner, or one of our own bots
  // (both are legitimate kicks).
  //
  // The fleet arm is what stops friendly fire at the source, and the kick guard
  // in `kickFromGroup` is NOT a substitute for it: without this, a sibling's
  // legitimate kick still reaches the claim, and the winner would dutifully
  // re-invite the offender its own fleet-mate just removed — undoing moderation
  // instead of amplifying it. Siblings are trusted here as *actors*; this grants
  // them no command powers (see api-spec.md §3a Fleet roster).
  const kickerIsTrusted =
    Boolean(kickerMid)
    && ((await hasPermission(kickerMid, PermissionRole.ADMIN))
      || (await isFleetMember(kickerMid)));
  if (kickerIsTrusted) {
    logger.debug("Kick by admin/owner/fleet bot, not re-inviting", {
      chatId,
      kickedMid,
      kickerMid,
    });
    return;
  }

  // Fleet coordination: when a user runs many bots in the same LINE group,
  // every bot independently observes this same kick op. Without a claim,
  // every bot would re-invite + autokickbot + revenge-kick in parallel,
  // N×-amplifying LINE API calls and risking a fleet-wide ban. Only the
  // first bot to win the claim runs the rest of this handler. Keyed on
  // chatId+kickedMid ONLY (never the kicker) so the key is identical across
  // every bot even when some fail to correlate the kicker via the CHATEVENT
  // cache above — the single winner still runs the full autokickbot +
  // re-invite + revenge sequence using whatever kickerMid it resolved.
  if (!(await claimEvent(`antikick:${chatId}:${kickedMid}`, CLAIM_TTL_MS))) return;

  const lineClient = getClient();

  // Auto-kick-bot: blacklist + kick the kicker outright, provided it's not
  // the bot's own revenge kick and not an internal admin (both already
  // excluded above) — this cannot feed back into itself.
  if (kickerMid && kickerMid !== botMid && (await isAutoKickBotEnabled(chatId))) {
    try {
      const name = await resolveDisplayName(kickerMid);
      await addToBlacklist(kickerMid, name, "auto: kicked a member", botMid || "system");
      await sleep(500);
      await kickFromGroup(chatId, [kickerMid]);
      logger.info("Anti-kick: auto-kick-bot blacklisted and kicked kicker", {
        chatId,
        kickerMid,
        name,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Anti-kick: auto-kick-bot failed", { chatId, kickerMid, error: msg });
    }
  }

  // Best-effort: resolve the kicker's display name for logging/notification.
  const kickerName = kickerMid ? await resolveDisplayName(kickerMid) : undefined;

  // The victim being blacklisted is a real gap: never re-invite a
  // blacklisted user back in, even if they were the one kicked out.
  if (await isBlacklisted(kickedMid)) {
    logger.info("Anti-kick: kicked user is blacklisted, skipping re-invite", {
      chatId,
      kickedMid,
      kickerMid,
    });
    return;
  }

  // Small delay before re-inviting (anti-ban)
  await sleep(500);

  // Re-invite the kicked user
  try {
    await lineClient.base.talk.inviteIntoChat({
      chatMid: chatId,
      targetUserMids: [kickedMid],
    });

    logger.info("Anti-kick: re-invited kicked user", {
      chatId,
      kickedMid,
      kickerMid,
      kickerName,
    });

    // Notify the chat
    const kickerInfo = kickerMid ? `\nผู้เตะ: ${kickerName ?? kickerMid}` : "";
    let notifyText = `🛡️ Anti-Kick: ได้เชิญสมาชิกที่ถูกเตะกลับเข้ากลุ่มแล้ว${kickerInfo}`;

    // Revenge mode: kick the attacker back, if enabled and the kick wasn't
    // by our own admin/owner (already established above) and we know who did it.
    if (
      kickerMid &&
      kickerMid !== botMid &&
      !kickerIsTrusted &&
      (await isRevengeEnabled(chatId))
    ) {
      try {
        await sleep(500);
        await kickFromGroup(chatId, [kickerMid]);

        logger.info("Anti-kick: revenge-kicked attacker", {
          chatId,
          kickerMid,
          kickerName,
        });

        notifyText += `\n🔥 Revenge: เตะ ${kickerName ?? kickerMid} ออกจากกลุ่มแล้ว`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("Anti-kick: failed to revenge-kick attacker", {
          chatId,
          kickerMid,
          kickerName,
          error: msg,
        });
      }
    }

    await sendBotMessage(chatId, notifyText);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Anti-kick: failed to re-invite", {
      chatId,
      kickedMid,
      kickerMid,
      kickerName,
      error: msg,
    });
  }
}

/** Display names for the sub-toggles, used in command replies. */
const SUB_TOGGLE_LABEL: Record<string, string> = {
  antikickrevenge: "Anti-Kick Revenge",
  autokickbot: "Anti-Kick Auto-Kick-Bot",
};

/**
 * Apply an on/off sub-toggle (`antikickrevenge` / `autokickbot`) for a chat.
 * Shared by the direct commands and by `!antikick revenge|autokickbot on/off`.
 */
async function setSubToggle(cmd: BotCommand, command: string, action?: string): Promise<void> {
  const label = SUB_TOGGLE_LABEL[command] ?? command;

  if (action !== "on" && action !== "off") {
    await sendBotMessage(cmd.chatId, `❌ กรุณาระบุ on หรือ off\n\nวิธีใช้: !${command} on/off`);
    return;
  }

  await setGroupCommandEnabled(cmd.chatId, command, action === "on", cmd.senderId);
  await sendBotMessage(
    cmd.chatId,
    `${action === "on" ? "✅" : "⛔"} ${label} ${action === "on" ? "เปิด" : "ปิด"}แล้ว`,
  );
}

/**
 * Create the Anti-Kick feature.
 */
export function createAntiKickFeature(): Feature {
  // Register operation listener
  onOperation(handleKickOperation);

  return {
    name: "anti-kick",
    // `antikickrevenge` and `autokickbot` are registered as commands in their own
    // right so they show up in the worker's command catalog — that catalog is what
    // the dashboard's per-group toggle grid is built from, so registering them is
    // what makes them switchable from the UI instead of in-chat only.
    commands: ["antikick", "antikickrevenge", "autokickbot"],
    description: "🛡️ ป้องกันเตะ — !antikick on/off/revenge/autokickbot/status",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      // The two sub-toggles, invoked directly (`!autokickbot on`) or toggled from
      // the dashboard grid. `!antikick autokickbot on` still works below.
      if (cmd.name === "antikickrevenge" || cmd.name === "autokickbot") {
        await setSubToggle(cmd, cmd.name, cmd.args[0]?.toLowerCase());
        return;
      }

      const action = cmd.args[0]?.toLowerCase();

      switch (action) {
        case "on":
        case "off": {
          await setGroupCommandEnabled(cmd.chatId, "antikick", action === "on", cmd.senderId);
          const emoji = action === "on" ? "✅" : "⛔";
          await sendBotMessage(cmd.chatId, `${emoji} Anti-Kick ${action === "on" ? "เปิด" : "ปิด"}แล้ว`);
          break;
        }

        case "revenge": {
          await setSubToggle(cmd, "antikickrevenge", cmd.args[1]?.toLowerCase());
          break;
        }

        case "autokickbot": {
          await setSubToggle(cmd, "autokickbot", cmd.args[1]?.toLowerCase());
          break;
        }

        default: {
          const enabled = await isEnabled(cmd.chatId);
          const revengeEnabled = await isRevengeEnabled(cmd.chatId);
          const autoKickBotEnabled = await isAutoKickBotEnabled(cmd.chatId);
          await sendBotMessage(
            cmd.chatId,
            [
              `🛡️ Anti-Kick: ${enabled ? "✅ เปิด" : "⛔ ปิด"}`,
              `🔥 Revenge: ${revengeEnabled ? "✅ เปิด" : "⛔ ปิด"}`,
              `🚫 Auto-Kick-Bot: ${autoKickBotEnabled ? "✅ เปิด" : "⛔ ปิด"}`,
              "",
              "คำสั่ง:",
              "• !antikick on — เปิดป้องกันเตะ",
              "• !antikick off — ปิดป้องกันเตะ",
              "• !antikick revenge on — เปิดเตะผู้เตะกลับ",
              "• !antikick revenge off — ปิดเตะผู้เตะกลับ",
              "• !antikick autokickbot on — เปิด blacklist+เตะผู้ที่เตะสมาชิกอัตโนมัติ",
              "• !antikick autokickbot off — ปิด",
              "",
              "💡 เมื่อเปิด บอทจะเชิญคนที่ถูกเตะกลับอัตโนมัติ",
              "💡 การเตะโดย Admin/Owner จะไม่ถูกป้องกัน",
              "💡 Revenge mode: บอทจะพยายามเตะผู้ที่เตะสมาชิกออกจากกลุ่ม",
            ].join("\n"),
          );
        }
      }
    },
  };
}
