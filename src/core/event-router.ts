/**
 * rlbotline Worker — Event Router
 *
 * Subscribes to LINE client events and dispatches them to feature handlers.
 * Handles command parsing, error isolation, and operation routing.
 */

import { logger } from "./logger.js";
import { getClient, getKnownBotMid, sendBotMessage } from "./line-client.js";
import {
  hasPermission,
  isGroupCommandEnabled,
  isGroupAuthorizedUser,
  isFleetMember,
  getAdmin,
  claimEvent,
  CLAIM_TTL_MS,
} from "./database.js";
import { sleep } from "./rate-limiter.js";
import { runInCommandContext } from "./command-context.js";
import type { TalkMessage } from "@evex/linejs";
import { PermissionRole } from "../types.js";
import type { BotCommand, Feature, WorkerConfig } from "../types.js";

/** Registry of features by command name */
const commandHandlers: Map<string, Feature> = new Map();

/**
 * Commands that are still allowed when typed directly in LINE chat regardless of
 * per-group command toggles. `help`/`h`/`ping` are universally usable; the four
 * group-permissions escape-hatch commands remain internally gated by
 * `hasPermission(..., PermissionRole.ADMIN)` inside `group-permissions.ts`, so
 * exempting them here cannot be abused by non-admins — it only prevents a group
 * from permanently locking itself out of its own unlock commands.
 */
const CHAT_COMMAND_ALLOWLIST = new Set([
  "help",
  "h",
  "ping",
  "groupcmd",
  "authorize",
  "unauthorize",
  "listauthorized",
]);

/** Registry of all features (for help command) */
const allFeatures: Feature[] = [];

/** Raw message listeners (features that need every message, not just commands) */
type RawMessageListener = (message: RawMessage) => Promise<void>;
const rawMessageListeners: RawMessageListener[] = [];

/** Operation listeners (for non-message events like unsend, join, leave) */
type OperationListener = (operation: RawOperation) => Promise<void>;
const operationListeners: OperationListener[] = [];

/** Simplified message shape exposed to features */
export interface RawMessage {
  id: string;
  chatId: string;
  senderId: string;
  text: string;
  contentType: number | string;
  isOwnMessage: boolean;
  /** The original linejs TalkMessage for advanced use */
  raw: TalkMessage;
  /** Reply helper */
  reply: (text: string) => Promise<void>;
}

/** Simplified operation shape exposed to features */
export interface RawOperation {
  /**
   * Raw LINE op-type string (e.g. "DELETE_OTHER_FROM_CHAT"). Confirmed via
   * live `RAW_OP_LOG` capture to always be a string on the wire — never
   * coerce this with `Number()` (that silently produces `NaN` and breaks
   * every `op.type === LineOpType.X` comparison downstream).
   */
  type: string;
  param1: string;
  param2: string;
  param3: string;
  raw: unknown;
}

/** Actor/target pair resolved from a CHATEVENT system-message announcement. */
export interface ChatEventActorTarget {
  chatId: string;
  actorMid: string;
  targetMid: string;
  /** "C_MR" (member removed/kick) or "C_MI" (member invited). */
  locKey: string;
}

/**
 * LOC_KEY values for the CHATEVENT announcements that carry an actor+target
 * pair: "C_MR" = member removed (kick), "C_MI" = member invited.
 */
const CHATEVENT_ACTOR_TARGET_LOC_KEYS = new Set(["C_MR", "C_MI"]);

/**
 * Best-effort extraction of `{chatId, actorMid, targetMid}` from a
 * `SEND_MESSAGE`/`RECEIVE_MESSAGE` op whose `message.contentType` is
 * "CHATEVENT" and `contentMetadata.LOC_KEY` is "C_MR" (kick) or "C_MI"
 * (invite). `LOC_ARGS` is `"${actorMid}${targetMid}"` (record
 * separator-joined) — confirmed order via live capture (actor first).
 * Returns null for any op that isn't a matching CHATEVENT.
 */
export function extractChatEventActorTarget(op: RawOperation): ChatEventActorTarget | null {
  const raw = op.raw as
    | {
        message?: {
          to?: string;
          contentType?: string | number;
          contentMetadata?: Record<string, string>;
        };
      }
    | undefined;
  const message = raw?.message;
  if (!message || message.contentType !== "CHATEVENT") return null;

  const metadata = message.contentMetadata;
  const locKey = metadata?.["LOC_KEY"];
  if (!locKey || !CHATEVENT_ACTOR_TARGET_LOC_KEYS.has(locKey)) return null;

  const locArgs = metadata?.["LOC_ARGS"];
  if (!locArgs) return null;

  const [actorMid, targetMid] = locArgs.split("");
  const chatId = message.to ?? "";
  if (!chatId || !actorMid || !targetMid) return null;

  return { chatId, actorMid, targetMid, locKey };
}

/**
 * Tiny TTL cache — evicts lazily on read. Used to correlate a
 * `DELETE_OTHER_FROM_CHAT` op (no kicker identity) with the CHATEVENT
 * announcement that carries it, which may arrive slightly before or after.
 *
 * Self-bounding: entries are evicted lazily on read, but a key that is never
 * read (an orphaned correlation whose partner op never arrives) would leak
 * forever — so `set()` also sweeps expired entries and caps total size. This
 * matters because the worker runs `restart unless-stopped` under a 256MB limit.
 */
export class ShortTtlCache<V> {
  private readonly store = new Map<string, { value: V; at: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 500) {}

  set(key: string, value: V): void {
    this.store.set(key, { value, at: Date.now() });
    if (this.store.size > this.maxEntries) {
      this.sweep();
      // Map preserves insertion order — drop oldest until back under the cap.
      while (this.store.size > this.maxEntries) {
        const oldest = this.store.keys().next().value;
        if (oldest === undefined) break;
        this.store.delete(oldest);
      }
    }
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Drop all entries past their TTL. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.at > this.ttlMs) this.store.delete(key);
    }
  }
}

let commandPrefix = "!";

/** This bot's own `INSTANCE_ID`, set by `initEventRouter`. Backs the responder binding. */
let ownInstanceId = "";

/**
 * How long a non-preferred bot waits before racing for an admin's command.
 *
 * This window IS the liveness check. The bot that created an admin claims at
 * t=0; every sibling sleeps first, so in the normal case the preferred bot has
 * already won and they lose the claim and stand down. If it is gone — container
 * down, logged out, or simply not in this group — nobody claims at t=0 and after
 * the grace the siblings race, so one of them answers instead. No heartbeat, no
 * roster lookup, and nothing to get stale.
 *
 * MUST stay well below `CLAIM_TTL_MS` (3000ms): the preferred bot's claim has to
 * still be held when the siblings try, or they would each win a fresh claim and
 * the admin would get N replies — the exact thing this prevents. 1200ms leaves
 * room for a slow `/state/*` round-trip on the preferred bot while keeping
 * failover latency to something an operator reads as "a beat late", not "broken".
 */
export const ADMIN_RESPONDER_GRACE_MS = 1200;

/** Test seam: `initEventRouter` normally sets this from `WorkerConfig`. */
export function setOwnInstanceIdForTest(instanceId: string): void {
  ownInstanceId = instanceId;
}

export function resolveMessageChatId(
  toId: string,
  fromId: string,
  selfMid: string,
): string {
  if (!toId) return fromId;
  if (!fromId) return toId;

  const isDirectChat = toId.startsWith("u") && fromId.startsWith("u") && toId !== fromId;
  if (!isDirectChat) return toId;

  if (selfMid) {
    if (toId === selfMid) return fromId;
    if (fromId === selfMid) return toId;
  }

  return fromId;
}

export function normalizeRawContentType(value: unknown): number | string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : trimmed;
  }

  return 0;
}

function extractMessageText(message: TalkMessage): string {
  const directText = message.text ?? "";
  if (directText.trim().length > 0) {
    return directText;
  }

  const stringifyStructured = (value: unknown): string => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return "";
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return trimmed;
      }
    }

    if (value && typeof value === "object") {
      try {
        const serialized = JSON.stringify(value, null, 2);
        return serialized === "{}" ? "" : serialized;
      } catch {
        return "";
      }
    }

    return typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  };

  try {
    const flex = message.getFlex();
    const flexJson = stringifyStructured(flex.flexJson);
    if (flexJson) {
      return flexJson;
    }
    if (flex.altText?.trim()) {
      return flex.altText.trim();
    }
  } catch {
    // Not a flex message.
  }

  const metadata = (message.raw as { contentMetadata?: Record<string, string> }).contentMetadata;
  if (!metadata) {
    return "";
  }

  const preferredStructured =
    stringifyStructured(metadata["HTML"]) ||
    stringifyStructured(metadata["FLEX_JSON"]) ||
    stringifyStructured(metadata["RICH_JSON"]) ||
    stringifyStructured(metadata["MESSAGE"]);
  if (preferredStructured) {
    return preferredStructured;
  }

  const altText = stringifyStructured(metadata["ALT_TEXT"]);
  if (altText) {
    return altText;
  }

  return stringifyStructured(metadata);
}

/**
 * Register a feature module with the event router.
 */
export function registerFeature(feature: Feature): void {
  allFeatures.push(feature);

  for (const cmd of feature.commands) {
    const lower = cmd.toLowerCase();
    if (commandHandlers.has(lower)) {
      logger.warn("Duplicate command registration, overwriting", {
        command: lower,
        feature: feature.name,
      });
    }
    commandHandlers.set(lower, feature);
  }

  logger.info("Registered feature", {
    name: feature.name,
    commands: feature.commands,
  });
}

/**
 * Register a listener that receives every incoming message (not just commands).
 * Used by features like anti-unsend that need to cache all messages.
 */
export function onRawMessage(listener: RawMessageListener): void {
  rawMessageListeners.push(listener);
}

/**
 * Register a listener for raw LINE operations (unsend, join, leave, etc.).
 */
export function onOperation(listener: OperationListener): void {
  operationListeners.push(listener);
}

/**
 * Parse a message into a BotCommand if it starts with the command prefix.
 */
function parseCommand(
  text: string,
  chatId: string,
  senderId: string,
  messageId: string,
): BotCommand | null {
  if (!text.startsWith(commandPrefix)) {
    return null;
  }

  const withoutPrefix = text.slice(commandPrefix.length).trim();
  if (withoutPrefix.length === 0) {
    return null;
  }

  const parts = withoutPrefix.split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1);

  return {
    name,
    args,
    rawText: text,
    chatId,
    senderId,
    messageId,
    mentionedMids: [],
  };
}

export interface ExecuteCommandInput {
  name: string;
  args: string[];
  chatId: string;
  senderId: string;
  messageId?: string;
  mentionedMids?: string[];
  rawText?: string;
  source?: "chat" | "ui";
}

export interface ExecuteCommandResult {
  ok: boolean;
  command: string;
  feature?: string;
  ignored?: boolean;
  reason?: string;
}

export function listRegisteredCommands(): Array<{
  name: string;
  feature: string;
  description: string;
}> {
  const dedup = new Map<string, { name: string; feature: string; description: string }>();
  for (const [name, feature] of commandHandlers.entries()) {
    if (!dedup.has(name)) {
      dedup.set(name, { name, feature: feature.name, description: feature.description });
    }
  }
  return Array.from(dedup.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Decide whether THIS bot is the one to answer an admin's chat command.
 *
 * The problem: since migration 0016 the admin table is user-scoped, so every bot
 * of a user recognises the same admin — and every bot in the group would reply.
 * The user's rule is that the bot which created the admin answers, and if that
 * bot is gone another takes over.
 *
 * Both halves fall out of one biased claim. The preferred bot claims
 * immediately; siblings sleep `ADMIN_RESPONDER_GRACE_MS` first and therefore
 * lose — unless nobody claimed, which is precisely the case where the preferred
 * bot is dead or not in this group. Failover needs no liveness signal because
 * *not answering* is the signal.
 *
 * Non-admin senders are not gated: they were never multi-bot in the first place
 * (an authorized-user or allowlist command already reaches every bot in the
 * group, and changing that is a separate decision).
 *
 * Keyed on `messageId` — the one identifier every bot sees identically for the
 * same command. Keying on chat+sender would collapse an admin's *consecutive*
 * commands into one claim and drop the second.
 *
 * Returns true when this bot should handle the command. Exported for tests.
 */
export async function winAdminResponderClaim(
  senderId: string,
  chatId: string,
  messageId: string | undefined,
): Promise<boolean> {
  const adminRow = await getAdmin(senderId);
  if (!adminRow) return true;

  // No messageId means no key every bot agrees on (the `execute_command` RPC
  // synthesises one per bot). Answer rather than race on a key that can't
  // collide — the RPC targets a single bot anyway.
  if (!messageId) return true;

  const preferred = adminRow.addedByInstance;
  if (preferred && preferred !== ownInstanceId) {
    await sleep(ADMIN_RESPONDER_GRACE_MS);
  }

  const won = await claimEvent(`admincmd:${chatId}:${messageId}`, CLAIM_TTL_MS);
  if (!won) {
    logger.debug("Admin command claimed by another bot, standing down", {
      chatId,
      senderId,
      preferred,
    });
  }
  return won;
}

export async function executeRegisteredCommand(
  input: ExecuteCommandInput,
): Promise<ExecuteCommandResult> {
  const name = input.name.trim().toLowerCase();
  const feature = commandHandlers.get(name);
  if (!feature) {
    return {
      ok: false,
      command: name,
      reason: "unknown_command",
    };
  }

  // Features not yet confirmed against real LINE traffic are refused outright —
  // only sure features are usable (see Feature.available / op-type verification).
  if (feature.available === false) {
    return {
      ok: true,
      command: name,
      feature: feature.name,
      ignored: true,
      reason: "feature_unavailable",
    };
  }

  if (input.source !== "ui") {
    // A sibling bot's mid is an OWNER row in the shared admin table (each bot
    // bootstraps its own mid, and 0016 made that table user-scoped). Without this
    // guard bot A would obey commands typed from bot B's account, which
    // tasks/done/008 forbids outright: siblings are protected, they do not drive
    // each other. Excluding self is what keeps the operator's own bot account
    // working — that is the normal way these bots are commanded.
    //
    // Not a new restriction: while admins were instance-scoped a sibling's mid
    // was simply absent from this bot's table, so it was already refused. This
    // preserves that once the table is shared.
    //
    // `getKnownBotMid` (sync, cached) rather than `getBotMid` (async, calls
    // getProfile): this runs on every chat command, and getBotMid throws when the
    // LINE client isn't up. Before the client is ready the cached mid is "" and
    // this bot would decline its own operator's command — but commands don't flow
    // until after `ready`, and declining is the safe direction to fail.
    if (input.senderId !== getKnownBotMid() && (await isFleetMember(input.senderId))) {
      return {
        ok: true,
        command: name,
        feature: feature.name,
        ignored: true,
        reason: "sender_is_fleet_bot",
      };
    }

    const isBotAdmin = await hasPermission(input.senderId, PermissionRole.ADMIN);
    const adminChatCommandsEnabled = await isGroupCommandEnabled(input.chatId, "admincmd");
    const bypass = isBotAdmin && adminChatCommandsEnabled;

    if (!bypass && !CHAT_COMMAND_ALLOWLIST.has(name)) {
      const enabledForGroup = await isGroupCommandEnabled(input.chatId, name);
      if (!enabledForGroup) {
        return {
          ok: true,
          command: name,
          feature: feature.name,
          ignored: true,
          reason: isBotAdmin && !adminChatCommandsEnabled
            ? "admin_chat_commands_disabled"
            : "command_disabled_for_group",
        };
      }

      const senderAuthorized = await isGroupAuthorizedUser(input.chatId, input.senderId);
      if (!senderAuthorized) {
        return {
          ok: true,
          command: name,
          feature: feature.name,
          ignored: true,
          reason: "sender_not_authorized_for_group",
        };
      }
    }

    // Exactly one bot answers an admin. Runs LAST in this block, after every
    // authorization check has passed: a command that was going to be refused
    // anyway must not burn the claim, or the bot that would have answered it
    // loses to a bot that then silently drops it.
    if (!(await winAdminResponderClaim(input.senderId, input.chatId, input.messageId))) {
      return {
        ok: true,
        command: name,
        feature: feature.name,
        ignored: true,
        reason: "another_bot_is_responding",
      };
    }
  }

  const cmd: BotCommand = {
    name,
    args: input.args,
    rawText: input.rawText ?? `${commandPrefix}${name}${input.args.length > 0 ? ` ${input.args.join(" ")}` : ""}`,
    chatId: input.chatId,
    senderId: input.senderId,
    messageId: input.messageId ?? `exec-${Date.now().toString(36)}`,
    mentionedMids: input.mentionedMids ?? [],
  };

  await runInCommandContext(
    { chatId: cmd.chatId, command: name, source: input.source ?? "chat" },
    () => feature.handleCommand(cmd),
  );

  return {
    ok: true,
    command: name,
    feature: feature.name,
  };
}

/**
 * Extract mentioned MIDs from a TalkMessage.
 */
function extractMentions(message: TalkMessage): string[] {
  try {
    const mentions = message.getMentions();
    return mentions
      .filter((m) => !("all" in m && m.all === true))
      .map((m) => {
        if ("mid" in m && !m.all) {
          return m.mid;
        }
        return "";
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Initialize the event router and start processing events.
 */
export function initEventRouter(config: WorkerConfig): void {
  commandPrefix = config.commandPrefix;
  ownInstanceId = config.instanceId;

  const lineClient = getClient();

  // ── Message Handler ──
  lineClient.on("message", async (message: TalkMessage) => {
    try {
      const id = message.raw.id ?? "";
      const senderId = message.from.id ?? "";
      const chatId = resolveMessageChatId(
        message.to.id ?? "",
        senderId,
        getKnownBotMid(),
      );
      const text = extractMessageText(message);
      const contentType = normalizeRawContentType(message.raw.contentType);
      const isOwnMessage = message.isMyMessage;

      // Build the raw message
      const rawMsg: RawMessage = {
        id,
        chatId,
        senderId,
        text,
        contentType,
        isOwnMessage,
        raw: message,
        reply: async (replyText: string) => {
          try {
            await message.reply(replyText);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error("Failed to send reply", { error: errMsg, chatId });
          }
        },
      };

      // Notify all raw message listeners (e.g. message caching for anti-unsend)
      for (const listener of rawMessageListeners) {
        try {
          await listener(rawMsg);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error("Raw message listener error", { error: errMsg });
        }
      }

      // Check if this is a command
      if (text) {
        const cmd = parseCommand(text, chatId, senderId, id);
        if (cmd) {
          cmd.mentionedMids = extractMentions(message);
          const feature = commandHandlers.get(cmd.name);
          if (!feature) {
            return;
          }

          logger.debug("Dispatching command", {
            command: cmd.name,
            feature: feature.name,
            chatId,
          });

          // These two error-path replies are triggered by a chat command
          // (`source: "chat"`), so they must respect the same `cmdoutput`
          // gate as a normal reply from inside `feature.handleCommand()` —
          // both are routed through `sendBotMessage` inside the SAME command
          // context `executeRegisteredCommand` used, instead of the ungated
          // `rawMsg.reply()`. Without this, a muted bot (`cmdoutput` off)
          // stayed silent on success but posted on failure — and posted the
          // raw error text (state-API URLs, linejs `RequestError` payloads),
          // which any group member could harvest by spamming a
          // reliably-throwing command. `RawMessage.reply()` itself stays
          // ungated — it's still used for non-command-triggered paths.
          const commandCtx = { chatId: cmd.chatId, command: cmd.name, source: "chat" as const };

          try {
            const result = await executeRegisteredCommand({
              name: cmd.name,
              args: cmd.args,
              chatId: cmd.chatId,
              senderId: cmd.senderId,
              messageId: cmd.messageId,
              mentionedMids: cmd.mentionedMids,
              rawText: cmd.rawText,
              source: "chat",
            });
            if (result.ignored) {
              if (result.reason === "feature_unavailable") {
                await runInCommandContext(commandCtx, () =>
                  sendBotMessage(
                    cmd.chatId,
                    "🚧 ฟีเจอร์นี้ยังไม่พร้อมใช้งาน — รอยืนยัน op-type กับทราฟฟิกจริงก่อน",
                  ),
                );
              }
              logger.debug("Ignored chat command", {
                command: cmd.name,
                reason: result.reason,
                chatId,
              });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error("Command handler error", {
              command: cmd.name,
              feature: feature.name,
              error: errMsg,
            });

            // Static message only — never interpolate the raw error into the
            // chat reply (it can leak infrastructure detail: state-API URLs,
            // linejs RequestError payloads, etc). Full detail stays in logs.
            try {
              await runInCommandContext(commandCtx, () =>
                sendBotMessage(cmd.chatId, "❌ เกิดข้อผิดพลาดขณะประมวลผลคำสั่ง — โปรดลองใหม่ภายหลัง"),
              );
            } catch {
              // Swallow reply errors
            }
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Unhandled error in message handler", { error: errMsg });
    }
  });

  // ── Operation/Event Handler ──
  lineClient.on("event", async (operation) => {
    try {
      const op: RawOperation = {
        type: String(operation.type ?? ""),
        param1: String(operation.param1 ?? ""),
        param2: String(operation.param2 ?? ""),
        param3: String(operation.param3 ?? ""),
        raw: operation,
      };

      for (const listener of operationListeners) {
        try {
          await listener(op);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error("Operation listener error", {
            opType: op.type,
            error: errMsg,
          });
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Unhandled error in event handler", { error: errMsg });
    }
  });

  logger.info("Event router initialized", {
    prefix: commandPrefix,
    registeredCommands: Array.from(commandHandlers.keys()),
  });
}

/**
 * Get a list of all registered features (for !help command).
 */
export function getRegisteredFeatures(): Feature[] {
  return [...allFeatures];
}
