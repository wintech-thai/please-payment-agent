/**
 * rlbotline Worker — Anti-Media Feature ("กันสมาชิกส่งสื่อ")
 *
 * Punishes non-admins who send blocked media into a guarded group:
 * blacklist (fleet-wide) + kick, same sequence as anti-call. LINE offers no
 * way to delete someone else's message (`unsendMessage` succeeds only on the
 * bot's own), so punishing the sender IS the enforcement — the message itself
 * stays.
 *
 * Covers seven media types behind one master toggle:
 *   image · video · sticker · contact · file · flex · post (shared VOOM post)
 *
 * Toggle model — master + OPT-OUT subs (the reverse of anti-kick's opt-in
 * subs): `antimedia` on ⇒ every type is blocked unless its sub-toggle row
 * (`antimediaimage` … `antimediapost`) explicitly says `enabled: false`. An
 * UNSET sub means "blocked", so ticking the single master guards everything
 * at once; subs exist only to exempt a type. `isGroupCommandEnabled` can't
 * express that (unset ⇒ false), so `resolveSubToggle` reads the raw rows from
 * `getGroupCommandToggles` and applies chat row → `'*'` row → **true**.
 *
 * Detection is deliberately conservative — a kick can't be un-done. The two
 * numeric contentType tables in this repo (intercept.ts vs anti-unsend.ts)
 * contradict each other on 6/7/13/14/15, so a bare unconfirmed numeric NEVER
 * fires; only the string wire labels (the form live captures actually show,
 * e.g. "CALL" in .req/call.md) and contentMetadata signatures do. The sole
 * trusted numerics are IMAGE=1 / VIDEO=2, the two codes both tables agree on.
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
  getGroupCommandToggles,
  claimEvent,
  CLAIM_TTL_MS,
  type GroupCommandToggleRecord,
} from "../core/database.js";
import { sleep } from "../core/rate-limiter.js";
import { onRawMessage, type RawMessage } from "../core/event-router.js";
import { isRawOpLogEnabled } from "../core/raw-op-logger.js";
import { PermissionRole, type Feature, type BotCommand } from "../types.js";
import type { TalkMessage } from "@evex/linejs";

export type MediaTypeKey =
  | "image"
  | "video"
  | "sticker"
  | "contact"
  | "file"
  | "flex"
  | "post";

export const MEDIA_TYPE_KEYS: readonly MediaTypeKey[] = [
  "image",
  "video",
  "sticker",
  "contact",
  "file",
  "flex",
  "post",
] as const;

const MASTER_KEY = "antimedia";

/** Toggle key for a sub-type: `antimediaimage`, `antimediasticker`, … */
export function subToggleKey(type: MediaTypeKey): string {
  return `${MASTER_KEY}${type}`;
}

const TYPE_LABEL_TH: Record<MediaTypeKey, string> = {
  image: "รูป",
  video: "วีดีโอ",
  sticker: "สติ๊กเกอร์",
  contact: "คอนแทค",
  file: "ไฟล์",
  flex: "FLEX",
  post: "แชร์โพส",
};

type ContentMetadata = Record<string, string | undefined>;

/**
 * Wire string labels per type. Live traffic decodes contentType to the Thrift
 * enum NAME (see anti-call's "CALL" capture), so these are the primary signal.
 */
const TYPE_LABELS: Record<MediaTypeKey, string[]> = {
  image: ["IMAGE"],
  video: ["VIDEO"],
  sticker: ["STICKER"],
  contact: ["CONTACT"],
  file: ["FILE"],
  // FLEX and shared posts have no dedicated contentType — they ride on
  // 0/"NONE" and are identified purely by contentMetadata.
  flex: [],
  post: [],
};

/** The only numerics both in-repo tables agree on — everything else is disputed. */
const TRUSTED_NUMERIC: Record<number, MediaTypeKey> = {
  1: "image",
  2: "video",
};

/**
 * contentMetadata signatures per type. Real traffic always carries the string
 * `contentType` label (confirmed for image/video/sticker/contact/file/post via
 * the watch/forward capture — see .research/line-op-type-verification.md), so
 * these signatures are a fallback for the hypothetical numeric-only case plus
 * the primary path for the two types with NO dedicated contentType label
 * (flex + shared post, which ride "NONE"/"POSTNOTIFICATION"):
 *  - sticker: STKID + STKPKGID (confirmed)
 *  - file:    FILE_EXPIRE_TIMESTAMP — the file-only discriminator. A real FILE
 *             carries FILE_SIZE/OID/SID but NOT FILE_NAME (confirmed), and
 *             IMAGE/VIDEO also carry FILE_SIZE, so keying on FILE_SIZE would
 *             misclassify a photo. FILE_EXPIRE_TIMESTAMP is present on files
 *             and absent on image/video.
 *  - contact: top-level `mid` + `displayName` (confirmed; mentions use the
 *             MENTION key, not these, so requiring BOTH keeps text safe)
 *  - flex:    FLEX_VER / FLEX_JSON (best-known; not yet captured live — a
 *             normal user can't compose Flex from the app, it's OA/bot-pushed)
 *  - post:    a shared VOOM post rides `contentType POSTNOTIFICATION`,
 *             `locKey = BH`, `serviceType = MH` (personal-home post permalink
 *             `.../home/post?userMid=...&postId=...`) — CONFIRMED via capture.
 *             Must match BOTH `locKey` and `serviceType`: `postEndUrl` alone is
 *             NOT specific (group NOTES ride BG/GB and ALBUMS ride BA/AB, both
 *             also carry postEndUrl), so keying on it would kick a member for
 *             creating a note/album. Notes/albums are handled by their own
 *             Phase B guards (group-guard.ts), never by anti-media.
 */
function metadataSignature(meta: ContentMetadata): MediaTypeKey | null {
  if (meta.STKID !== undefined && meta.STKPKGID !== undefined) return "sticker";
  if (meta.FILE_EXPIRE_TIMESTAMP !== undefined) return "file";
  if (meta.FLEX_VER !== undefined || meta.FLEX_JSON !== undefined) return "flex";
  // BH+MH = shared VOOM post; NOT BG/GB (note) or BA/AB (album) — those carry
  // postEndUrl too, so this pair, not postEndUrl, is the safe discriminator.
  if (meta.locKey === "BH" && meta.serviceType === "MH") return "post";
  if (meta.mid !== undefined && meta.displayName !== undefined) return "contact";
  return null;
}

/**
 * The whole trigger decision — exported for unit testing.
 * Returns the detected media type, or null for anything this feature must
 * leave alone (plain text, calls, chat events, unconfirmed numerics).
 */
export function detectMediaType(
  contentType: number | string,
  metadata: ContentMetadata | undefined,
): MediaTypeKey | null {
  // Never touch the message kinds other features own.
  if (contentType === "CALL" || contentType === "CHATEVENT") return null;

  if (typeof contentType === "string") {
    for (const type of MEDIA_TYPE_KEYS) {
      if (TYPE_LABELS[type].includes(contentType)) return type;
    }
  } else if (contentType !== 0) {
    const trusted = TRUSTED_NUMERIC[contentType];
    if (trusted) return trusted;
    // Disputed numeric (6/7/13/14/15…): fall through — only a metadata
    // signature may still identify it. Never fire on the number alone.
  }

  if (metadata) return metadataSignature(metadata);
  return null;
}

/**
 * OPT-OUT sub-toggle resolution — exported for unit testing.
 * Chat row → `'*'` default row → true (blocked). Only consulted when the
 * master is already on; polarity documented in docs/api-spec.md §2a.
 */
export function resolveSubToggle(
  chatRows: readonly GroupCommandToggleRecord[],
  defaultRows: readonly GroupCommandToggleRecord[],
  key: string,
): boolean {
  const lower = key.toLowerCase();
  const chatRow = chatRows.find((t) => t.command.toLowerCase() === lower);
  if (chatRow) return chatRow.enabled;
  const defaultRow = defaultRows.find((t) => t.command.toLowerCase() === lower);
  if (defaultRow) return defaultRow.enabled;
  return true;
}

/** Effective per-type state for a chat; empty set when the master is off. */
async function activeMediaTypes(chatId: string): Promise<Set<MediaTypeKey>> {
  const active = new Set<MediaTypeKey>();
  if (!(await isGroupCommandEnabled(chatId, MASTER_KEY))) return active;

  const chatRows = await getGroupCommandToggles(chatId);
  const defaultRows = chatId === "*" ? [] : await getGroupCommandToggles("*");
  for (const type of MEDIA_TYPE_KEYS) {
    if (resolveSubToggle(chatRows, defaultRows, subToggleKey(type))) active.add(type);
  }
  return active;
}

function readContentMetadata(message: RawMessage): ContentMetadata | undefined {
  // Same access path as anti-call: RawMessage.raw is the linejs TalkMessage,
  // whose own `.raw` is the wire Message struct.
  return (message.raw as TalkMessage & { raw?: { contentMetadata?: ContentMetadata } }).raw
    ?.contentMetadata;
}

/** Who is never punished: this bot, admins/owners, and sibling fleet bots. */
async function isExempt(mid: string): Promise<boolean> {
  if (!mid) return true;
  if (mid === getKnownBotMid()) return true;
  if (await hasPermission(mid, PermissionRole.ADMIN)) return true;
  return isFleetMember(mid);
}

function isTextContentType(contentType: number | string): boolean {
  return contentType === 0 || contentType === "NONE" || contentType === "TEXT";
}

async function handleAntiMedia(message: RawMessage): Promise<void> {
  if (message.isOwnMessage) return;

  const metadata = readContentMetadata(message);

  // Capture aid, active only alongside RAW_OP_LOG sessions: record every
  // non-text message's contentType form + metadata keys so the disputed
  // numeric table and the unconfirmed flex/post signatures can be verified
  // against live traffic without a debugger attached.
  if (isRawOpLogEnabled() && !isTextContentType(message.contentType)) {
    logger.info("Anti-media capture: non-text message observed", {
      chatId: message.chatId,
      contentType: message.contentType,
      contentTypeKind: typeof message.contentType,
      metadataKeys: metadata ? Object.keys(metadata) : [],
    });
  }

  const type = detectMediaType(message.contentType, metadata);
  if (!type) return;

  const active = await activeMediaTypes(message.chatId);
  if (!active.has(type)) return;

  const senderMid = message.senderId;
  if (await isExempt(senderMid)) return;

  // One bot per fleet acts — keyed on the message id, identical for every
  // sibling that sees it (same rationale as anti-call).
  if (!(await claimEvent(`antimedia:${message.chatId}:${message.id}`, CLAIM_TTL_MS))) return;

  // Same sequence as anti-call: blacklist first (fleet-wide, so join-guard
  // auto-kicks any rejoin where enabled), pause, then kick. Silent — the
  // feature moderates but doesn't announce itself.
  const botMid = getKnownBotMid();
  try {
    const name = await resolveDisplayName(senderMid);
    await addToBlacklist(senderMid, name, `auto: sent blocked media (${type})`, botMid || "system");
    await sleep(500);
    const result = await kickFromGroup(message.chatId, [senderMid]);
    logger.info("Anti-media: blacklisted and kicked the sender", {
      chatId: message.chatId,
      senderMid,
      name,
      mediaType: type,
      kicked: result.kicked,
      skipped: result.skipped,
    });
  } catch (error) {
    logger.error("Anti-media: failed to blacklist/kick the sender", {
      chatId: message.chatId,
      senderMid,
      mediaType: type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseTypeArg(arg: string): MediaTypeKey | null {
  return (MEDIA_TYPE_KEYS as readonly string[]).includes(arg) ? (arg as MediaTypeKey) : null;
}

async function replyStatus(chatId: string): Promise<void> {
  const masterOn = await isGroupCommandEnabled(chatId, MASTER_KEY);
  const active = await activeMediaTypes(chatId);
  const lines = MEDIA_TYPE_KEYS.map(
    (t) => `• ${TYPE_LABEL_TH[t]}: ${active.has(t) ? "กัน" : "ไม่กัน"}`,
  );
  await sendBotMessage(
    chatId,
    [
      `🛡️ กันสมาชิกส่งสื่อ: ${masterOn ? "เปิด" : "ปิด"}`,
      ...lines,
      "ใช้ !antimedia on|off | !antimedia <ชนิด> on|off",
      `ชนิด: ${MEDIA_TYPE_KEYS.join(" | ")}`,
    ].join("\n"),
  );
}

export function createAntiMediaFeature(): Feature {
  // Same shape as anti-call: the factory registers the raw-message listener,
  // so `registerFeature(createAntiMediaFeature())` is the only wiring.
  onRawMessage(handleAntiMedia);

  return {
    name: "anti-media",
    // The seven sub-keys are registered as commands so the dashboard toggle
    // grid (built from the command catalog) can reach them — anti-kick
    // precedent. `!antimediaimage on|off` and `!antimedia image on|off` write
    // the same row.
    commands: [MASTER_KEY, ...MEDIA_TYPE_KEYS.map(subToggleKey)],
    description:
      "🛡️ กันสมาชิกส่งสื่อ (รูป/วีดีโอ/สติ๊กเกอร์/คอนแทค/ไฟล์/FLEX/แชร์โพส) — !antimedia on|off",

    async handleCommand(cmd: BotCommand): Promise<void> {
      if (!(await hasPermission(cmd.senderId, PermissionRole.ADMIN))) {
        await sendBotMessage(cmd.chatId, "❌ ต้องเป็น Admin ขึ้นไปเพื่อใช้คำสั่งนี้");
        return;
      }

      // Direct sub-toggle form: !antimediaimage on|off
      if (cmd.name !== MASTER_KEY) {
        const type = parseTypeArg(cmd.name.slice(MASTER_KEY.length));
        if (!type) return; // unreachable: only registered sub-keys dispatch here
        const arg = (cmd.args[0] ?? "").toLowerCase();
        if (arg !== "on" && arg !== "off") {
          await replyStatus(cmd.chatId);
          return;
        }
        await setGroupCommandEnabled(cmd.chatId, subToggleKey(type), arg === "on", cmd.senderId);
        await sendBotMessage(
          cmd.chatId,
          arg === "on"
            ? `🛡️ เปิดกันส่ง${TYPE_LABEL_TH[type]}แล้ว (มีผลเมื่อ !antimedia เปิดอยู่)`
            : `🛡️ ยกเว้น${TYPE_LABEL_TH[type]}แล้ว — ชนิดอื่นยังถูกกันตามเดิม`,
        );
        return;
      }

      const first = (cmd.args[0] ?? "").toLowerCase();

      if (first === "on" || first === "off") {
        await setGroupCommandEnabled(cmd.chatId, MASTER_KEY, first === "on", cmd.senderId);
        await sendBotMessage(
          cmd.chatId,
          first === "on"
            ? "🛡️ เปิดกันสมาชิกส่งสื่อแล้ว — ใครที่ไม่ใช่แอดมินส่งสื่อที่ถูกกัน จะถูกแบนและเตะออกจากกลุ่มทันที (ยกเว้นบางชนิดได้ด้วย !antimedia <ชนิด> off)"
            : "🛡️ ปิดกันสมาชิกส่งสื่อแล้ว",
        );
        return;
      }

      // Per-type form: !antimedia sticker off
      const type = parseTypeArg(first);
      if (type) {
        const arg = (cmd.args[1] ?? "").toLowerCase();
        if (arg !== "on" && arg !== "off") {
          await replyStatus(cmd.chatId);
          return;
        }
        await setGroupCommandEnabled(cmd.chatId, subToggleKey(type), arg === "on", cmd.senderId);
        await sendBotMessage(
          cmd.chatId,
          arg === "on"
            ? `🛡️ เปิดกันส่ง${TYPE_LABEL_TH[type]}แล้ว (มีผลเมื่อ !antimedia เปิดอยู่)`
            : `🛡️ ยกเว้น${TYPE_LABEL_TH[type]}แล้ว — ชนิดอื่นยังถูกกันตามเดิม`,
        );
        return;
      }

      await replyStatus(cmd.chatId);
    },
  };
}
