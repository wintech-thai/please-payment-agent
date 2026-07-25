/**
 * rlbotline Worker — Shared Type Definitions
 *
 * Central type registry for all modules. No runtime code here.
 */

// ─── Command System ───────────────────────────────────────────────

/** Parsed command from an incoming message */
export interface BotCommand {
  /** Command name without prefix, lowercased (e.g. "tagall") */
  name: string;
  /** Arguments after the command name */
  args: string[];
  /** Full raw text of the message */
  rawText: string;
  /** Chat/Group ID where the command was sent */
  chatId: string;
  /** Sender's LINE MID */
  senderId: string;
  /** Message ID for reply reference */
  messageId: string;
  /** Mentioned user MIDs extracted from the message, if any */
  mentionedMids: string[];
}

/** Handler function signature for a bot command */
export type CommandHandler = (cmd: BotCommand) => Promise<void>;

/** Feature registration interface */
export interface Feature {
  /** Unique feature name */
  name: string;
  /** Commands this feature handles (without prefix) */
  commands: string[];
  /** Description for help text */
  description: string;
  /**
   * Whether the feature is confirmed working against real LINE traffic.
   * Defaults to `true`. Set `false` for features that depend on an unverified
   * LINE op-type (numeric placeholder in `LineOpType`, not yet confirmed via
   * `RAW_OP_LOG` capture — see .research/line-op-type-verification.md): its
   * commands are refused and it's shown as unavailable in `!help`, so only
   * confirmed features are actually usable.
   */
  available?: boolean;
  /** Initialize the feature (called once on startup) */
  init?: () => Promise<void>;
  /** Handle a command */
  handleCommand: CommandHandler;
}

// ─── Database Models ──────────────────────────────────────────────

/** Cached message row from PostgreSQL */
export interface CachedMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  contentType: string;
  textContent: string;
  /** Extra metadata JSON (sticker info, media type, etc.) */
  metadata: string;
  createdAt: number;
}

/**
 * Admin row from PostgreSQL — user-scoped, shared across all of a user's bots
 * (migration 0016). An admin added via one bot is honoured by every sibling.
 */
export interface AdminRecord {
  uid: string;
  /** Captured display name at time of add; may be "" if unresolved. */
  name: string;
  role: PermissionRole;
  addedBy: string;
  addedAt: number;
  /**
   * `INSTANCE_ID` of the bot that created this admin — the responder binding.
   * Only that bot answers this admin's chat commands; siblings take over only
   * if it doesn't (see `resolveAdminResponder` in core/event-router.ts).
   * `""` for rows written before 0016, which simply race with no preference.
   */
  addedByInstance: string;
}

/** Blacklist row from PostgreSQL */
export interface BlacklistRecord {
  uid: string;
  /** Captured display name at time of add; may be "" if unresolved. */
  name: string;
  reason: string;
  addedBy: string;
  addedAt: number;
}

/** Settings key-value pair */
export interface SettingRecord {
  key: string;
  value: string;
}

/** Auto-reply rule record */
export interface AutoReplyRecord {
  id: number;
  chatId: string;
  keyword: string;
  response: string;
  matchType: "exact" | "contains" | "startswith";
  addedBy: string;
  addedAt: number;
}

/** Word filter record */
export interface WordFilterRecord {
  id: number;
  chatId: string;
  word: string;
  addedBy: string;
  addedAt: number;
}

/** Chat type — ใช้แบ่งระหว่างกลุ่ม / OA / เพื่อน 1-on-1 */
export type ChatType = "group" | "oa" | "user" | "room" | "square" | "unknown";

/**
 * Watched chat row from PostgreSQL.
 * บอทจะ forward เฉพาะข้อความจาก chat ที่อยู่ในตารางนี้และ enabled=true
 */
export interface WatchedChatRecord {
  chatId: string;
  chatName: string;
  chatType: ChatType;
  /** URL ภายนอกที่จะ POST ข้อความไปให้ (null = ส่งไป Central API เท่านั้น) */
  forwardUrl: string | null;
  enabled: boolean;
  addedBy: string;
  addedAt: number;
  /** Filter mode: 'none' = forward all, 'substring' = text contains pattern, 'regex' = regex match */
  filterType: 'none' | 'substring' | 'regex';
  /** Pattern string for filterType substring or regex. Empty string when filterType is 'none'. */
  filterPattern: string;
}

/** A single member captured in a group backup roster. */
export interface GroupBackupMember {
  mid: string;
  displayName: string;
}

/**
 * Group Backup + Recovery roster (task 022) — a snapshot of a group's member
 * list, refreshed by `!groupbackup on` (full scan) and incrementally by every
 * join while `groupbackup` is enabled for that chat. Consumed by the
 * `recover_group` RPC to re-invite the roster into a replacement group.
 */
export interface GroupBackupRecord {
  chatId: string;
  groupName: string;
  members: GroupBackupMember[];
}

/** Discovered chat (ผลลัพธ์จาก chat-lister, ยังไม่ถูก watch) */
export interface DiscoveredChat {
  id: string;
  name: string;
  type: ChatType;
  /** สำหรับ OA เท่านั้น — Contact.attributes value */
  attributes?: number;
}

// ─── Permissions ──────────────────────────────────────────────────

export enum PermissionRole {
  OWNER = "owner",
  ADMIN = "admin",
  USER = "user",
  BLACKLISTED = "blacklisted",
}

// ─── Webhook ──────────────────────────────────────────────────────

export type WebhookEvent =
  | "pincode"
  | "qrcode"
  | "ready"
  | "error"
  | "heartbeat"
  | "shutdown"
  | "status";

export interface WebhookPayload {
  instanceId: string;
  event: WebhookEvent;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface OutboundWebhookTarget {
  url: string;
  token?: string | null;
}

// ─── LINE Operation Types ─────────────────────────────────────────

/**
 * LINE Thrift operation types relevant to our features.
 *
 * `op.type` on the wire is a JS STRING (confirmed via live `RAW_OP_LOG`
 * capture — see `.research/line-op-type-verification.md`), not a numeric
 * code. Members below use their real string values where confirmed.
 *
 * `CREATE_CHAT` / `NOTIFIED_DESTROY_MESSAGE` are still unverified numeric
 * placeholders (no live capture yet for those events) — they will never
 * match a real (string) `op.type` until confirmed via the same capture
 * process and updated here.
 */
export enum LineOpType {
  /** A message was sent — unverified numeric placeholder, see comment above */
  RECEIVE_MESSAGE = 26,
  /** A message was unsent/destroyed — unverified numeric placeholder, see comment above */
  NOTIFIED_DESTROY_MESSAGE = 72,
  /** User accepted a group invitation (joined) — confirmed via live capture */
  NOTIFIED_ACCEPT_CHAT_INVITATION = "NOTIFIED_ACCEPT_CHAT_INVITATION",
  /** Someone invited another user into a group — confirmed via live capture */
  NOTIFIED_INVITE_INTO_CHAT = "NOTIFIED_INVITE_INTO_CHAT",
  /** Member joined right after accepting an invite — confirmed via live capture */
  NOTIFIED_JOIN_CHAT = "NOTIFIED_JOIN_CHAT",
  /** User left a group */
  NOTIFIED_LEAVE_CHAT = "NOTIFIED_LEAVE_CHAT",
  /**
   * A member was removed from a group (the real "kicked" event — renamed
   * from the old, wrong `NOTIFIED_KICKOUT_FROM_CHAT` name). Confirmed via
   * live capture. No kicker identity on this op — see `event-router.ts`'s
   * `extractChatEventActorTarget` for how the kicker is correlated.
   */
  DELETE_OTHER_FROM_CHAT = "DELETE_OTHER_FROM_CHAT",
  /** Group was created — unverified numeric placeholder, see comment above */
  CREATE_CHAT = 16,
}

// ─── Config ───────────────────────────────────────────────────────

/**
 * onix (destination server) NotifyLineMessage forward target.
 *
 * Bank-OA messages the worker watches are POSTed to
 *   {apiUrl}/admin-api/AdminAgent/org/{org}/action/NotifyLineMessage/{agentId}
 * with Basic auth ("{apiUser}:{apiKey}") and an `Onix-Application-Type` header —
 * see `src/core/onix-client.ts`. Disabled unless apiUrl + agentId + apiKey are set.
 * When apiUrl already contains the NotifyLineMessage action path it is used
 * verbatim (nothing appended) — the POST hits exactly ONIX_API_URL.
 */
export interface OnixConfig {
  /** True when apiUrl + agentId + apiKey are all present. */
  enabled: boolean;
  /**
   * onix target URL, no trailing slash. Either the API base URL (standard
   * NotifyLineMessage path gets appended) or the full endpoint including the
   * NotifyLineMessage action path (used verbatim).
   */
  apiUrl: string;
  /** Path segment used as `org/{org}` — defaults to "global". */
  org: string;
  /** onix agent UUID that receives NotifyLineMessage. */
  agentId: string;
  /** Basic auth username — defaults to "api". */
  apiUser: string;
  /** Basic auth password / API key (secret). */
  apiKey: string;
  /** Value of the `Onix-Application-Type` header — defaults to "backend". */
  appType: string;
  /** Per-request timeout for onix POSTs (ms). */
  timeoutMs: number;
}

/**
 * Redis connection used to persist the LINE session (auth token + linejs storage
 * blob w/ E2EE keys) so a restart restores the session instead of re-logging-in
 * (a fresh login rotates the device/E2EE key and repeated logins get the LINE
 * account banned). No authentication — `REDIS_HOST`/`REDIS_PORT` only. Disabled
 * when `REDIS_HOST` is unset (session then lives in memory for that run only).
 */
export interface RedisConfig {
  /** True when REDIS_HOST is present. */
  enabled: boolean;
  /** Redis host (e.g. "localhost" or the k8s service name). */
  host: string;
  /** Redis port — defaults to 6379. */
  port: number;
  /**
   * Namespace prefix for this account's session keys (`{prefix}:auth-token`,
   * `{prefix}:storage`). Containers sharing one LINE account MUST share this
   * prefix so they restore the same session instead of each logging in fresh.
   */
  keyPrefix: string;
}

export interface WorkerConfig {
  lineAuthToken: string | undefined;
  /**
   * LINE account email for email/password login, sent to the worker via the
   * `LINE_EMAIL` env var. Used only when there's no persisted auth token in
   * Redis. `undefined` (with no password) → QR login.
   */
  lineEmail: string | undefined;
  /** LINE account password for standalone login (`LINE_PASSWORD` env var). See `lineEmail`. */
  linePassword: string | undefined;
  /**
   * Message-forward sink (the generic watched-chat fan-out target). Defaults to
   * the Central API `/webhooks/forward` when `apiBaseUrl` is set; in standalone
   * mode it comes solely from `WEBHOOK_URL`. `undefined` → no default sink (only
   * per-chat forward URLs / webhook targets apply).
   */
  webhookUrl: string | undefined;
  /**
   * Central API base URL (e.g. http://api:3000). OPTIONAL — when unset the worker
   * runs fully standalone (session → Redis, watched chats → `WATCH_CHAT_IDS`) and
   * every `/state/*` / `/webhooks/*` / `/ws/sync` interaction is skipped. See
   * `centralApiEnabled`.
   */
  apiBaseUrl: string | undefined;
  /** True when `apiBaseUrl` is set — gates every Central API interaction. */
  centralApiEnabled: boolean;
  /** Redis session-persistence target. Disabled when `REDIS_HOST` is unset. */
  redis: RedisConfig;
  /**
   * Chat IDs to watch + forward in standalone mode (`WATCH_CHAT_IDS`, comma-
   * separated). Seeded straight into the in-memory watched-chats registry at boot
   * so forwarding works with no Central API. Empty when unset.
   */
  watchChatIds: string[];
  /** Per-bot bearer token used to authenticate to /state/*. */
  instanceToken: string;
  commandPrefix: string;
  instanceId: string;
  botName: string;
  device: string;
  rateLimitCalls: number;
  rateLimitWindowMs: number;
  messageRetentionHours: number;
  /** HMAC-SHA256 secret used to sign outbound watched-chat forwards (optional) */
  watchHmacSecret: string | undefined;
  /** Per-request timeout for outbound forward POSTs (ms) */
  forwardTimeoutMs: number;
  /** Max time to wait after a PIN is issued before parking the worker (ms) */
  pinWaitTimeoutMs: number;
  /** onix NotifyLineMessage forward target (bank OA → onix). Disabled when unconfigured. */
  onix: OnixConfig;
  /** LINE @handles of bank OAs to follow + watch (e.g. ["@scbconnect", "@krungthaiconnext", "@kbanklive"]). */
  bankOaHandles: string[];
  /**
   * Bank OA MIDs to watch (`BANK_OA_MIDS`, comma-separated `u...`). Unlike
   * `bankOaHandles`, these are verified against the account's contacts at boot
   * and watched as `oa` ONLY if already added — never auto-followed. A MID the
   * account has not added is skipped (the customer adds it themselves).
   */
  bankOaMids: string[];
  /**
   * Bank-OA event filter (`FILTER_EVENT`, comma-separated, e.g. "tx_in,tx_out").
   * Empty = forward every parsed bank event. Matched against `BankTx.eventType`.
   */
  filterEvent: string[];
  /** Inbound HTTP API port (login + health). 0 disables the server. */
  httpPort: number;
  /** True when httpPort > 0 — this standalone app exposes an inbound HTTP API. */
  httpApiEnabled: boolean;
  /** Basic auth user for the inbound HTTP API (default "api"). */
  httpApiUser: string;
  /** Basic auth key for the inbound HTTP API; when unset the API is unauthenticated. */
  httpApiKey: string | undefined;
  logLevel: LogLevel;
}

// ─── Logging ──────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  instanceId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}
