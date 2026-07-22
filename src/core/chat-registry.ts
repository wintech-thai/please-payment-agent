/**
 * rlbotline Worker — Watched Chats Registry
 *
 * In-memory cache ของรายการ chat ที่บอท "ตามอ่าน" อยู่
 * โหลดจาก DB ตอน startup และ refresh ทุกครั้งที่มีการเพิ่ม/ลบ
 *
 * ใช้สำหรับ:
 *  - กรอง message ใน poll loop ก่อน forward (Phase 3)
 *  - lookup forwardUrl ของแต่ละ chat
 */

import { logger } from "./logger.js";
import { isCentralApiEnabled } from "./state-client.js";
import {
  getAllWatchedChats,
  upsertWatchedChat,
  removeWatchedChat,
  setWatchedChatEnabled,
  setWatchedChatForwardUrl,
  setWatchedChatFilter,
} from "./database.js";
import type { WatchedChatRecord, ChatType } from "../types.js";

/**
 * Chat type from a mid prefix (c=group, r=room, s/m=square, u=user). Duplicated
 * from `features/watch.ts` on purpose — this core module must not import a
 * feature (that would be a dependency cycle).
 */
function typeFromMid(chatId: string): ChatType {
  const p = chatId[0];
  if (p === "c") return "group";
  if (p === "r") return "room";
  if (p === "s" || p === "m") return "square";
  if (p === "u") return "user";
  return "unknown";
}

/** Write a watched-chat record straight into the in-memory cache (no state store). */
function setLocalWatched(rec: WatchedChatRecord): void {
  cache.set(rec.chatId, rec);
  if (rec.filterType === "regex") {
    compileRegex(rec.chatId, rec.filterPattern);
  }
}

/** chatId → record */
const cache: Map<string, WatchedChatRecord> = new Map();

/** chatId → compiled RegExp (null = invalid pattern) */
const regexCache: Map<string, RegExp | null> = new Map();

let loaded = false;

function compileRegex(chatId: string, pattern: string): void {
  if (!pattern) {
    regexCache.set(chatId, null);
    return;
  }
  try {
    regexCache.set(chatId, new RegExp(pattern));
  } catch {
    logger.warn("Invalid regex pattern for chat", { chatId, pattern });
    regexCache.set(chatId, null);
  }
}

/** Load all watched chats from DB into memory. */
export async function loadWatchedChats(): Promise<void> {
  // Standalone (no Central API): there is nothing to load, and clearing here
  // would wipe the env-seeded chats. Mark loaded so intercept's isLoaded() gate
  // opens and leave the seeds in place.
  if (!isCentralApiEnabled()) {
    loaded = true;
    return;
  }
  const rows = await getAllWatchedChats();
  cache.clear();
  regexCache.clear();
  for (const r of rows) {
    cache.set(r.chatId, r);
    if (r.filterType === "regex") {
      compileRegex(r.chatId, r.filterPattern);
    }
  }
  loaded = true;
  logger.info("Watched chats loaded", { total: cache.size });
}

/**
 * Seed watched chats from env (`WATCH_CHAT_IDS`) with NO Central API — writes
 * the in-memory cache directly and marks the registry loaded so intercept's
 * `isLoaded()` gate opens. Each chat is enabled with no filter; type is derived
 * from the id prefix and the name defaults to the id (best-effort standalone).
 */
export function seedWatchedChats(ids: string[], addedBy = "env"): void {
  const addedAt = Date.now();
  for (const id of ids) {
    if (!id || cache.has(id)) continue;
    setLocalWatched({
      chatId: id,
      chatName: id,
      chatType: typeFromMid(id),
      forwardUrl: null,
      enabled: true,
      addedBy,
      addedAt,
      filterType: "none",
      filterPattern: "",
    });
  }
  loaded = true;
  logger.info("Watched chats seeded from env", { total: cache.size, seeded: ids.length });
}

/** Check if a chat is being watched (and enabled). */
export function isWatched(chatId: string): boolean {
  const r = cache.get(chatId);
  return !!r && r.enabled;
}

/** Get the forward URL for a chat (null if not set or not watched). */
export function getForwardUrl(chatId: string): string | null {
  const r = cache.get(chatId);
  if (!r || !r.enabled) return null;
  return r.forwardUrl;
}

/** Get a watched chat record. */
export function getWatched(chatId: string): WatchedChatRecord | null {
  return cache.get(chatId) ?? null;
}

/** Get the compiled RegExp for a chat (undefined = not a regex chat, null = invalid pattern). */
export function getCompiledRegex(chatId: string): RegExp | null | undefined {
  return regexCache.get(chatId);
}

/** List all watched chats (enabled + disabled). */
export function listWatched(): WatchedChatRecord[] {
  return Array.from(cache.values()).sort((a, b) => a.addedAt - b.addedAt);
}

/** Add or update a watched chat. Persists to DB and refreshes cache. */
export async function addWatched(rec: {
  chatId: string;
  chatName: string;
  chatType: ChatType;
  forwardUrl?: string | null;
  enabled?: boolean;
  addedBy: string;
  filterType?: string;
  filterPattern?: string;
}): Promise<void> {
  // Standalone: upsertWatchedChat is a no-op and loadWatchedChats won't reload,
  // so write the cache directly (keeps ensureBankOaWatched working standalone).
  if (!isCentralApiEnabled()) {
    setLocalWatched({
      chatId: rec.chatId,
      chatName: rec.chatName,
      chatType: rec.chatType,
      forwardUrl: rec.forwardUrl ?? null,
      enabled: rec.enabled ?? true,
      addedBy: rec.addedBy,
      addedAt: Date.now(),
      filterType: (rec.filterType as WatchedChatRecord["filterType"]) ?? "none",
      filterPattern: rec.filterPattern ?? "",
    });
    loaded = true;
    return;
  }
  await upsertWatchedChat(rec);
  await loadWatchedChats();
}

/** Remove a watched chat from DB and cache. */
export async function removeWatched(chatId: string): Promise<boolean> {
  const ok = await removeWatchedChat(chatId);
  if (ok) {
    cache.delete(chatId);
    regexCache.delete(chatId);
  }
  return ok;
}

/** Toggle enabled flag. */
export async function toggleEnabled(chatId: string, enabled: boolean): Promise<boolean> {
  const ok = await setWatchedChatEnabled(chatId, enabled);
  if (ok) {
    const cur = cache.get(chatId);
    if (cur) cache.set(chatId, { ...cur, enabled });
  }
  return ok;
}

/** Update forward URL (null to clear). */
export async function setForwardUrl(chatId: string, url: string | null): Promise<boolean> {
  const ok = await setWatchedChatForwardUrl(chatId, url);
  if (ok) {
    const cur = cache.get(chatId);
    if (cur) cache.set(chatId, { ...cur, forwardUrl: url });
  }
  return ok;
}

/** Update filter type + pattern. Persists to state API and updates cache + regexCache. */
export async function setFilter(
  chatId: string,
  filterType: string,
  filterPattern: string,
): Promise<void> {
  await setWatchedChatFilter(chatId, filterType, filterPattern);
  const cur = cache.get(chatId);
  if (cur) {
    cache.set(chatId, { ...cur, filterType: filterType as WatchedChatRecord["filterType"], filterPattern });
  }
  if (filterType === "regex") {
    compileRegex(chatId, filterPattern);
  } else {
    regexCache.delete(chatId);
  }
}

/** True after loadWatchedChats() finished at least once. */
export function isLoaded(): boolean {
  return loaded;
}

