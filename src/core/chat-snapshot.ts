/**
 * rlbotline Worker — Chat Settings Snapshot ("last known good")
 *
 * Phase B group-settings guards (task 019+) revert a hostile change by
 * restoring the group's previous name / picture / invite-link state. The op
 * that announces a change (`NOTIFIED_UPDATE_CHAT` and friends) does NOT carry
 * the old value, so the worker keeps its own in-memory "last known good"
 * snapshot to restore from.
 *
 * Lifecycle:
 *  - seeded at startup from `talk.getChats` (see `seedSnapshots`)
 *  - a change made by an EXEMPT actor (admin/self/fleet) is legitimate → it
 *    becomes the new good value (`updateSnapshot`), so the bot never fights an
 *    admin's own rename
 *  - a change made by a non-exempt actor is reverted back to the snapshot
 *
 * Worker is stateless (no DB — per manual.md), so this Map is intentionally
 * process-local and re-seeds on restart. If a change arrives before seeding
 * for that chat, `getSnapshot` is undefined and the caller must skip the
 * revert (can't restore an unknown value) and seed from the current state.
 *
 * No behavior here fires until a capture session confirms the settings-change
 * op types (.research/line-op-type-verification.md, Phase B checklist) and the
 * guard features are flipped off `available: false`.
 */

export interface ChatSettingsSnapshot {
  /** Group display name, if known. */
  name?: string;
  /** Group picture object path, if known. */
  picturePath?: string;
  /** LINE's "prevent join by invite link/ticket" flag — true = link disabled. */
  preventedJoinByTicket?: boolean;
}

const snapshots = new Map<string, ChatSettingsSnapshot>();

/** Returns the last-known-good snapshot for a chat, or undefined if unseeded. */
export function getSnapshot(chatId: string): ChatSettingsSnapshot | undefined {
  return snapshots.get(chatId);
}

/**
 * Merges partial fields into a chat's snapshot (creating it if absent).
 * Only defined fields overwrite — passing `{ name }` leaves a known
 * `picturePath` intact. Call this on a legitimate (exempt-actor) change and on
 * cold-start reconciliation.
 */
export function updateSnapshot(chatId: string, partial: ChatSettingsSnapshot): void {
  const current = snapshots.get(chatId) ?? {};
  const next: ChatSettingsSnapshot = { ...current };
  if (partial.name !== undefined) next.name = partial.name;
  if (partial.picturePath !== undefined) next.picturePath = partial.picturePath;
  if (partial.preventedJoinByTicket !== undefined) {
    next.preventedJoinByTicket = partial.preventedJoinByTicket;
  }
  snapshots.set(chatId, next);
}

/** Seeds many chats at once (startup). Overwrites any existing entries. */
export function seedSnapshots(
  chats: Array<{ chatId: string } & ChatSettingsSnapshot>,
): void {
  for (const chat of chats) {
    updateSnapshot(chat.chatId, chat);
  }
}

/** Drops a chat's snapshot (e.g. the bot left the group). */
export function clearSnapshot(chatId: string): void {
  snapshots.delete(chatId);
}

/** Test/diagnostic helper — number of chats currently tracked. */
export function snapshotCount(): number {
  return snapshots.size;
}

/** Test helper — wipes all snapshots. Not used in production paths. */
export function __resetSnapshotsForTest(): void {
  snapshots.clear();
}
