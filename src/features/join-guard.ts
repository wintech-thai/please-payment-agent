/**
 * rlbotline Worker — Join Guard Feature
 *
 * Watches group join/invite events and enforces the blacklist at the door:
 *  - if the joining/invited member is already blacklisted, kick them back out
 *  - if whoever invited them is known, blacklist + kick the inviter too
 *
 * Op-param semantics (LINE Talk protocol) — there's no per-op schema in the
 * Thrift IDL beyond a generic `{ type, param1, param2, param3 }` struct
 * (`Pb1_C13154r6` in `@evex/linejs-types`), so the meaning of param1..3 is
 * tribal knowledge (same convention CHRLINE-derived bots use, and the same
 * one anti-kick.ts already relied on for the old NOTIFIED_KICKOUT_FROM_CHAT
 * numeric guess: param1=chatId, param2=target). Live capture has since
 * confirmed the real op is DELETE_OTHER_FROM_CHAT (string) with NO param3 —
 * the kicker isn't carried on this op at all; see event-router.ts's
 * `extractChatEventActorTarget` for how anti-kick.ts/welcome-goodbye.ts now
 * resolve it from a correlated CHATEVENT announcement instead):
 *
 *  - NOTIFIED_ACCEPT_CHAT_INVITATION (13): fires when a user *accepts* an
 *    invite and actually joins. param1 = chatId, param2 = joiner mid. No
 *    inviter is carried on this event (the invite itself already happened on
 *    an earlier NOTIFIED_INVITE_INTO_CHAT op) — matches the existing
 *    assumption in welcome-goodbye.ts.
 *  - NOTIFIED_INVITE_INTO_CHAT (14): fires when someone *invites* others
 *    into the chat (before they've accepted). param1 = chatId, param2 =
 *    inviter mid (the actor), param3 = comma-separated invited mid(s) (the
 *    target list) — welcome-goodbye.ts treats param2 as "the joiner" for
 *    this op, which is NOT reliable: param2 here is the *inviter*, not an
 *    invitee, and param3 (not param2) carries the invited mid(s).
 *
 *  Per-op param schema: checked `@evex/linejs-types`' `thrift.ts` `OpType`
 *  table (the canonical opcode-name map used to decode the wire `type`
 *  field) — it defines op *names* only, no per-op param1/param2/param3
 *  field schema for the generic Operation struct. The param2=inviter /
 *  param3=invitees convention above remains tribal knowledge (same as the
 *  header comment already said), not something confirmable from the IDL.
 *  Given that, the kick path below no longer trusts which param is "the
 *  joiner" — it treats param2 AND every param3 entry as candidates and
 *  blacklist-checks each individually, so a blacklisted entrant gets kicked
 *  whichever slot they landed in. A `logger.debug` line logs the raw
 *  op.type/param1/param2/param3 on every join/invite op so the real mapping
 *  can be confirmed against production traffic.
 *
 *  QR code / invite-link joins: the same `OpType` table has no separate
 *  "joined by ticket/URL" opcode (no `*_BY_TICKET`, no `*_TICKET*` join
 *  variant anywhere in the 0-152 opcode range) — LINE does not appear to
 *  distinguish join-via-explicit-invite-acceptance from join-via-QR/ticket
 *  at the operation-type level. Both land as NOTIFIED_ACCEPT_CHAT_INVITATION
 *  (13 in this codebase's numbering), which already has no inviter param and
 *  only runs the kick-blacklisted-joiner path — so QR/link joins are already
 *  covered without adding a new op constant.
 */

import { logger } from "../core/logger.js";
import { getBotMid, resolveDisplayName, kickFromGroup, sendBotMessage } from "../core/line-client.js";
import {
  hasPermission,
  isBlacklisted,
  addToBlacklist,
  claimEvent,
  CLAIM_TTL_MS,
  isGroupCommandEnabled,
  setGroupCommandEnabled,
} from "../core/database.js";
import { onOperation, type RawOperation } from "../core/event-router.js";
import { randomDelay } from "../core/rate-limiter.js";
import { LineOpType, PermissionRole, type Feature, type BotCommand } from "../types.js";

/**
 * Check if join-guard is enabled for a given chat. Default OFF.
 */
async function isEnabled(chatId: string): Promise<boolean> {
  return isGroupCommandEnabled(chatId, "joinguard");
}

function parseInviteeMids(param3: string): string[] {
  return param3
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function kickBlacklistedJoiner(chatId: string, joinerMid: string): Promise<void> {
  await randomDelay(300, 800);
  try {
    await kickFromGroup(chatId, [joinerMid]);
    logger.info("Join-guard: kicked blacklisted joiner", { chatId, joinerMid });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Join-guard: failed to kick blacklisted joiner", {
      chatId,
      joinerMid,
      error: msg,
    });
  }
}

async function punishInviter(chatId: string, inviterMid: string, botMid: string): Promise<void> {
  if (!inviterMid || inviterMid === botMid) return;
  if (await hasPermission(inviterMid, PermissionRole.ADMIN)) return;

  try {
    const name = await resolveDisplayName(inviterMid);
    await addToBlacklist(inviterMid, name, "invited a blacklisted user", botMid || "system");
    await randomDelay(300, 800);
    await kickFromGroup(chatId, [inviterMid]);
    logger.info("Join-guard: blacklisted + kicked inviter of a blacklisted user", {
      chatId,
      inviterMid,
      name,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Join-guard: failed to punish inviter", { chatId, inviterMid, error: msg });
  }
}

/**
 * Handle join/invite operations from the event system.
 * Exported for the fleet-claim-gate unit test.
 */
export async function handleJoinOperation(op: RawOperation): Promise<void> {
  if (
    op.type !== LineOpType.NOTIFIED_ACCEPT_CHAT_INVITATION &&
    op.type !== LineOpType.NOTIFIED_INVITE_INTO_CHAT
  ) {
    return;
  }

  const chatId = op.param1;
  if (!chatId) return;

  try {
    if (!(await isEnabled(chatId))) return;

    let botMid = "";
    try {
      botMid = await getBotMid();
    } catch {
      // continue without botMid — self-skip just becomes best-effort
    }

    // Debug-only: raw params for every join/invite op, so the param2/param3
    // mapping can be confirmed against real production traffic (see header
    // comment — no field-level schema exists in the linejs thrift IDL).
    logger.debug("Join-guard: raw join/invite op", {
      chatId,
      opType: op.type,
      param1: op.param1,
      param2: op.param2,
      param3: op.param3,
    });

    if (op.type === LineOpType.NOTIFIED_ACCEPT_CHAT_INVITATION) {
      const joinerMid = op.param2;
      if (!joinerMid || joinerMid === botMid) return;
      if (await isBlacklisted(joinerMid)) {
        // Fleet coordination: every bot in the group independently observes
        // this same join. Claim before kicking so only one bot acts — the
        // rest skip, avoiding N× kick calls for a single blacklisted joiner.
        if (!(await claimEvent(`joinguard:${chatId}:${joinerMid}`, CLAIM_TTL_MS))) return;
        await kickBlacklistedJoiner(chatId, joinerMid);
      }
      return;
    }

    // NOTIFIED_INVITE_INTO_CHAT: param2 is conventionally the inviter,
    // param3 the comma-separated invitee list — but that mapping isn't
    // IDL-guaranteed (see header comment), so every candidate (param2 +
    // each param3 entry) is blacklist-checked and kicked independently.
    // This kicks a blacklisted entrant whether they're the "invitee" or the
    // (already-blacklisted) "inviter", without depending on which param
    // means what.
    const inviterMid = op.param2;
    const candidates = new Set<string>();
    if (inviterMid) candidates.add(inviterMid);
    for (const mid of parseInviteeMids(op.param3)) candidates.add(mid);
    if (candidates.size === 0) return;

    let anyInviteeBlacklisted = false;
    for (const mid of candidates) {
      if (!mid || mid === botMid) continue;
      if (await isBlacklisted(mid)) {
        if (mid !== inviterMid) anyInviteeBlacklisted = true;
        // Fleet coordination: claim per-target, same as the accept-invite
        // path above, so only one bot in the fleet kicks this candidate.
        // `continue` (not `return`) — other candidates in this batch still
        // need their own independent claim + kick decision.
        if (!(await claimEvent(`joinguard:${chatId}:${mid}`, CLAIM_TTL_MS))) continue;
        await kickBlacklistedJoiner(chatId, mid);
      }
    }

    // Only punish the inviter (blacklist + kick) when a *different* party
    // (an actual invitee, not the inviter itself) turned out blacklisted —
    // avoids re-blacklisting/re-kicking the same mid twice in one pass.
    if (anyInviteeBlacklisted && inviterMid && inviterMid !== botMid) {
      // Separate claim key from the joiner-kick claims above: punishing the
      // inviter is a distinct outbound action (blacklist + kick) that must
      // also only happen once fleet-wide, independent of which bot won the
      // per-invitee kick claim(s).
      if (await claimEvent(`joinguard:${chatId}:inviter:${inviterMid}`, CLAIM_TTL_MS)) {
        await punishInviter(chatId, inviterMid, botMid);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Join-guard: unhandled error", { chatId, opType: op.type, error: msg });
  }
}

/**
 * Create the Join-Guard feature.
 */
export function createJoinGuardFeature(): Feature {
  onOperation(handleJoinOperation);

  return {
    name: "join-guard",
    commands: ["joinguard"],
    description: "🚧 ป้องกันคนใน blacklist เข้ากลุ่ม — !joinguard on/off/status",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      const action = cmd.args[0]?.toLowerCase();
      switch (action) {
        case "on":
        case "off": {
          await setGroupCommandEnabled(cmd.chatId, "joinguard", action === "on", cmd.senderId);
          const emoji = action === "on" ? "✅" : "⛔";
          await sendBotMessage(cmd.chatId, `${emoji} Join-Guard ${action === "on" ? "เปิด" : "ปิด"}แล้ว`);
          break;
        }

        default: {
          const enabled = await isEnabled(cmd.chatId);
          await sendBotMessage(
            cmd.chatId,
            [
              `🚧 Join-Guard: ${enabled ? "✅ เปิด" : "⛔ ปิด"}`,
              "",
              "คำสั่ง:",
              "• !joinguard on — เปิด",
              "• !joinguard off — ปิด",
              "",
              "💡 เมื่อเปิด บอทจะเตะสมาชิกที่อยู่ใน blacklist ทันทีที่เข้ากลุ่ม",
              "💡 และจะ blacklist + เตะผู้เชิญ ถ้าเชิญคนที่ถูก blacklist เข้ามา",
            ].join("\n"),
          );
        }
      }
    },
  };
}
