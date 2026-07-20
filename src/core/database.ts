/**
 * rlbotline Worker — State Layer
 *
 * Public function signatures are kept identical to the previous direct-DB
 * implementation so that all callers (`features/*.ts`, etc.) need not change.
 *
 * Under the hood every call now goes through `state-client` (HTTP to the
 * Central API). Hot reads are memoised via `state-cache` (30s TTL).
 *
 * The worker NO LONGER opens a PostgreSQL connection.
 */

import { logger } from "./logger.js";
import { stateRequest, pingStateApi } from "./state-client.js";
import {
  cacheGet,
  cacheSet,
  cacheDelete,
  invalidatePrefix,
  clearCache,
  getOrFetch,
} from "./state-cache.js";
import type {
  CachedMessage,
  AdminRecord,
  BlacklistRecord,
  AutoReplyRecord,
  OutboundWebhookTarget,
  WordFilterRecord,
  PermissionRole,
  WatchedChatRecord,
  ChatType,
  GroupBackupRecord,
  GroupBackupMember,
} from "../types.js";

/**
 * Verify the Central API is reachable before the worker starts.
 * Replaces the old `initDatabase()`.
 */
export async function initDatabase(_unused?: string): Promise<void> {
  const result = await pingStateApi();
  logger.info("State API reachable", { instanceId: result.instanceId });
}

export async function closeDatabase(): Promise<void> {
  clearCache();
}

// ─── Messages ─────────────────────────────────────────────────────

export async function cacheMessage(msg: CachedMessage): Promise<void> {
  await stateRequest("/state/messages", {
    method: "POST",
    body: {
      id: msg.id,
      chatId: msg.chatId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      contentType: msg.contentType,
      textContent: msg.textContent,
      metadata: msg.metadata ?? "{}",
      createdAt: msg.createdAt,
    },
  });
  // Refresh the local cache opportunistically for anti-unsend latency.
  cacheSet(`messages:${msg.id}`, msg, 30_000);
}

export async function getCachedMessage(messageId: string): Promise<CachedMessage | null> {
  return getOrFetch(`messages:${messageId}`, async () => {
    const row = await stateRequest<CachedMessage | null>(
      `/state/messages/${encodeURIComponent(messageId)}`,
      { notFoundAsNull: true },
    );
    return row;
  });
}

export async function pruneMessages(retentionHours: number): Promise<number> {
  const olderThanMs = retentionHours * 60 * 60 * 1000;
  const res = await stateRequest<{ ok: boolean; deleted: number }>("/state/messages", {
    method: "DELETE",
    query: { olderThanMs },
  });
  const deleted = res?.deleted ?? 0;
  if (deleted > 0) {
    invalidatePrefix("messages:");
    logger.debug("Pruned old messages", { deleted, retentionHours });
  }
  return deleted;
}

// ─── Admins (user-scoped — shared across all of a user's bots) ─────
//
// Re-keyed from instance_id to user_id by migration 0016, so an admin added via
// one bot is honoured by every sibling. That is what makes "an admin is never
// kicked or blacklisted by the fleet" true: anti-spam, join-guard, anti-kick and
// sweep_blacklist already exempt admins via `hasPermission`, they were just
// reading a table only this bot could see.
//
// The responder binding (`addedByInstance`) is set by the API from the
// authenticated caller — the worker never sends it, so it cannot be spoofed by
// anything holding only an instance_id. See `winAdminResponderClaim`.

export async function setAdmin(
  uid: string,
  role: PermissionRole,
  addedBy: string,
  name = "",
): Promise<void> {
  await stateRequest(`/state/admins/${encodeURIComponent(uid)}`, {
    method: "PUT",
    body: { role, addedBy, name },
  });
  invalidatePrefix("admins:");
}

export async function removeAdmin(uid: string): Promise<boolean> {
  const res = await stateRequest<{ removed: boolean }>(
    `/state/admins/${encodeURIComponent(uid)}`,
    { method: "DELETE" },
  );
  invalidatePrefix("admins:");
  return res?.removed ?? false;
}

export async function getAdmin(uid: string): Promise<AdminRecord | null> {
  return getOrFetch(`admins:one:${uid}`, async () => {
    const row = await stateRequest<AdminRecord | null>(
      `/state/admins/${encodeURIComponent(uid)}`,
      { notFoundAsNull: true },
    );
    if (!row) return null;
    return { ...row, role: row.role as PermissionRole };
  });
}

export async function getAllAdmins(): Promise<AdminRecord[]> {
  return getOrFetch("admins:all", async () => {
    const res = await stateRequest<{ items: AdminRecord[] }>("/state/admins");
    return res.items;
  });
}

// ─── Fleet roster ─────────────────────────────────────────────────
//
// The mids of every bot owned by the same user. Siblings are *protected*, not
// admins: they must never be kicked or blacklisted by one another, but they get
// no command powers over each other — `hasPermission` is deliberately untouched
// (see api-spec.md §3a Fleet roster, tasks/todo/008).
//
// Why this exists: `worker_admins` is instance-scoped, so bot A's OWNER row is
// invisible to bot B. Anti-kick's admin check therefore reads a sibling as an
// attacker and kicks it. This roster is the missing "one of ours" signal.

/**
 * How long an unreachable roster is remembered as empty.
 *
 * Deliberately far shorter than the 30s success TTL: an outage should cost one
 * brief unprotected window, not half a minute of it.
 */
const FLEET_FAILURE_TTL_MS = 5_000;

/**
 * Mids of every bot owned by the same user (including this one).
 *
 * Cache key prefix MUST stay `fleet:` — `applyStateUpdate` invalidates via
 * `invalidatePrefix(table + ":")` for the `fleet` table, so renaming this key
 * without renaming the table silently breaks push invalidation.
 *
 * Fails **open** (empty roster) and caches that briefly. Both halves matter:
 * failing open keeps an unreachable `/state/*` from making every stranger
 * un-kickable, and caching the failure keeps `stateRequest`'s retry/backoff off
 * the hot path — this is consulted on every kick, blacklist write, and
 * blacklist read, so an API without the route (older image, mid-deploy) would
 * otherwise add hundreds of ms to each of them.
 */
export async function getFleetMids(): Promise<string[]> {
  const cached = cacheGet<string[]>("fleet:mids");
  if (cached !== undefined) return cached;

  try {
    const res = await stateRequest<{ mids: string[] }>("/state/fleet");
    cacheSet("fleet:mids", res.mids);
    return res.mids;
  } catch (error) {
    logger.warn("Fleet roster unavailable — sibling protection is off until it recovers", {
      error: error instanceof Error ? error.message : String(error),
    });
    cacheSet("fleet:mids", [], FLEET_FAILURE_TTL_MS);
    return [];
  }
}

/** Is this mid one of our own bots? */
export async function isFleetMember(mid: string): Promise<boolean> {
  if (!mid) return false;
  return (await getFleetMids()).includes(mid);
}

/**
 * Report this bot's own LINE mid so its siblings can recognise it.
 *
 * Goes over the authenticated `/state/*` plane rather than riding the `ready`
 * webhook: that route verifies nothing and trusts `instanceId`, which is not a
 * secret, so an unauthenticated caller could otherwise enrol any mid into a
 * fleet and make it un-kickable. The API additionally rejects anything that
 * isn't a well-formed mid.
 *
 * Best-effort: a failure here costs sibling protection until the next start, so
 * it must never take the bot's startup down with it.
 */
export async function reportOwnProfileMid(profileMid: string): Promise<void> {
  try {
    await stateRequest("/state/fleet/self", { method: "PUT", body: { profileMid } });
    invalidatePrefix("fleet:");
    logger.info("Reported own profile mid to the fleet roster", { profileMid });
  } catch (error) {
    logger.error("Failed to report own profile mid — siblings may treat this bot as a stranger", {
      profileMid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── Blacklist ────────────────────────────────────────────────────

export async function addToBlacklist(
  uid: string,
  name: string,
  reason: string,
  addedBy: string,
): Promise<void> {
  // A sibling bot can never be blacklisted. The blacklist is user-scoped and
  // shared, so one bad row poisons the entire fleet: join-guard kicks the
  // sibling on sight and sweep_blacklist hunts it across every group. The API
  // refuses this too — both layers matter, since either can be bypassed alone.
  if (await isFleetMember(uid)) {
    logger.warn("Refusing to blacklist a fleet bot", { uid, reason, addedBy });
    return;
  }

  // Nor an admin, and for a sharper reason than "admins are trusted": since 0016
  // the admin table is user-scoped, so this row would follow the admin to every
  // bot in the fleet — and `getUserRole` checks the blacklist BEFORE the admin
  // row, so it would resolve them to `blacklisted` and strip their protection
  // from every ambient defense at once. That is the bug this guard exists to
  // prevent, not a politeness.
  //
  // `getAdmin`, deliberately not `hasPermission(uid, ADMIN)`: the latter routes
  // through `getUserRole` and so returns false for an admin who is *already*
  // poisoned — exactly the case where the guard has to hold. Asking the admin
  // table directly is immune to that ordering. The API applies the same check.
  if (await getAdmin(uid)) {
    logger.warn("Refusing to blacklist an admin", { uid, reason, addedBy });
    return;
  }

  await stateRequest(`/state/blacklist/${encodeURIComponent(uid)}`, {
    method: "PUT",
    body: { name, reason, addedBy },
  });
  invalidatePrefix("blacklist:");
}

export async function removeFromBlacklist(uid: string): Promise<boolean> {
  const res = await stateRequest<{ removed: boolean }>(
    `/state/blacklist/${encodeURIComponent(uid)}`,
    { method: "DELETE" },
  );
  invalidatePrefix("blacklist:");
  return res?.removed ?? false;
}

/**
 * A fleet bot is never blacklisted, whatever the table says.
 *
 * Filtering on read (rather than only on write) is what makes this
 * self-healing, and it matters in three places:
 *  - `getUserRole` checks the blacklist BEFORE the admin row, so a poisoned
 *    sibling would resolve to `blacklisted` forever — even after being made an
 *    admin. Filtering here removes the need to reorder that function.
 *  - `join-guard` gates on this directly and would kick a sibling on rejoin.
 *  - anti-kick skips re-inviting a blacklisted victim, so a poisoned sibling
 *    that got kicked would never be brought back.
 * Rows written before this guard existed (migration 0015 purges them) or by an
 * older worker are therefore inert rather than fatal.
 */
export async function isBlacklisted(uid: string): Promise<boolean> {
  if (await isFleetMember(uid)) return false;
  return getOrFetch(`blacklist:has:${uid}`, async () => {
    const res = await stateRequest<{ blacklisted: boolean }>(
      `/state/blacklist/${encodeURIComponent(uid)}`,
    );
    return res.blacklisted;
  });
}

/**
 * Filtered for the same reason as `isBlacklisted` — and it needs its own filter
 * because callers that enumerate (notably the `sweep_blacklist` RPC, which kicks
 * every listed mid out of a group) never consult `isBlacklisted` at all.
 */
export async function getAllBlacklisted(): Promise<BlacklistRecord[]> {
  const items = await getOrFetch("blacklist:all", async () => {
    const res = await stateRequest<{ items: BlacklistRecord[] }>("/state/blacklist");
    return res.items;
  });
  const fleet = new Set(await getFleetMids());
  return items.filter((item) => !fleet.has(item.uid));
}

// ─── Settings ─────────────────────────────────────────────────────

export async function setSetting(key: string, value: string): Promise<void> {
  await stateRequest(`/state/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: { value },
  });
  cacheSet(`settings:${key}`, value);
}

export async function getSetting(key: string): Promise<string | null> {
  const hit = cacheGet<string | null>(`settings:${key}`);
  if (hit !== undefined) return hit;
  const res = await stateRequest<{ value: string } | null>(
    `/state/settings/${encodeURIComponent(key)}`,
    { notFoundAsNull: true },
  );
  const value = res ? res.value : null;
  cacheSet(`settings:${key}`, value);
  return value;
}

export async function getWebhookTargets(): Promise<OutboundWebhookTarget[]> {
  const raw = await getSetting("webhookTargets");
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const candidate = item as { url?: unknown; token?: unknown };
      if (typeof candidate.url !== "string" || candidate.url.trim().length === 0) {
        return [];
      }

      const normalizedToken = typeof candidate.token === "string" && candidate.token.trim().length > 0
        ? candidate.token.trim()
        : null;

      return normalizedToken
        ? [{ url: candidate.url.trim(), token: normalizedToken }]
        : [{ url: candidate.url.trim() }];
    });
  } catch {
    return [];
  }
}

// ─── Coordination (fleet claim lock) ─────────────────────────────

/**
 * TTL for reactive-defense claims (anti-kick, join-guard). Only needs to
 * cover cross-bot poll skew — the few seconds in which two bots in the same
 * fleet observe the same op — NOT dedup a whole event lifetime: a longer TTL
 * (e.g. the previous 15s) would wrongly suppress a genuinely distinct repeat
 * event on the same target (a blacklisted user re-kicked/rejoining within
 * the window) as if it were the same claim. Shared const so anti-kick.ts and
 * join-guard.ts can't drift from each other or from the docs.
 */
export const CLAIM_TTL_MS = 3000;

/**
 * Atomic "first bot wins" claim for a fleet-shared event, so exactly one bot
 * in a user's fleet acts on a given kick/join op instead of every bot
 * amplifying it N× (and risking a mass ban). Backed by `POST /state/claims`,
 * keyed by `(user_id, key)` on the Central API with TTL expiry + automatic
 * failover — never cache the result locally, a stale "won" would let two
 * bots both act, a stale "lost" would leave the event permanently unhandled.
 *
 * ponytail: on error this fails CLOSED (returns false = skip), not open —
 * deliberately. Fail-open would make every bot act whenever the state API
 * blips, re-introducing the exact N×-amplification/ban vector this claim
 * lock exists to prevent. The cost is a bounded stranding window: a missed
 * claim, or a winner that crashes between claiming and acting, leaves the
 * event unhandled for at most `CLAIM_TTL_MS` (3s) before the key expires and
 * another bot can pick it up — there's no guarantee of a "next event" to
 * self-heal on (an already-kicked victim who never rejoins has none), which
 * is exactly why the TTL is kept short.
 */
export async function claimEvent(key: string, ttlMs: number): Promise<boolean> {
  try {
    const res = await stateRequest<{ won: boolean }>("/state/claims", {
      method: "POST",
      body: { key, ttlMs },
    });
    return res.won;
  } catch (error) {
    logger.warn("claimEvent failed — failing closed (skip, not acting)", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ─── Permissions ──────────────────────────────────────────────────

export async function getUserRole(uid: string): Promise<PermissionRole> {
  if (await isBlacklisted(uid)) {
    return "blacklisted" as PermissionRole;
  }
  const admin = await getAdmin(uid);
  if (admin) return admin.role;
  return "user" as PermissionRole;
}

export async function hasPermission(
  uid: string,
  requiredRole: PermissionRole,
): Promise<boolean> {
  const role = await getUserRole(uid);
  const hierarchy: Record<PermissionRole, number> = {
    blacklisted: -1,
    user: 0,
    admin: 1,
    owner: 2,
  };
  return (hierarchy[role] ?? 0) >= (hierarchy[requiredRole] ?? 0);
}

// ─── Auto-Reply ───────────────────────────────────────────────────

export async function addAutoReply(
  chatId: string,
  keyword: string,
  response: string,
  matchType: "exact" | "contains" | "startswith",
  addedBy: string,
): Promise<void> {
  await stateRequest("/state/auto-replies", {
    method: "POST",
    body: { chatId, keyword, response, matchType, addedBy },
  });
  invalidatePrefix("auto-replies:");
}

export async function removeAutoReply(chatId: string, keyword: string): Promise<boolean> {
  const res = await stateRequest<{ removed: boolean }>("/state/auto-replies", {
    method: "DELETE",
    query: { chatId, keyword },
  });
  invalidatePrefix("auto-replies:");
  return res?.removed ?? false;
}

export async function getAutoReplies(chatId: string): Promise<AutoReplyRecord[]> {
  return getOrFetch(`auto-replies:resolved:${chatId}`, async () => {
    const res = await stateRequest<{ items: AutoReplyRecord[] }>("/state/auto-replies", {
      query: { chatId, resolved: "true" },
    });
    return res.items;
  });
}

export async function getAutoRepliesForChat(chatId: string): Promise<AutoReplyRecord[]> {
  return getOrFetch(`auto-replies:chat:${chatId}`, async () => {
    const res = await stateRequest<{ items: AutoReplyRecord[] }>("/state/auto-replies", {
      query: { chatId },
    });
    return res.items;
  });
}

// ─── Word Filter ──────────────────────────────────────────────────

export async function addWordFilter(
  chatId: string,
  word: string,
  addedBy: string,
): Promise<void> {
  await stateRequest("/state/word-filters", {
    method: "POST",
    body: { chatId, word, addedBy },
  });
  invalidatePrefix("word-filters:");
}

export async function removeWordFilter(chatId: string, word: string): Promise<boolean> {
  const res = await stateRequest<{ removed: boolean }>("/state/word-filters", {
    method: "DELETE",
    query: { chatId, word },
  });
  invalidatePrefix("word-filters:");
  return res?.removed ?? false;
}

export async function getWordFilters(chatId: string): Promise<WordFilterRecord[]> {
  return getOrFetch(`word-filters:resolved:${chatId}`, async () => {
    const res = await stateRequest<{ items: WordFilterRecord[] }>("/state/word-filters", {
      query: { chatId, resolved: "true" },
    });
    return res.items;
  });
}

export async function getWordFiltersForChat(chatId: string): Promise<WordFilterRecord[]> {
  return getOrFetch(`word-filters:chat:${chatId}`, async () => {
    const res = await stateRequest<{ items: WordFilterRecord[] }>("/state/word-filters", {
      query: { chatId },
    });
    return res.items;
  });
}

// ─── Watched Chats ────────────────────────────────────────────────

export async function upsertWatchedChat(rec: {
  chatId: string;
  chatName: string;
  chatType: ChatType;
  forwardUrl?: string | null;
  enabled?: boolean;
  addedBy: string;
  filterType?: string;
  filterPattern?: string;
}): Promise<void> {
  await stateRequest(`/state/watched-chats/${encodeURIComponent(rec.chatId)}`, {
    method: "PUT",
    body: {
      chatName: rec.chatName,
      chatType: rec.chatType,
      forwardUrl: rec.forwardUrl ?? null,
      enabled: rec.enabled ?? true,
      addedBy: rec.addedBy,
      filterType: rec.filterType ?? "none",
      filterPattern: rec.filterPattern ?? "",
    },
  });
  invalidatePrefix("watched-chats:");
  cacheDelete(`watched-chats:one:${rec.chatId}`);
}

export async function setWatchedChatForwardUrl(
  chatId: string,
  forwardUrl: string | null,
): Promise<boolean> {
  const res = await stateRequest<{ changed: boolean }>(
    `/state/watched-chats/${encodeURIComponent(chatId)}`,
    { method: "PATCH", body: { forwardUrl } },
  );
  invalidatePrefix("watched-chats:");
  return res?.changed ?? false;
}

export async function setWatchedChatEnabled(
  chatId: string,
  enabled: boolean,
): Promise<boolean> {
  const res = await stateRequest<{ changed: boolean }>(
    `/state/watched-chats/${encodeURIComponent(chatId)}`,
    { method: "PATCH", body: { enabled } },
  );
  invalidatePrefix("watched-chats:");
  return res?.changed ?? false;
}

export async function setWatchedChatFilter(
  chatId: string,
  filterType: string,
  filterPattern: string,
): Promise<void> {
  await stateRequest(
    `/state/watched-chats/${encodeURIComponent(chatId)}`,
    { method: "PATCH", body: { filterType, filterPattern } },
  );
  invalidatePrefix("watched-chats:");
  cacheDelete(`watched-chats:one:${chatId}`);
}

export async function removeWatchedChat(chatId: string): Promise<boolean> {
  const res = await stateRequest<{ removed: boolean }>(
    `/state/watched-chats/${encodeURIComponent(chatId)}`,
    { method: "DELETE" },
  );
  invalidatePrefix("watched-chats:");
  return res?.removed ?? false;
}

export async function getWatchedChat(chatId: string): Promise<WatchedChatRecord | null> {
  return getOrFetch(`watched-chats:one:${chatId}`, async () => {
    const row = await stateRequest<WatchedChatRecord | null>(
      `/state/watched-chats/${encodeURIComponent(chatId)}`,
      { notFoundAsNull: true },
    );
    return row;
  });
}

export async function getAllWatchedChats(): Promise<WatchedChatRecord[]> {
  return getOrFetch("watched-chats:all", async () => {
    const res = await stateRequest<{ items: WatchedChatRecord[] }>("/state/watched-chats");
    return res.items;
  });
}

// ─── Group Command Toggles & Authorized Users ────────────────────

export interface GroupCommandToggleRecord {
  chatId: string;
  command: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: number;
}

export interface GroupAuthorizedUserRecord {
  uid: string;
  /** Captured display name at time of add; may be "" if unresolved. */
  name: string;
  addedBy: string;
  addedAt: number;
}

export async function setGroupCommandEnabled(
  chatId: string,
  command: string,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  await stateRequest(
    `/state/group-commands/${encodeURIComponent(chatId)}/${encodeURIComponent(command)}`,
    { method: "PUT", body: { enabled, updatedBy } },
  );
  invalidatePrefix(`group_command_toggles:${chatId}`);
}

export async function getGroupCommandToggles(chatId: string): Promise<GroupCommandToggleRecord[]> {
  return getOrFetch(`group_command_toggles:${chatId}`, async () => {
    const res = await stateRequest<{ items: GroupCommandToggleRecord[] }>(
      `/state/group-commands/${encodeURIComponent(chatId)}`,
    );
    return res.items;
  });
}

/**
 * Resolves whether an ambient/event-driven feature is active in a chat.
 * Fallback order: explicit per-chat toggle → per-bot default (chatId "*")
 * → system default OFF. The toggle table is the single source of truth.
 */
export async function isGroupCommandEnabled(chatId: string, command: string): Promise<boolean> {
  const lower = command.toLowerCase();

  const toggles = await getGroupCommandToggles(chatId);
  const row = toggles.find((t) => t.command.toLowerCase() === lower);
  if (row) return row.enabled;

  if (chatId !== "*") {
    const defaults = await getGroupCommandToggles("*");
    const defaultRow = defaults.find((t) => t.command.toLowerCase() === lower);
    if (defaultRow) return defaultRow.enabled;
  }

  return false;
}

export async function addGroupAuthorizedUser(
  chatId: string,
  uid: string,
  addedBy: string,
  name = "",
): Promise<void> {
  await stateRequest(
    `/state/group-authorized-users/${encodeURIComponent(chatId)}/${encodeURIComponent(uid)}`,
    { method: "PUT", body: { addedBy, name } },
  );
  invalidatePrefix(`group_authorized_users:${chatId}`);
}

export async function removeGroupAuthorizedUser(chatId: string, uid: string): Promise<boolean> {
  const res = await stateRequest<{ removed: boolean }>(
    `/state/group-authorized-users/${encodeURIComponent(chatId)}/${encodeURIComponent(uid)}`,
    { method: "DELETE" },
  );
  invalidatePrefix(`group_authorized_users:${chatId}`);
  return res?.removed ?? false;
}

export async function getGroupAuthorizedUsers(chatId: string): Promise<GroupAuthorizedUserRecord[]> {
  return getOrFetch(`group_authorized_users:${chatId}`, async () => {
    const res = await stateRequest<{ items: GroupAuthorizedUserRecord[] }>(
      `/state/group-authorized-users/${encodeURIComponent(chatId)}`,
    );
    return res.items;
  });
}

export async function isGroupAuthorizedUser(chatId: string, uid: string): Promise<boolean> {
  const users = await getGroupAuthorizedUsers(chatId);
  return users.some((u) => u.uid === uid);
}

// ─── Group Backup (task 025 — Group Backup + Recovery) ────────────
//
// `saveGroupBackupState` is the full-replace primitive (used by
// `!groupbackup on`'s scan). `addBackupMemberState` (the single-joiner case)
// used to be a client-side read-modify-write (GET roster, append, PUT full
// replace) layered on top of it — that was a lost-update race: two
// concurrent joins could each read the same pre-append roster and the loser's
// PUT would silently drop the other's member. It now hits a dedicated atomic
// route (`POST .../members`, a single INSERT ... ON CONFLICT + recount on the
// API side), so there is no client-side merge left to race.

export async function saveGroupBackupState(
  chatId: string,
  groupName: string,
  members: GroupBackupMember[],
): Promise<void> {
  await stateRequest("/state/group-backups", {
    method: "PUT",
    body: { chatId, groupName, members },
  });
  cacheDelete(`group-backups:${chatId}`);
}

/**
 * Route contract is `{ mid, displayName }` only — no `groupName`. When this
 * is the very first member ever added for `chatId` (toggle turned on but the
 * initial `!groupbackup on` scan never completed), the API-side atomic add
 * creates the parent row with `group_name = ''`, so the dashboard shows a
 * blank name until a successful `scanAndSaveRoster` backfills it. Accepted
 * tradeoff — low-priority, and there's no field on this endpoint to plug a
 * placeholder through even if we wanted to.
 */
export async function addBackupMemberState(
  chatId: string,
  member: GroupBackupMember,
): Promise<void> {
  await stateRequest(`/state/group-backups/${encodeURIComponent(chatId)}/members`, {
    method: "POST",
    body: { mid: member.mid, displayName: member.displayName },
  });
  cacheDelete(`group-backups:${chatId}`);
}

export async function getGroupBackupRoster(chatId: string): Promise<GroupBackupRecord | null> {
  return getOrFetch(`group-backups:${chatId}`, async () => {
    const row = await stateRequest<GroupBackupRecord | null>(
      `/state/group-backups/${encodeURIComponent(chatId)}`,
      { notFoundAsNull: true },
    );
    return row;
  });
}

