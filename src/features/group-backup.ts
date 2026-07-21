/**
 * rlbotline Worker — Group Backup + Recovery Feature (task 025)
 *
 * Keeps a per-group member-roster snapshot in the Central API:
 *  - `!groupbackup on` runs a full scan (`scanAndSaveRoster`) and enables
 *    incremental tracking for the chat.
 *  - While enabled, every join event appends the joiner to the roster and
 *    (best-effort, rate-limited) friend-adds them, so a future
 *    `recover_group` RPC can re-invite the roster into a replacement group
 *    even for members the bot never had a saved 1-on-1 chat with.
 *  - A blacklisted joiner is kicked instead of ever entering the roster.
 *
 * The friend-add side effect runs through a single sequential queue so a
 * join burst (e.g. many people accepting invites within seconds of each
 * other) can never fire `addFriendByMid` calls back-to-back — that RPC is
 * NOT covered by the shared outbound rate limiter (see line-client.ts's
 * `installTalkRateLimit`, which only wraps `client.base.talk`, not
 * `client.base.relation`).
 */

import type { Client } from "@evex/linejs";
import { logger } from "../core/logger.js";
import {
  getClient,
  getBotMid,
  getKnownBotMid,
  resolveDisplayName,
  sendBotMessage,
  kickFromGroup,
} from "../core/line-client.js";
import {
  hasPermission,
  isBlacklisted,
  isFleetMember,
  claimEvent,
  CLAIM_TTL_MS,
  isGroupCommandEnabled,
  setGroupCommandEnabled,
  saveGroupBackupState,
  addBackupMemberState,
  getGroupBackupRoster,
  getAllBlacklisted,
} from "../core/database.js";
import { onOperation, ShortTtlCache, type RawOperation } from "../core/event-router.js";
import { sleep, randomDelay, gateOutbound } from "../core/rate-limiter.js";
import { listAllChats, listGroupMembers } from "../core/chat-lister.js";
import {
  LineOpType,
  PermissionRole,
  type Feature,
  type BotCommand,
  type GroupBackupMember,
} from "../types.js";

/**
 * De-dup join handling: a single join emits BOTH
 * NOTIFIED_ACCEPT_CHAT_INVITATION and NOTIFIED_JOIN_CHAT (confirmed via live
 * capture — same pairing welcome-goodbye.ts dedupes), so only process the
 * first arrival per `chatId:joiner` within the window.
 */
const recentJoinCache = new ShortTtlCache<true>(15_000);

/**
 * Full scan of a group's current membership — used by `!groupbackup on` and
 * the `backup_group` RPC. Replaces the saved roster wholesale (does NOT
 * friend-add). Returns the number of members saved.
 */
export async function scanAndSaveRoster(chatId: string): Promise<number> {
  const client = getClient();

  const chat = (await client.base.talk.getChat({
    chatMid: chatId,
    withMembers: true,
  })) as { chatName?: string };
  const groupName = chat?.chatName ?? "กลุ่ม";

  const rawMembers = await listGroupMembers(client, chatId);

  // De-dup by mid before persisting. The API's bulk insert has PK
  // (instance_id, chat_id, mid) with no ON CONFLICT, so a duplicate mid in
  // this list would fail the whole save transaction — if LINE ever hands
  // back a repeated mid, drop the repeat here instead of aborting the scan.
  const seenMids = new Set<string>();
  const uniqueRawMembers = rawMembers.filter((m) => {
    if (seenMids.has(m.mid)) return false;
    seenMids.add(m.mid);
    return true;
  });

  let botMid = "";
  try {
    botMid = await getBotMid();
  } catch {
    // continue without botMid — self-skip just becomes best-effort
  }

  const members: GroupBackupMember[] = [];
  for (const m of uniqueRawMembers) {
    if (botMid && m.mid === botMid) continue;
    if (await isFleetMember(m.mid)) continue;
    members.push({ mid: m.mid, displayName: m.displayName });
  }

  await saveGroupBackupState(chatId, groupName, members);
  return members.length;
}

/** Outcome of a `recoverRoster` re-invite pass. */
export interface RecoverRosterResult {
  invited: number;
  failed: number;
  blacklisted: number;
  skipped: number;
}

/**
 * Re-invites a saved group-backup roster (`sourceChatId`) into a replacement
 * group (`destChatId`). Used by the `recover_group` RPC (src/index.ts) —
 * factored out here (rather than left as an inline RPC closure) so it's
 * reachable from unit tests without an RPC harness.
 *
 * Null roster → all-zero counts. Each member is skipped (not invited) if
 * it's the bot's own mid or a fleet sibling, or counted as `blacklisted` if
 * it's on the blacklist; everything else is re-invited in chunks of 5, each
 * chunk gated by `gateOutbound()` + `randomDelay(500, 1200)`.
 */
export async function recoverRoster(
  client: Client,
  sourceChatId: string,
  destChatId: string,
): Promise<RecoverRosterResult> {
  const roster = await getGroupBackupRoster(sourceChatId);
  if (!roster) {
    return { invited: 0, failed: 0, blacklisted: 0, skipped: 0 };
  }

  let botMid = "";
  try {
    botMid = await getBotMid();
  } catch {
    // continue without botMid — self-skip just becomes best-effort
  }

  const blacklistedMids = new Set((await getAllBlacklisted()).map((b) => b.uid));

  let invited = 0;
  let failed = 0;
  let blacklisted = 0;
  let skipped = 0;
  const toInvite: string[] = [];

  for (const member of roster.members) {
    if (!member.mid || member.mid === botMid || (await isFleetMember(member.mid))) {
      skipped++;
      continue;
    }
    if (blacklistedMids.has(member.mid)) {
      blacklisted++;
      continue;
    }
    toInvite.push(member.mid);
  }

  const CHUNK_SIZE = 5;
  for (let i = 0; i < toInvite.length; i += CHUNK_SIZE) {
    const chunk = toInvite.slice(i, i + CHUNK_SIZE);
    await gateOutbound();
    await randomDelay(500, 1200);
    try {
      await client.base.talk.inviteIntoChat({ chatMid: destChatId, targetUserMids: chunk });
      invited += chunk.length;
    } catch (error) {
      failed += chunk.length;
      logger.warn("group-backup: recoverRoster invite chunk failed", {
        sourceChatId,
        destChatId,
        chunk,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { invited, failed, blacklisted, skipped };
}

// ─── Friend-add queue ──────────────────────────────────────────────
//
// A single sequential drainer so a join burst can't fire `addFriendByMid`
// back-to-back. Fed only by join events — this module never bulk-adds
// existing members.

const friendAddQueue: string[] = [];
/** Mids currently queued OR mid-drain, so `enqueueFriendAdd` can't double-queue a mid a join flood re-offers before the drainer gets to it. */
const pendingFriendAdds = new Set<string>();
let draining = false;

/** Briefly-cached set of mids the bot is already friends with. */
let friendMidCache: Set<string> | null = null;
let friendCacheAt = 0;
const FRIEND_CACHE_TTL_MS = 60_000;

async function getFriendMidSet(): Promise<Set<string>> {
  const now = Date.now();
  if (friendMidCache && now - friendCacheAt < FRIEND_CACHE_TTL_MS) {
    return friendMidCache;
  }
  try {
    const client = getClient();
    const chats = await listAllChats(client);
    friendMidCache = new Set(chats.filter((c) => c.type === "user").map((c) => c.id));
    friendCacheAt = now;
  } catch (error) {
    logger.warn("group-backup: failed to refresh friend cache", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!friendMidCache) friendMidCache = new Set();
  }
  return friendMidCache;
}

async function drainFriendAddQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (friendAddQueue.length > 0) {
      const mid = friendAddQueue.shift();
      if (!mid) continue;

      try {
        if (mid === getKnownBotMid()) continue;
        if (await isFleetMember(mid)) continue;

        const friends = await getFriendMidSet();
        if (friends.has(mid)) continue;

        await gateOutbound();
        await randomDelay(800, 2000);

        const client = getClient();
        await client.base.relation.addFriendByMid({ mid });
        friends.add(mid);

        logger.info("group-backup: friend-added new member", { mid });
      } catch (error) {
        logger.warn("group-backup: addFriendByMid failed", {
          mid,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        pendingFriendAdds.delete(mid);
      }
    }
  } finally {
    draining = false;
  }
}

function enqueueFriendAdd(mid: string): void {
  if (pendingFriendAdds.has(mid)) return;
  pendingFriendAdds.add(mid);
  friendAddQueue.push(mid);
  if (!draining) {
    drainFriendAddQueue().catch((error) => {
      logger.error("group-backup: friend-add drainer crashed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/**
 * Pure decision logic mirroring the friend-add queue's three skip checks
 * (self / fleet / already-friend) from `drainFriendAddQueue` above. Exposed
 * standalone so the skip logic is unit-testable with plain booleans, without
 * mocking `isFleetMember`/`getClient`/`listAllChats`. Not wired into the
 * queue itself — each check there still short-circuits independently (skips
 * the `isFleetMember` network call entirely for a self mid, etc.); this
 * documents/tests the same combined outcome, not the call order.
 */
export function shouldSkipFriendAdd(
  mid: string,
  botMid: string,
  isFleet: boolean,
  isAlreadyFriend: boolean,
): boolean {
  return mid === botMid || isFleet || isAlreadyFriend;
}

// ─── Join event handling ────────────────────────────────────────────

/**
 * Handle a join/accept-invite operation: kicks a blacklisted joiner
 * (no roster save, no friend-add), otherwise saves the joiner to the backup
 * roster and enqueues a friend-add. Exported for unit testing, matching the
 * convention of `anti-kick.ts`'s `handleKickOperation` and
 * `join-guard.ts`'s `handleJoinOperation`.
 */
export async function handleJoin(op: RawOperation): Promise<void> {
  if (
    op.type !== LineOpType.NOTIFIED_ACCEPT_CHAT_INVITATION &&
    op.type !== LineOpType.NOTIFIED_JOIN_CHAT
  ) {
    return;
  }

  const chatId = op.param1;
  const joiner = op.param2;
  if (!chatId || !joiner) return;

  const dedupKey = `${chatId}:${joiner}`;
  if (recentJoinCache.get(dedupKey)) return;
  recentJoinCache.set(dedupKey, true);

  try {
    if (!(await isGroupCommandEnabled(chatId, "groupbackup"))) return;

    if (joiner === getKnownBotMid()) return;
    if (await isFleetMember(joiner)) return;

    // Blacklist FIRST: never friend-add or save a blacklisted joiner.
    if (await isBlacklisted(joiner)) {
      // Fleet coordination: every bot in the group *running this feature*
      // independently observes this same join, so only the claim winner
      // among them kicks. This claim key is scoped to group-backup only —
      // it does NOT coordinate with join-guard's own `joinguard:...` claim
      // (see join-guard.ts), so join-guard (if also enabled) still attempts
      // its own kick independently. Harmless: a second kick call on an
      // already-departed member is idempotent, just not deduped across
      // features.
      if (!(await claimEvent(`groupbackup-kick:${chatId}:${joiner}`, CLAIM_TTL_MS))) return;
      try {
        await sleep(500);
        await kickFromGroup(chatId, [joiner]);
        logger.info("group-backup: kicked blacklisted joiner", { chatId, joiner });
      } catch (error) {
        logger.error("group-backup: failed to kick blacklisted joiner", {
          chatId,
          joiner,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    try {
      const displayName = await resolveDisplayName(joiner);
      await addBackupMemberState(chatId, { mid: joiner, displayName });
    } catch (error) {
      logger.error("group-backup: failed to save joiner to roster", {
        chatId,
        joiner,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    enqueueFriendAdd(joiner);
  } catch (error) {
    logger.error("group-backup: unhandled error in join handler", {
      chatId,
      opType: op.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── Feature ─────────────────────────────────────────────────────────

export function createGroupBackupFeature(): Feature {
  onOperation(handleJoin);

  return {
    name: "group-backup",
    commands: ["groupbackup"],
    description: "💾 บันทึกกลุ่ม — !groupbackup on/off/status",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      const action = cmd.args[0]?.toLowerCase();

      switch (action) {
        case "on": {
          await setGroupCommandEnabled(cmd.chatId, "groupbackup", true, cmd.senderId);
          try {
            const count = await scanAndSaveRoster(cmd.chatId);
            await sendBotMessage(cmd.chatId, `✅ เปิดบันทึกกลุ่ม + บันทึกสมาชิก ${count} คนแล้ว`);
            logger.info("group-backup: enabled + initial scan", { chatId: cmd.chatId, count });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error("group-backup: initial scan failed", { chatId: cmd.chatId, error: msg });
            await sendBotMessage(cmd.chatId, "✅ เปิดบันทึกกลุ่มแล้ว แต่สแกนสมาชิกเริ่มต้นล้มเหลว (ลอง !groupbackup on อีกครั้ง)");
          }
          break;
        }

        case "off": {
          await setGroupCommandEnabled(cmd.chatId, "groupbackup", false, cmd.senderId);
          await sendBotMessage(cmd.chatId, "⛔ ปิดบันทึกกลุ่มแล้ว");
          break;
        }

        default: {
          const enabled = await isGroupCommandEnabled(cmd.chatId, "groupbackup");
          const roster = await getGroupBackupRoster(cmd.chatId);
          const count = roster?.members.length ?? 0;

          await sendBotMessage(
            cmd.chatId,
            [
              `💾 บันทึกกลุ่ม: ${enabled ? "✅ เปิด" : "⛔ ปิด"}`,
              `👥 สมาชิกที่บันทึกไว้: ${count} คน`,
              "",
              "คำสั่ง:",
              "• !groupbackup on — เปิด + สแกนสมาชิกทั้งหมด",
              "• !groupbackup off — ปิด",
              "• !groupbackup status — ดูสถานะ",
              "",
              "💡 เมื่อเปิด สมาชิกใหม่ที่เข้ากลุ่มจะถูกบันทึกอัตโนมัติ",
              "💡 คนที่ติด blacklist จะถูกเตะแทนการบันทึก",
            ].join("\n"),
          );
        }
      }
    },
  };
}
