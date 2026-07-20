/**
 * rlbotline Worker — Anti-Call Feature ("กันสมาชิกโทรกลุ่ม")
 *
 * Punishes non-admins who start a group call: blacklist + kick the caller.
 *
 * **This kicks — by necessity.** The original design tried to merely end the
 * call via `kickoutFromGroupCall` (remove from the *call*, leave group
 * membership intact). Live testing proved LINE rejects that for a bot that
 * isn't a participant: `INVALID_STATE / "abnormal approach"`. There is no
 * host-independent "end the call" RPC, and becoming a participant needs a full
 * VoIP media stack this worker doesn't have. So the feature now does what
 * anti-kick's autokickbot does — blacklist the caller (fleet-wide) then kick
 * them from the group — which is what the operator asked for once eviction
 * turned out impossible. The blacklist is user-scoped, so join-guard (where
 * enabled) will auto-kick them on any rejoin.
 */

import { logger } from "../core/logger.js";
import {
  getKnownBotMid,
  kickFromGroup,
  resolveDisplayName,
  sendBotMessage,
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
import { sleep } from "../core/rate-limiter.js";
import { onRawMessage, type RawMessage } from "../core/event-router.js";
import { PermissionRole, type Feature, type BotCommand } from "../types.js";
import type { TalkMessage } from "@evex/linejs";

/**
 * A group call surfaces as an ordinary message op with `contentType: "CALL"` and
 * a `contentMetadata` describing the event (captured live, see `.req/call.md`):
 *
 *   GC_EVT_TYPE: "S" | "E"   — call Started / Ended
 *   TYPE:        "G"         — group call (vs. a 1:1 call)
 *   GC_MEDIA_TYPE: "AUDIO" | "VIDEO"
 *
 * `from` is the caller's mid, `to` the chat.
 */
interface CallMetadata {
  GC_EVT_TYPE?: string;
  TYPE?: string;
  GC_MEDIA_TYPE?: string;
}

/**
 * `contentType` reaches features as `number | string` — `normalizeRawContentType`
 * passes a non-numeric string through untouched, while the numeric wire form is
 * what `intercept.ts` labels as 6. Both forms are plausible depending on how the
 * op decoded, so accept either rather than betting on one and silently never
 * firing.
 */
function isCallMessage(contentType: number | string): boolean {
  return contentType === "CALL" || contentType === 6;
}

/** Exported for unit testing — this is the whole trigger decision. */
export function isGroupCallStart(contentType: number | string, metadata: CallMetadata | undefined): boolean {
  if (!isCallMessage(contentType)) return false;
  if (!metadata) return false;
  // "E" is the call *ending*. Acting on it would fire on the bot's own successful
  // eviction, so only "S" (start) counts.
  if (metadata.GC_EVT_TYPE !== "S") return false;
  // Group calls only — a 1:1 call is between two people and none of the bot's
  // business.
  return metadata.TYPE === "G";
}

function readCallMetadata(message: RawMessage): CallMetadata | undefined {
  // Same access path as `extractMessageText`: RawMessage.raw is the linejs
  // TalkMessage, whose own `.raw` is the wire Message struct.
  return (message.raw as TalkMessage & { raw?: { contentMetadata?: CallMetadata } }).raw
    ?.contentMetadata;
}

async function isEnabled(chatId: string): Promise<boolean> {
  return isGroupCommandEnabled(chatId, "anticall");
}

/**
 * Who is never evicted: admins/owners, sibling bots, and this bot itself.
 *
 * Siblings are included because a fleet bot placing a call is our own doing, and
 * `tasks/done/008` is emphatic that bots must not act against each other.
 */
async function isExempt(mid: string): Promise<boolean> {
  if (!mid) return true;
  if (mid === getKnownBotMid()) return true;
  if (await hasPermission(mid, PermissionRole.ADMIN)) return true;
  return isFleetMember(mid);
}

async function handleAntiCall(message: RawMessage): Promise<void> {
  const metadata = readCallMetadata(message);
  if (!isGroupCallStart(message.contentType, metadata)) return;
  if (!(await isEnabled(message.chatId))) return;

  const callerMid = message.senderId;
  if (await isExempt(callerMid)) return;

  // One bot per fleet acts. Without this every bot of the user in the group
  // fires the same blacklist+kick, N×-amplifying LINE API calls for no added
  // effect. Keyed on the message id — identical across every bot that sees it.
  if (!(await claimEvent(`anticall:${message.chatId}:${message.id}`, CLAIM_TTL_MS))) return;

  // Same sequence as anti-kick's autokickbot: blacklist first (fleet-wide, so a
  // rejoin is auto-kicked by join-guard where enabled), pause, then kick. Kept
  // silent like autokickbot — the feature moderates but doesn't announce itself.
  const botMid = getKnownBotMid();
  try {
    const name = await resolveDisplayName(callerMid);
    await addToBlacklist(callerMid, name, "auto: started a group call", botMid || "system");
    await sleep(500);
    const result = await kickFromGroup(message.chatId, [callerMid]);
    logger.info("Anti-call: blacklisted and kicked the caller", {
      chatId: message.chatId,
      callerMid,
      name,
      mediaType: metadata?.GC_MEDIA_TYPE,
      kicked: result.kicked,
      skipped: result.skipped,
    });
  } catch (error) {
    logger.error("Anti-call: failed to blacklist/kick the caller", {
      chatId: message.chatId,
      callerMid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createAntiCallFeature(): Feature {
  // Same shape as anti-spam/anti-link: the factory registers the raw-message
  // listener, so `registerFeature(createAntiCallFeature())` is the only wiring.
  onRawMessage(handleAntiCall);

  return {
    name: "anti-call",
    commands: ["anticall"],
    description: "📞 กันสมาชิกโทรกลุ่ม — !anticall on|off",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      const arg = (cmd.args[0] ?? "").toLowerCase();
      if (arg !== "on" && arg !== "off") {
        const enabled = await isEnabled(cmd.chatId);
        await sendBotMessage(
          cmd.chatId,
          `📞 กันสมาชิกโทรกลุ่ม: ${enabled ? "เปิด" : "ปิด"}\nใช้ !anticall on หรือ !anticall off`,
        );
        return;
      }

      await setGroupCommandEnabled(cmd.chatId, "anticall", arg === "on", cmd.senderId);
      await sendBotMessage(
        cmd.chatId,
        arg === "on"
          ? "📞 เปิดกันสมาชิกโทรกลุ่มแล้ว — ใครที่ไม่ใช่แอดมินเริ่มโทรกลุ่ม จะถูกแบนและเตะออกจากกลุ่มทันที"
          : "📞 ปิดกันสมาชิกโทรกลุ่มแล้ว",
      );
    },
  };
}
