/**
 * rlbotline Worker — Group-Settings Guards ("กันแก้กลุ่ม")
 *
 * Five guards that punish non-admins who tamper with group settings, plus
 * revert the change where LINE lets us. All five detect their event on the
 * ORDINARY message stream (`onRawMessage`) — the group-settings changes surface
 * as forwardable messages, not just operations, so no op-stream/RAW_OP_LOG
 * plumbing is needed (confirmed via live capture, 2026-07-16 — see
 * .research/line-op-type-verification.md "Phase B capture RESULTS"):
 *
 *   | key          | TH                | signal                              | revert           |
 *   | antiname     | กันเปลี่ยนชื่อกลุ่ม    | CHATEVENT LOC_KEY=C_PN              | ชื่อเก่า (snapshot) |
 *   | antipicture  | กันเปลี่ยนรูปกลุ่ม    | CHATEVENT LOC_KEY=C_PI              | รูปเก่า (snapshot)  |
 *   | antiinvite   | กันสมาชิกเชิญ       | CHATEVENT LOC_KEY=C_MI              | cancel invite    |
 *   | antinote     | กันโน๊ตกลุ่ม        | POSTNOTIFICATION locKey=BG (GB)     | — (punish only)  |
 *   | antialbum    | กันอัลบั้มกลุ่ม      | POSTNOTIFICATION locKey=BA (AB)     | — (punish only)  |
 *   | antigrouplink| กันลิ้งกลุ่ม        | CHATEVENT LOC_KEY=C_SN (link ON)    | disableInviteLink|
 *   | anticancelinvite | กันสมาชิกยกเชิญ | CHATEVENT LOC_KEY=C_IC              | re-invite        |
 *
 * The actor (who made the change) rides the event itself — CHATEVENT
 * `LOC_ARGS` is `actor␞target` (U+001E-joined, actor first, same as anti-kick's
 * C_MR/C_MI), and note/album POSTNOTIFICATIONs carry the creator as the
 * message `from` (= `senderId`). So unlike anti-kick, no CHATEVENT-correlation
 * cache is needed — the actor is never missing.
 *
 * Punishment is anti-call's sequence: blacklist (fleet-wide) + kick. Notes and
 * albums have NO talk-service revert (VOOM/timeline needs a channel token this
 * worker lacks), so those two are punish-only — the creator is still kicked +
 * blacklisted, the note/album content just isn't deleted.
 *
 * The invite-link toggle emits an actor-only CHATEVENT per action: capture
 * (close-then-reopen) showed `C_SP` = link DISABLED, `C_SN` = link ENABLED —
 * so `antigrouplink` fires on `C_SN` only (someone turning the link ON is the
 * threat; turning it off is harmless). Its `revert` re-disables the link and
 * reissues the ticket to kill any leaked URL.
 *
 * `anticancelinvite` catches a member cancelling someone's pending invite
 * (CHATEVENT `C_IC`, LOC_ARGS `canceller␞cancelledInvitee`) — it re-invites the
 * cancelled person (restore) and punishes the canceller.
 */

import { logger } from "../core/logger.js";
import {
  getKnownBotMid,
  kickFromGroup,
  resolveDisplayName,
  sendBotMessage,
  revertChatName,
  revertChatPicture,
  cancelInvitations,
  reinviteToChat,
  disableInviteLink,
  fetchChatSettings,
} from "../core/line-client.js";
import {
  addToBlacklist,
  hasPermission,
  isFleetMember,
  isGroupCommandEnabled,
  setGroupCommandEnabled,
  claimEvent,
  CLAIM_TTL_MS,
} from "../core/database.js";
import { getSnapshot, updateSnapshot } from "../core/chat-snapshot.js";
import { sleep } from "../core/rate-limiter.js";
import { onRawMessage, type RawMessage } from "../core/event-router.js";
import { PermissionRole, type Feature, type BotCommand } from "../types.js";
import type { TalkMessage } from "@evex/linejs";

type ContentMetadata = Record<string, string | undefined>;

export type GroupEventKind =
  | "name"
  | "picture"
  | "invite"
  | "note"
  | "album"
  | "grouplink"
  | "cancelinvite";

/** Toggle key per guard kind. */
const KEY: Record<GroupEventKind, string> = {
  name: "antiname",
  picture: "antipicture",
  invite: "antiinvite",
  note: "antinote",
  album: "antialbum",
  grouplink: "antigrouplink",
  cancelinvite: "anticancelinvite",
};

const TH_LABEL: Record<GroupEventKind, string> = {
  name: "กันเปลี่ยนชื่อกลุ่ม",
  picture: "กันเปลี่ยนรูปกลุ่ม",
  invite: "กันสมาชิกเชิญ",
  note: "กันโน๊ตกลุ่ม",
  album: "กันอัลบั้มกลุ่ม",
  grouplink: "กันลิ้งกลุ่ม",
  cancelinvite: "กันสมาชิกยกเชิญ",
};

const PUNISH_REASON: Record<GroupEventKind, string> = {
  name: "auto: changed group name",
  picture: "auto: changed group picture",
  invite: "auto: invited a member",
  note: "auto: created a group note",
  album: "auto: created a group album",
  grouplink: "auto: enabled the group invite link",
  cancelinvite: "auto: cancelled a pending invite",
};

/** U+001E record separator joining `actor␞target` in a CHATEVENT's LOC_ARGS. */
const LOC_ARGS_SEP = "\x1e";

function parseLocArgs(locArgs: string | undefined): string[] {
  return (locArgs ?? "").split(LOC_ARGS_SEP).filter(Boolean);
}

export interface GroupEvent {
  kind: GroupEventKind;
  /** Actor mid if the event carries it (CHATEVENT); undefined for note/album
   *  where the actor is the message `from` (resolved by the handler). */
  actor?: string;
  /** New group name, only for `name` (C_PN carries it in LOC_ARGS). */
  newName?: string;
  /** Invitee mid, only for `invite` (C_MI LOC_ARGS = inviter␞invitee). */
  invitee?: string;
}

/**
 * Pure classifier — maps a message's contentType + contentMetadata to the
 * group-settings event it represents, or null. Exported for unit testing.
 */
export function detectGroupEvent(
  contentType: number | string,
  meta: ContentMetadata | undefined,
): GroupEvent | null {
  if (!meta) return null;

  if (contentType === "CHATEVENT") {
    const args = parseLocArgs(meta.LOC_ARGS);
    switch (meta.LOC_KEY) {
      case "C_PN":
        return { kind: "name", actor: args[0], newName: args[1] };
      case "C_PI":
        return { kind: "picture", actor: args[0] };
      case "C_MI":
        return { kind: "invite", actor: args[0], invitee: args[1] };
      // C_SN = invite link ENABLED (the threat). C_SP = link disabled — harmless,
      // deliberately NOT mapped so the guard never punishes turning it OFF.
      case "C_SN":
        return { kind: "grouplink", actor: args[0] };
      // C_IC = a pending invite was CANCELLED. LOC_ARGS = canceller␞cancelledInvitee.
      case "C_IC":
        return { kind: "cancelinvite", actor: args[0], invitee: args[1] };
      default:
        return null;
    }
  }

  if (contentType === "POSTNOTIFICATION") {
    // Require BOTH locKey and serviceType — notes and albums both carry
    // postEndUrl, so keying on that alone conflates them (the same trap that
    // disabled anti-media's `post`).
    if (meta.locKey === "BG" && meta.serviceType === "GB") return { kind: "note" };
    if (meta.locKey === "BA" && meta.serviceType === "AB") return { kind: "album" };
  }

  return null;
}

function readContentMetadata(message: RawMessage): ContentMetadata | undefined {
  return (message.raw as TalkMessage & { raw?: { contentMetadata?: ContentMetadata } }).raw
    ?.contentMetadata;
}

/** Never punished: this bot, admins/owners, sibling fleet bots. */
async function isExempt(mid: string): Promise<boolean> {
  if (!mid) return true;
  if (mid === getKnownBotMid()) return true;
  if (await hasPermission(mid, PermissionRole.ADMIN)) return true;
  return isFleetMember(mid);
}

/** Blacklist (fleet-wide) + kick the actor — anti-call's sequence. */
async function punish(chatId: string, actor: string, reason: string, kind: GroupEventKind): Promise<void> {
  const botMid = getKnownBotMid();
  const name = await resolveDisplayName(actor);
  await addToBlacklist(actor, name, reason, botMid || "system");
  await sleep(500);
  const result = await kickFromGroup(chatId, [actor]);
  logger.info("Group-guard: blacklisted and kicked the actor", {
    chatId,
    actor,
    name,
    kind,
    kicked: result.kicked,
    skipped: result.skipped,
  });
}

// Chats whose snapshot has been seeded once from live settings, so a later
// name/picture change has an "old value" to revert to. Lazy: the first message
// seen from a chat triggers a one-time fetch (before any tampering, in the
// common case where benign traffic precedes an attack).
const seededChats = new Set<string>();

async function maybeSeedSnapshot(chatId: string): Promise<void> {
  if (seededChats.has(chatId)) return;
  seededChats.add(chatId); // claim synchronously so concurrent messages don't double-fetch
  try {
    const settings = await fetchChatSettings(chatId);
    if (settings) updateSnapshot(chatId, settings);
  } catch {
    seededChats.delete(chatId); // allow a retry on the next message
  }
}

async function handleNameChange(chatId: string, ev: GroupEvent, actor: string): Promise<void> {
  const enabled = await isGroupCommandEnabled(chatId, KEY.name);
  // Keep the snapshot current even when the guard is off (so a later "on" has a
  // good value) and on any exempt/legit change.
  if (!enabled || (await isExempt(actor))) {
    if (ev.newName) updateSnapshot(chatId, { name: ev.newName });
    return;
  }
  if (!(await claimEvent(`antiname:${chatId}:${actor}`, CLAIM_TTL_MS))) return;

  const old = getSnapshot(chatId)?.name;
  try {
    if (old && old !== ev.newName) {
      await revertChatName(chatId, old);
    } else if (!old) {
      logger.warn("Group-guard antiname: no snapshot to revert to (cold start)", { chatId });
    }
    await punish(chatId, actor, PUNISH_REASON.name, "name");
  } catch (error) {
    logger.error("Group-guard antiname failed", {
      chatId,
      actor,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handlePictureChange(chatId: string, actor: string): Promise<void> {
  const enabled = await isGroupCommandEnabled(chatId, KEY.picture);
  if (!enabled || (await isExempt(actor))) {
    // Refresh the snapshot to the new (legitimate) picture so a later attack
    // reverts to the right one. The event carries no picturePath, so re-fetch.
    const settings = await fetchChatSettings(chatId);
    if (settings?.picturePath) updateSnapshot(chatId, { picturePath: settings.picturePath });
    return;
  }
  if (!(await claimEvent(`antipicture:${chatId}:${actor}`, CLAIM_TTL_MS))) return;

  const old = getSnapshot(chatId)?.picturePath;
  try {
    if (old) {
      await revertChatPicture(chatId, old);
    } else {
      logger.warn("Group-guard antipicture: no snapshot to revert to (cold start)", { chatId });
    }
    await punish(chatId, actor, PUNISH_REASON.picture, "picture");
  } catch (error) {
    logger.error("Group-guard antipicture failed", {
      chatId,
      actor,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleInvite(chatId: string, ev: GroupEvent, actor: string): Promise<void> {
  if (!(await isGroupCommandEnabled(chatId, KEY.invite))) return;
  if (await isExempt(actor)) return;
  if (!(await claimEvent(`antiinvite:${chatId}:${actor}:${ev.invitee ?? ""}`, CLAIM_TTL_MS))) return;

  try {
    // Undo the invite if it's still pending; a no-op if the invitee already
    // joined (the punishment still targets the inviter regardless).
    if (ev.invitee) await cancelInvitations(chatId, [ev.invitee]);
    await punish(chatId, actor, PUNISH_REASON.invite, "invite");
  } catch (error) {
    logger.error("Group-guard antiinvite failed", {
      chatId,
      actor,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleGroupLink(chatId: string, actor: string): Promise<void> {
  if (!(await isGroupCommandEnabled(chatId, KEY.grouplink))) return;
  if (await isExempt(actor)) return;
  if (!(await claimEvent(`antigrouplink:${chatId}:${actor}`, CLAIM_TTL_MS))) return;

  try {
    // Re-disable the link and reissue the ticket so any URL/QR grabbed while it
    // was briefly open stops working. The bot's own updateChat re-emits a
    // (harmless, unmapped) C_SP, so no echo.
    await disableInviteLink(chatId);
    await punish(chatId, actor, PUNISH_REASON.grouplink, "grouplink");
  } catch (error) {
    logger.error("Group-guard antigrouplink failed", {
      chatId,
      actor,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleCancelInvite(chatId: string, ev: GroupEvent, actor: string): Promise<void> {
  if (!(await isGroupCommandEnabled(chatId, KEY.cancelinvite))) return;
  if (await isExempt(actor)) return;
  if (!(await claimEvent(`anticancelinvite:${chatId}:${actor}:${ev.invitee ?? ""}`, CLAIM_TTL_MS)))
    return;

  try {
    // Restore the invite the member wrongly cancelled. The bot's re-invite
    // emits a C_MI with from=bot → isOwnMessage skip, so antiinvite won't fire.
    if (ev.invitee) await reinviteToChat(chatId, [ev.invitee]);
    await punish(chatId, actor, PUNISH_REASON.cancelinvite, "cancelinvite");
  } catch (error) {
    logger.error("Group-guard anticancelinvite failed", {
      chatId,
      actor,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Notes and albums — punish-only (no revert primitive). */
async function handleNoteOrAlbum(
  chatId: string,
  kind: "note" | "album",
  actor: string,
): Promise<void> {
  if (!(await isGroupCommandEnabled(chatId, KEY[kind]))) return;
  if (await isExempt(actor)) return;
  if (!(await claimEvent(`${KEY[kind]}:${chatId}:${actor}`, CLAIM_TTL_MS))) return;

  try {
    await punish(chatId, actor, PUNISH_REASON[kind], kind);
  } catch (error) {
    logger.error(`Group-guard ${KEY[kind]} failed`, {
      chatId,
      actor,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleGroupGuard(message: RawMessage): Promise<void> {
  // The bot's own revert re-emits a C_PN/C_PI — skipping own messages both
  // prevents an infinite revert echo and stops the bot punishing itself.
  if (message.isOwnMessage) return;

  const meta = readContentMetadata(message);
  const event = detectGroupEvent(message.contentType, meta);
  // Seed the revert snapshot from benign traffic before any tamper event, so a
  // later name/picture change has an old value to restore. Only bother for
  // chats we might actually guard (i.e. once we see any group event or message
  // there); cheap and idempotent.
  void maybeSeedSnapshot(message.chatId);
  if (!event) return;

  // CHATEVENT carries the actor in LOC_ARGS; note/album carry it as `from`.
  const actor = event.actor || message.senderId;
  if (!actor) return;

  switch (event.kind) {
    case "name":
      return handleNameChange(message.chatId, event, actor);
    case "picture":
      return handlePictureChange(message.chatId, actor);
    case "invite":
      return handleInvite(message.chatId, event, actor);
    case "grouplink":
      return handleGroupLink(message.chatId, actor);
    case "cancelinvite":
      return handleCancelInvite(message.chatId, event, actor);
    case "note":
      return handleNoteOrAlbum(message.chatId, "note", actor);
    case "album":
      return handleNoteOrAlbum(message.chatId, "album", actor);
  }
}

const GUARD_KINDS: GroupEventKind[] = [
  "name",
  "picture",
  "invite",
  "grouplink",
  "cancelinvite",
  "note",
  "album",
];

function kindForCommand(command: string): GroupEventKind | null {
  const entry = GUARD_KINDS.find((k) => KEY[k] === command);
  return entry ?? null;
}

export function createGroupGuardFeature(): Feature {
  onRawMessage(handleGroupGuard);

  return {
    name: "group-guard",
    commands: GUARD_KINDS.map((k) => KEY[k]),
    description:
      "🛡️ กันแก้กลุ่ม (เปลี่ยนชื่อ/รูป/เชิญ/โน๊ต/อัลบั้ม) — !antiname on|off ฯลฯ",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      const kind = kindForCommand(cmd.name);
      if (!kind) return; // unreachable — only registered keys dispatch here

      const arg = (cmd.args[0] ?? "").toLowerCase();
      if (arg !== "on" && arg !== "off") {
        const enabled = await isGroupCommandEnabled(cmd.chatId, KEY[kind]);
        await sendBotMessage(
          cmd.chatId,
          `🛡️ ${TH_LABEL[kind]}: ${enabled ? "เปิด" : "ปิด"}\nใช้ !${KEY[kind]} on หรือ !${KEY[kind]} off`,
        );
        return;
      }

      await setGroupCommandEnabled(cmd.chatId, KEY[kind], arg === "on", cmd.senderId);
      const revertNote =
        kind === "note" || kind === "album"
          ? " (เตะ+ดำคนทำ — ลบตัวโน๊ต/อัลบั้มเองไม่ได้)"
          : "";
      await sendBotMessage(
        cmd.chatId,
        arg === "on"
          ? `🛡️ เปิด${TH_LABEL[kind]}แล้ว — ใครที่ไม่ใช่แอดมินทำ จะถูกแบนและเตะออกทันที${revertNote}`
          : `🛡️ ปิด${TH_LABEL[kind]}แล้ว`,
      );
    },
  };
}
