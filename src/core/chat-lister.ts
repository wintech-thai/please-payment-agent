/**
 * rlbotline Worker — Chat Lister
 *
 * Two-pass enumeration ของ chats ทั้งหมดที่บอท join อยู่ +
 * เพื่อน/OA ที่อยู่ใน contact list:
 *
 *   Pass 1: client.fetchJoinedChats() → คืน group chats (mid prefix `c`)
 *   Pass 2: getAllContactIds() + getContacts() → คืน 1-on-1 friends + OAs
 *
 * Classification:
 *   - mid prefix `c`                 → "group"
 *   - mid prefix `u` + attributes!=0 → "oa"   (Official Account / Bot)
 *   - mid prefix `u` + attributes==0 → "user" (1-on-1 friend)
 *   - mid prefix `r`                 → "room"
 *   - mid prefix `s`/`m`             → "square"
 */

import type { Client } from "@evex/linejs";
import { logger } from "./logger.js";
import type { DiscoveredChat, ChatType } from "../types.js";

const CONTACT_CHUNK = 100;

function classifyByMid(
  mid: string,
  rawChat?: { extra?: { groupExtra?: unknown } },
): ChatType {
  const prefix = mid[0];
  if (prefix === "c" || rawChat?.extra?.groupExtra) return "group";
  if (prefix === "r") return "room";
  if (prefix === "s" || prefix === "m") return "square";
  if (prefix === "u") return "user"; // refined via contact.attributes
  return "unknown";
}

/**
 * Enumerate all chats the bot has access to.
 * Returns unified list sorted by type → group first, then OAs, then users.
 */
export async function listAllChats(client: Client): Promise<DiscoveredChat[]> {
  const seen = new Set<string>();
  const out: DiscoveredChat[] = [];

  // ── Pass 1: joined groups ──
  try {
    const chats = await client.fetchJoinedChats();
    for (const chat of chats) {
      const mid = chat.mid;
      if (!mid || seen.has(mid)) continue;
      seen.add(mid);
      const raw = chat.raw as { extra?: { groupExtra?: unknown } } | undefined;
      out.push({
        id: mid,
        name: chat.name || "(ไม่มีชื่อ)",
        type: classifyByMid(mid, raw),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("listAllChats: fetchJoinedChats failed", { error: msg });
  }

  // ── Pass 2: contacts (friends + OAs) ──
  let contactMids: string[] = [];
  try {
    contactMids = await client.base.talk.getAllContactIds({
      syncReason: "INTERNAL",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("listAllChats: getAllContactIds failed", { error: msg });
  }

  type RawContact = {
    mid?: string;
    displayName?: string;
    attributes?: number;
  };

  const contacts: RawContact[] = [];
  for (let i = 0; i < contactMids.length; i += CONTACT_CHUNK) {
    const slice = contactMids.slice(i, i + CONTACT_CHUNK);
    try {
      const part = (await client.base.talk.getContacts({ mids: slice })) as RawContact[];
      contacts.push(...part);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("listAllChats: getContacts batch failed", {
        offset: i,
        error: msg,
      });
    }
  }

  for (const c of contacts) {
    if (!c.mid || seen.has(c.mid)) continue;
    seen.add(c.mid);
    let type = classifyByMid(c.mid);
    if (type === "user" && typeof c.attributes === "number" && c.attributes !== 0) {
      type = "oa";
    }
    out.push({
      id: c.mid,
      name: c.displayName || "(ไม่มีชื่อ)",
      type,
      attributes: c.attributes,
    });
  }

  // Sort: group → oa → user → others
  const order: Record<ChatType, number> = {
    group: 0,
    oa: 1,
    user: 2,
    room: 3,
    square: 4,
    unknown: 5,
  };
  out.sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name, "th"));

  return out;
}

/** Convenience: list only groups. */
export async function listGroups(client: Client): Promise<DiscoveredChat[]> {
  const all = await listAllChats(client);
  return all.filter((c) => c.type === "group");
}

/** Convenience: list only Official Accounts. */
export async function listOAs(client: Client): Promise<DiscoveredChat[]> {
  const all = await listAllChats(client);
  return all.filter((c) => c.type === "oa");
}

export interface GroupMember {
  mid: string;
  displayName: string;
}

/**
 * List all members of a group chat, resolving mids to display names.
 * Falls back to the first 8 chars of the mid if a contact lookup fails.
 */
export async function listGroupMembers(client: Client, chatMid: string): Promise<GroupMember[]> {
  const rawChat = await client.base.talk.getChat({
    chatMid,
    withMembers: true,
  });

  const memberMidsMap = (rawChat as { extra?: { groupExtra?: { memberMids?: Record<string, unknown> } } })
    ?.extra?.groupExtra?.memberMids;
  const memberMids: string[] = memberMidsMap ? Object.keys(memberMidsMap) : [];

  let members: GroupMember[] = memberMids.map((mid) => ({
    mid,
    displayName: mid.substring(0, 8),
  }));

  try {
    const contacts = await client.base.talk.getContacts({ mids: memberMids });
    if (Array.isArray(contacts)) {
      const nameMap = new Map<string, string>();
      for (const contact of contacts) {
        const contactMid = (contact as { mid?: string }).mid;
        const displayName = (contact as { displayName?: string }).displayName;
        if (contactMid && displayName) {
          nameMap.set(contactMid, displayName);
        }
      }
      members = memberMids.map((mid) => ({
        mid,
        displayName: nameMap.get(mid) ?? mid.substring(0, 8),
      }));
    }
  } catch {
    logger.debug("listGroupMembers: could not fetch contact names, using MID placeholders");
  }

  return members;
}
