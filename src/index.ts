/**
 * rlbotline Worker — Main Entry Point
 *
 * Orchestrates the complete worker lifecycle:
 * 1. Parse config from environment
 * 2. Initialize logger, database, webhook
 * 3. Authenticate LINE client
 * 4. Register all Phase 1 features
 * 5. Start event router & operation polling
 * 6. Run heartbeat
 * 7. Handle graceful shutdown
 */

import { loadConfig } from "./core/config.js";
import { configureLogger, logger } from "./core/logger.js";
import { initDatabase, pruneMessages, closeDatabase } from "./core/database.js";
import { configureStateClient } from "./core/state-client.js";
import {
  configureWebhook,
  startHeartbeat,
  stopHeartbeat,
  reportShutdown,
  reportError,
} from "./core/webhook.js";
import {
  initLineClient,
  startListening,
  disconnectClient,
  flushSession,
  getBotMid,
  startQrLogin,
  startPasswordLogin,
} from "./core/line-client.js";
import {
  registerFeature,
  initEventRouter,
  listRegisteredCommands,
  executeRegisteredCommand,
} from "./core/event-router.js";

// Features
import { createAntiUnsendFeature } from "./features/anti-unsend.js";
import { createTagAllFeature } from "./features/tagall.js";
import { createWelcomeGoodbyeFeature } from "./features/welcome-goodbye.js";
import {
  createSubAdminFeature,
  bootstrapOwner,
} from "./features/sub-admin.js";
import { createGroupPermissionsFeature } from "./features/group-permissions.js";
import { createCalculatorFeature } from "./features/calculator.js";
import { createClearPendingFeature } from "./features/clear-pending.js";
import { createAutoReplyFeature } from "./features/auto-reply.js";
import { createWordFilterFeature } from "./features/word-filter.js";
// Phase 3
import { createAntiKickFeature } from "./features/anti-kick.js";
import { createAntiLinkFeature } from "./features/anti-link.js";
import { createAntiCallFeature } from "./features/anti-call.js";
import { createAntiMediaFeature } from "./features/anti-media.js";
import { createGroupGuardFeature } from "./features/group-guard.js";
import { createAntiSpamFeature } from "./features/anti-spam.js";
import { createJoinGuardFeature } from "./features/join-guard.js";
import { createGroupBackupFeature, scanAndSaveRoster, recoverRoster } from "./features/group-backup.js";
// Phase 4C
import { createSyncFeature } from "./features/sync.js";
import { syncClient } from "./core/sync-client.js";
// Phase 5 (Watched Chats)
import { createWatchFeature } from "./features/watch.js";
import { createInterceptFeature } from "./features/intercept.js";
import { loadWatchedChats, seedWatchedChats, getWatched, addWatched } from "./core/chat-registry.js";
import { configureForwarder } from "./core/forwarder.js";
import { configureOnix } from "./core/onix-client.js";
import { configureRedis, closeRedis } from "./core/redis-client.js";
import { startHttpServer, stopHttpServer } from "./core/http-server.js";
import { waitForLoginReady } from "./core/login-state.js";
import { listAllChats, listGroupMembers } from "./core/chat-lister.js";
import { stateRequest } from "./core/state-client.js";
import { getClient, kickFromGroup, sendBotMessage } from "./core/line-client.js";
import { hasPermission, getAllBlacklisted } from "./core/database.js";
import { randomDelay } from "./core/rate-limiter.js";
import { PermissionRole, type WorkerConfig } from "./types.js";


/** Message prune interval: every 30 minutes */
const PRUNE_INTERVAL_MS = 30 * 60 * 1000;

let pruneTimer: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;

const UI_COMMANDS_WITHOUT_CHAT = new Set([
  "help",
  "h",
  "ping",
  "calc",
  "=",
  "clearpending",
]);

async function parkWorker(reason = "PIN timeout"): Promise<void> {
  logger.warn(`Worker parked after ${reason}; awaiting manual restart`);
  while (!isShuttingDown) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Follow + watch the configured bank OAs (`config.bankOaHandles`). Idempotent:
 * for each @handle not already watched, resolve it to a LINE mid via
 * `findContactByUserid`, add it as a friend (so its messages reach this
 * account), and register it as an enabled watched OA. All LINE calls run
 * through the shared rate limiter (the `talk` proxy), so this is safe to run
 * on every boot. Best-effort per handle — one failure never aborts the rest.
 */
async function ensureBankOaWatched(config: WorkerConfig): Promise<void> {
  if (config.bankOaHandles.length === 0) return;
  const client = getClient();
  const selfMid = await getBotMid().catch(() => "");

  for (const handle of config.bankOaHandles) {
    const searchId = handle.startsWith("@") ? handle.slice(1) : handle;
    try {
      const contact = await client.base.talk
        .findContactByUserid({ searchId })
        .catch(() => null);
      const mid = contact?.mid;
      if (!mid) {
        logger.warn("Bank OA handle did not resolve to a contact", { handle });
        continue;
      }
      if (getWatched(mid)) continue; // already watched — idempotent skip

      // Follow the OA so it delivers messages to this account. A failed add
      // (e.g. already a friend) shouldn't stop us from watching it.
      await client.base.relation.addFriendByMid({ mid }).catch((err) => {
        logger.warn("Bank OA add-friend failed (continuing to watch)", {
          handle,
          mid,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      await addWatched({
        chatId: mid,
        chatName: contact?.displayName ?? handle,
        chatType: "oa",
        enabled: true,
        addedBy: selfMid || "system",
      });
      logger.info("Bank OA followed + watched", {
        handle,
        mid,
        name: contact?.displayName ?? handle,
      });
    } catch (error) {
      logger.warn("Bank OA onboarding failed for handle", {
        handle,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Watch the configured bank-OA MIDs (`config.bankOaMids`) — but ONLY the ones the
 * account has already added as a contact. Each present MID is watched as `oa` with
 * its real display name; a MID that is not in the contact list is skipped and never
 * auto-followed, so the customer must add that OA themselves. Idempotent + best-effort.
 */
async function ensureConfiguredOaWatched(config: WorkerConfig): Promise<void> {
  if (config.bankOaMids.length === 0) return;
  const client = getClient();
  const selfMid = await getBotMid().catch(() => "");

  // The account's actual contacts (friends + added OAs). A MID absent here has not
  // been added, so we must neither watch nor follow it.
  let contactIds: string[] = [];
  try {
    contactIds = await client.base.talk.getAllContactIds({ syncReason: "INTERNAL" });
  } catch (err) {
    logger.warn("Configured OA watch: getAllContactIds failed — skipping all", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const contactSet = new Set(contactIds);

  const present = config.bankOaMids.filter((mid) => contactSet.has(mid));
  for (const mid of config.bankOaMids) {
    if (!contactSet.has(mid)) {
      logger.warn("Configured OA not in contacts — skipped (customer must add it)", { mid });
    }
  }
  if (present.length === 0) return;

  // Resolve display names in one batch so watched OAs carry a human-readable title.
  const nameByMid = new Map<string, string>();
  try {
    const contacts = (await client.base.talk.getContacts({ mids: present })) as Array<{
      mid?: string;
      displayName?: string;
    }>;
    for (const c of contacts) {
      if (c.mid && c.displayName) nameByMid.set(c.mid, c.displayName);
    }
  } catch {
    // names are best-effort — fall back to the MID below
  }

  for (const mid of present) {
    if (getWatched(mid)) continue; // idempotent — already watched
    const name = nameByMid.get(mid) ?? mid;
    await addWatched({
      chatId: mid,
      chatName: name,
      chatType: "oa",
      enabled: true,
      addedBy: selfMid || "system",
    });
    logger.info("Configured OA watched (verified contact)", { mid, name });
  }
}

/**
 * Main bootstrap function.
 */
async function main(): Promise<void> {
  // ── Step 1: Load Config ──
  const config = loadConfig();

  // ── Step 2: Initialize Logger ──
  configureLogger(config.logLevel, config.instanceId);
  logger.info("═══════════════════════════════════════════════");
  logger.info("  rlbotline Worker starting up");
  logger.info("═══════════════════════════════════════════════");
  logger.info("Configuration loaded", {
    instanceId: config.instanceId,
    botName: config.botName,
    device: config.device,
    commandPrefix: config.commandPrefix,
    apiBaseUrl: config.apiBaseUrl ?? "(standalone — no Central API)",
    redis: config.redis.enabled,
  });

  // When false, the worker runs fully standalone: session → Redis, watched chats
  // → WATCH_CHAT_IDS, and every /state/* /webhooks/* /ws/sync interaction is skipped.
  const central = config.centralApiEnabled;

  // ── Step 2b: Configure Redis session store (persists session across restarts) ──
  configureRedis(config.redis);

  // ── Step 3: Configure State Client + verify Central API reachable (central only) ──
  if (central) {
    configureStateClient({
      apiBaseUrl: config.apiBaseUrl!,
      instanceToken: config.instanceToken,
    });
    await initDatabase();

    // Start periodic message pruning
    pruneTimer = setInterval(() => {
      pruneMessages(config.messageRetentionHours).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("Message prune failed", { error: msg });
      });
    }, PRUNE_INTERVAL_MS);
  }

  // ── Step 4: Initialize Webhook ──
  // Status events (heartbeat/ready/error/...) always go to the control-plane
  // /webhooks/worker endpoint. The message-forward sink is config.webhookUrl
  // (defaults to /webhooks/forward), used by the intercept fan-out.
  // Empty URL in standalone mode ⇒ sendWebhookEvent no-ops cleanly (no status plane).
  configureWebhook(central ? `${config.apiBaseUrl}/webhooks/worker` : "", config.instanceId);

  // ── Step 4b: Initialize Forwarder (HMAC + timeout) ──
  configureForwarder({
    hmacSecret: config.watchHmacSecret,
    timeoutMs: config.forwardTimeoutMs,
  });

  // ── Step 4c: Initialize onix forward target (bank OA → onix) ──
  configureOnix(config.onix);

  // ── Step 4d: Start the inbound HTTP API (login + health on HTTP_PORT) ──
  // Started before login so a caller can drive login (POST /login/qr or
  // /login/password) and read /login/status while login is still pending.
  startHttpServer(config);

  // ── Step 5: Authenticate LINE Client ──
  logger.info("Initializing LINE client...");
  const lineClientResult = await initLineClient(config);
  if (lineClientResult.kind !== "ready") {
    if (config.httpApiEnabled) {
      // Standalone app: the inbound HTTP API drives login. Block here until a
      // login (POST /login/qr or /login/password) reaches "ready", then fall
      // through to the normal startup below.
      logger.warn("Initial login not ready — awaiting login via the HTTP API", {
        kind: lineClientResult.kind,
      });
      await waitForLoginReady();
    } else {
      // No inbound API — preserve the legacy park-and-await-restart behavior.
      const reason =
        lineClientResult.kind === "pin-timeout"
          ? "PIN timeout"
          : lineClientResult.kind === "onboarding-required"
            ? "onboarding required"
            : `login failure (${lineClientResult.attempts} attempts exhausted)`;
      await parkWorker(reason);
      return;
    }
  }
  logger.info("LINE client ready");

  // ── Step 6: Bootstrap Owner ──
  await bootstrapOwner();

  // ── Step 6b: Load Watched Chats Cache ──
  if (central) {
    await loadWatchedChats();
    // Periodically refresh the watched-chats cache so UI-side tracking changes
    // take effect even if the reload RPC was missed (e.g. transient WS drop).
    setInterval(() => {
      loadWatchedChats().catch((err) => {
        logger.warn("Periodic watched-chats reload failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 30_000);
  } else {
    // Standalone: seed the registry from WATCH_CHAT_IDS (no Central API).
    seedWatchedChats(config.watchChatIds);
  }

  // ── Step 6c: Follow + watch bank OAs (best-effort, non-blocking) ──
  // Idempotent — skips OAs already watched — and paced by the shared rate
  // limiter, so it's safe to run on every boot.
  ensureBankOaWatched(config).catch((err) => {
    logger.warn("Bank OA onboarding failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // ── Step 6d: Watch configured bank-OA MIDs that the account already added ──
  // Verified (never auto-follows). Missing MIDs are skipped for the customer to add.
  ensureConfiguredOaWatched(config).catch((err) => {
    logger.warn("Configured OA watch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // ── Step 7: Register Features ──
  logger.info("Registering features...");

  registerFeature(createAntiUnsendFeature());
  registerFeature(createTagAllFeature());
  registerFeature(createWelcomeGoodbyeFeature());
  registerFeature(createSubAdminFeature());
  registerFeature(createGroupPermissionsFeature());
  registerFeature(createCalculatorFeature());
  registerFeature(createClearPendingFeature());
  // Phase 2
  registerFeature(createAutoReplyFeature());
  registerFeature(createWordFilterFeature());
  // Phase 3
  registerFeature(createAntiKickFeature());
  registerFeature(createAntiLinkFeature());
  registerFeature(createAntiCallFeature());
  registerFeature(createAntiMediaFeature());
  registerFeature(createGroupGuardFeature());
  registerFeature(createAntiSpamFeature());
  registerFeature(createJoinGuardFeature());
  registerFeature(createGroupBackupFeature());
  registerFeature(createSyncFeature());
  // Phase 5 (Watched Chats)
  registerFeature(createWatchFeature());
  registerFeature(createInterceptFeature(config));

  // Register a built-in !help command
  registerFeature({
    name: "help",
    commands: ["help", "h"],
    description: "📖 แสดงรายการคำสั่งทั้งหมด",
    async handleCommand(cmd) {
      const { getRegisteredFeatures } = await import(
        "./core/event-router.js"
      );

      const features = getRegisteredFeatures();

      const helpLines = features.map(
        (f) => `• ${f.description}${f.available === false ? " 🚧 (ยังไม่พร้อมใช้)" : ""}`,
      );
      const helpText = [
        `📖 คำสั่งทั้งหมด (prefix: ${config.commandPrefix})`,
        "────────────────────",
        ...helpLines,
        "────────────────────",
        `🤖 ${config.botName} | rlbotline v1.0`,
      ].join("\n");

      await sendBotMessage(cmd.chatId, helpText);
    },
  });

  // Register a !ping command for health checks
  registerFeature({
    name: "ping",
    commands: ["ping"],
    description: "🏓 ตรวจสอบสถานะบอท — !ping",
    async handleCommand(cmd) {
      const uptimeSeconds = Math.floor(process.uptime());
      const memoryMB = Math.round(process.memoryUsage.rss() / 1024 / 1024);

      await sendBotMessage(
        cmd.chatId,
        `🏓 Pong!\n⏱️ Uptime: ${uptimeSeconds}s\n💾 Memory: ${memoryMB}MB`,
      );
    },
  });

  logger.info("All features registered");

  // ── Step 8: Initialize Event Router ──
  initEventRouter(config);

  // ── Step 9: Start Heartbeat & Sync (central only — no hub/status plane standalone) ──
  if (central) {
    startHeartbeat();
    syncClient.connect();
  }

  // ── Step 9b: Register RPC handlers (API → Worker) ──
  // Registered unconditionally (pure in-memory Map inserts); they only ever fire
  // when the Sync Hub is connected, which is gated on `central` above.
  syncClient.onRpc("discover_chats", async () => {
    const client = getClient();
    const chats = await listAllChats(client);
    const visibleChats = chats.filter((c) => c.type !== "user");
    await stateRequest("/state/chats", {
      method: "POST",
      body: { chats: visibleChats.map((c) => ({
        chatId: c.id,
        name: c.name,
        chatType: c.type,
        attributes: c.attributes ?? null,
        addedVia: "discovered",
      })) },
    });
    return { count: visibleChats.length };
  });

  syncClient.onRpc("reload_watched_chats", async () => {
    await loadWatchedChats();
    return { ok: true, count: 0 };
  });

  syncClient.onRpc("list_group_members", async (args) => {
    const { chatId } = (args ?? {}) as { chatId?: string };
    if (!chatId) throw new Error("chatId required");
    const client = getClient();
    return listGroupMembers(client, chatId);
  });

  syncClient.onRpc("lookup_contact", async (args) => {
    const { query } = (args ?? {}) as { query?: string };
    if (!query) throw new Error("query required");
    const client = getClient();
    const searchId = query.startsWith("@") ? query.slice(1) : query;

    // Direct mid lookup if it looks like one (starts with u/c/r/s/m + hex).
    if (/^[ucrsm][0-9a-f]{32}$/i.test(searchId)) {
      const contacts = await client.base.talk.getContacts({ mids: [searchId] });
      const c = (contacts as Array<{ mid?: string; displayName?: string; attributes?: number }>)[0];
      if (!c?.mid) return null;
      const isOA = typeof c.attributes === "number" && c.attributes !== 0;
      return {
        chatId: c.mid,
        name: c.displayName ?? "(ไม่มีชื่อ)",
        chatType: c.mid.startsWith("c") ? "group" : isOA ? "oa" : "user",
        attributes: c.attributes ?? null,
      };
    }

    // Otherwise treat as LINE userid (the @handle).
    const contact = await client.base.talk
      .findContactByUserid({ searchId })
      .catch(() => null);
    if (!contact?.mid) return null;
    const isOA = typeof contact.attributes === "number" && contact.attributes !== 0;
    return {
      chatId: contact.mid,
      name: contact.displayName ?? "(ไม่มีชื่อ)",
      chatType: isOA ? "oa" : "user",
      attributes: contact.attributes ?? null,
    };
  });

  syncClient.onRpc("kick_member", async (args) => {
    const { chatId, mid } = (args ?? {}) as { chatId?: string; mid?: string };
    if (!chatId || !mid) throw new Error("chatId and mid required");
    try {
      const { kicked, skipped } = await kickFromGroup(chatId, [mid]);
      // The fleet guard refused it. Report that instead of ok:true — this is an
      // operator pressing a button (e.g. decommissioning one of their own bots),
      // and a silent no-op would look like a bug they cannot diagnose.
      if (kicked.length === 0 && skipped.length > 0) {
        return { ok: false, reason: "fleet_member" };
      }
      return { ok: true };
    } catch (error) {
      // Expected LINE-side failures (e.g. insufficient permission) are
      // reported as ok:false rather than thrown, so the API maps this to a
      // clean 200 { ok: false } instead of a 502.
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn("RPC kick_member: LINE call failed", { chatId, mid, error: msg });
      return { ok: false };
    }
  });

  syncClient.onRpc("invite_members", async (args) => {
    const { chatId, mids } = (args ?? {}) as { chatId?: string; mids?: string[] };
    if (!chatId || !Array.isArray(mids) || mids.length === 0) {
      throw new Error("chatId and mids required");
    }
    try {
      const client = getClient();
      await client.base.talk.inviteIntoChat({ chatMid: chatId, targetUserMids: mids });
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn("RPC invite_members: LINE call failed", { chatId, mids, error: msg });
      return { ok: false };
    }
  });

  syncClient.onRpc("add_friend", async (args) => {
    const { mid } = (args ?? {}) as { mid?: string };
    if (!mid) throw new Error("mid required");
    try {
      const client = getClient();
      // client.base.relation.addFriendByMid — hand-written linejs wrapper for
      // the RelationService's addFriendByMid RPC (confirmed present in
      // node_modules/@evex/linejs/base/service/relation/mod.ts; LINE's
      // findAndAddContactsByMid has no args-encoder shipped in this linejs
      // version, so it isn't safe to call directly).
      await client.base.relation.addFriendByMid({ mid });
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn("RPC add_friend: LINE call failed", { mid, error: msg });
      return { ok: false };
    }
  });

  // ── On-demand login (central web → bot → LINE → status back) ──
  // The central web triggers these when a user app asks to log in. Login runs
  // in the background; the QR URL, PIN, and final result are streamed back as
  // webhook events (qrcode / pincode / ready / error / status) on
  // /webhooks/worker, which the central web relays to the requester. Returning
  // immediately keeps the RPC well under its timeout while the user scans.
  syncClient.onRpc("login_qr", async () => {
    void startQrLogin(config)
      .then((res) => {
        if (res.kind !== "ready") logger.warn("login_qr finished non-ready", { kind: res.kind });
      })
      .catch((err) => {
        logger.error("login_qr failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return { ok: true, status: "qr_started" };
  });

  syncClient.onRpc("login_password", async (args) => {
    const { email, password } = (args ?? {}) as { email?: string; password?: string };
    if (!email || !password) throw new Error("email and password required");
    void startPasswordLogin(config, email, password)
      .then((res) => {
        if (res.kind !== "ready") logger.warn("login_password finished non-ready", { kind: res.kind });
      })
      .catch((err) => {
        logger.error("login_password failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return { ok: true, status: "login_started" };
  });

  // Follow + watch the configured bank OAs on demand (idempotent).
  syncClient.onRpc("ensure_bank_oa", async () => {
    await ensureBankOaWatched(config);
    return { ok: true, handles: config.bankOaHandles.length };
  });

  syncClient.onRpc("list_friends", async () => {
    const client = getClient();
    const chats = await listAllChats(client);
    // API route wraps this in { friends } (mirrors list_group_members) — return the bare array.
    return chats
      .filter((c) => c.type === "user")
      .map((c) => ({ mid: c.id, displayName: c.name }));
  });

  syncClient.onRpc("sweep_blacklist", async (args) => {
    const { chatId } = (args ?? {}) as { chatId?: string };
    if (!chatId) throw new Error("chatId required");

    const client = getClient();
    let botMid = "";
    try {
      botMid = await getBotMid();
    } catch {
      // continue without botMid — self-skip just becomes best-effort
    }

    // Fetch the blacklist once (cached) and intersect with members, instead of
    // ~2 sequential /state/* calls per member — keeps the sweep well under the
    // RPC timeout even on large groups.
    const blacklistedMids = new Set((await getAllBlacklisted()).map((b) => b.uid));
    const members = await listGroupMembers(client, chatId);
    const kicked: string[] = [];

    for (const member of members) {
      try {
        if (!member.mid || member.mid === botMid) continue;
        if (!blacklistedMids.has(member.mid)) continue;
        if (await hasPermission(member.mid, PermissionRole.ADMIN)) continue;

        await randomDelay(300, 800);
        await kickFromGroup(chatId, [member.mid]);
        kicked.push(member.mid);
      } catch (error) {
        // A single failed kick must not abort the whole sweep.
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn("RPC sweep_blacklist: failed to kick member", {
          chatId,
          mid: member.mid,
          error: msg,
        });
      }
    }

    return { kicked, count: kicked.length };
  });

  syncClient.onRpc("backup_group", async (args) => {
    const { chatId } = (args ?? {}) as { chatId?: string };
    if (!chatId) throw new Error("chatId required");
    const memberCount = await scanAndSaveRoster(chatId);
    return { ok: true, memberCount };
  });

  syncClient.onRpc("recover_group", async (args) => {
    const { sourceChatId, destChatId } = (args ?? {}) as {
      sourceChatId?: string;
      destChatId?: string;
    };
    if (!sourceChatId || !destChatId) {
      throw new Error("sourceChatId and destChatId required");
    }
    return recoverRoster(getClient(), sourceChatId, destChatId);
  });

  syncClient.onRpc("list_commands", async () => {
    const withoutChat = UI_COMMANDS_WITHOUT_CHAT;
    return {
      commands: listRegisteredCommands().map((cmd) => ({
        name: cmd.name,
        feature: cmd.feature,
        description: cmd.description,
        requiresChat: !withoutChat.has(cmd.name),
      })),
    };
  });

  syncClient.onRpc("execute_command", async (args) => {
    const payload = (args ?? {}) as {
      command?: string;
      chatId?: string;
      args?: string[];
      argsText?: string;
      mentionedMids?: string[];
    };

    const commandName = (payload.command ?? "").trim().toLowerCase();
    if (!commandName) {
      throw new Error("command is required");
    }

    const parsedArgs = Array.isArray(payload.args)
      ? payload.args.filter((v): v is string => typeof v === "string")
      : (payload.argsText ?? "").trim().length > 0
        ? (payload.argsText ?? "").trim().split(/\s+/)
        : [];

    const requiresChat = !UI_COMMANDS_WITHOUT_CHAT.has(commandName);
    if (requiresChat && !(payload.chatId && payload.chatId.trim().length > 0)) {
      throw new Error("chatId is required for this command");
    }

    const senderId = await getBotMid();
    if (!senderId) {
      throw new Error("bot sender identity unavailable");
    }

    const mentionedMids = Array.isArray(payload.mentionedMids)
      ? payload.mentionedMids.filter((v): v is string => typeof v === "string")
      : [];

    const result = await executeRegisteredCommand({
      name: commandName,
      args: parsedArgs,
      chatId: payload.chatId ?? senderId,
      senderId,
      mentionedMids,
      source: "ui",
      rawText: `${config.commandPrefix}${commandName}${parsedArgs.length > 0 ? ` ${parsedArgs.join(" ")}` : ""}`,
    });

    if (!result.ok) {
      throw new Error(result.reason ?? "command execution failed");
    }

    return {
      ok: true,
      command: commandName,
      feature: result.feature ?? null,
      ignored: result.ignored ?? false,
      reason: result.reason ?? null,
      executedAt: Date.now(),
    };
  });

  // ── Step 9c: Initial chat discovery (central only — pushes to /state/chats) ──
  if (central) {
    (async () => {
      try {
        const client = getClient();
        const chats = await listAllChats(client);
        const visibleChats = chats.filter((c) => c.type !== "user");
        await stateRequest("/state/chats", {
          method: "POST",
          body: { chats: visibleChats.map((c) => ({
            chatId: c.id,
            name: c.name,
            chatType: c.type,
            attributes: c.attributes ?? null,
            addedVia: "discovered",
          })) },
        });
        logger.info(`Initial chat discovery: ${visibleChats.length} chats pushed to API (user chats excluded)`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Initial chat discovery failed: ${msg}`);
      }
    })();
  }

  // ── Step 10: Start Listening ──
  logger.info("Starting event listener...");

  // Start the LINE event listener (messages + operations)
  startListening().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Event listener fatal error", { error: msg });
    if (!isShuttingDown) {
      reportError("Event listener crashed: " + msg).catch(() => {});
    }
  });

  logger.info("═══════════════════════════════════════════════");
  logger.info("  rlbotline Worker is LIVE 🚀");
  logger.info("═══════════════════════════════════════════════");
}

/**
 * Graceful shutdown handler.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Shutdown signal received: ${signal}`);

  stopHeartbeat();
  stopHttpServer();
  syncClient.disconnect();

  // Stop prune timer
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }

  // Report shutdown to Central API
  try {
    await reportShutdown(signal);
  } catch {
    // Best-effort
  }

  // Force-persist the session storage BEFORE dropping the client. The debounced
  // (1s) writer would otherwise lose a mutation from the last second — most
  // importantly a freshly registered E2EE key or a refreshed auth token —
  // making the next boot restore a stale blob, risk a fresh login, and rotate
  // the Letter Sealing key (which breaks decryption of pre-rotation messages).
  await flushSession();

  // Close the Redis connection now that the final session flush is done.
  await closeRedis();

  // Disconnect LINE client
  disconnectClient();

  // Close database
  await closeDatabase();

  logger.info("Shutdown complete. Goodbye!");
  process.exit(0);
}

// ── Signal Handlers ──
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
  reportError("Uncaught exception: " + error.message).catch(() => {});
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error("Unhandled rejection", { error: msg });
  reportError("Unhandled rejection: " + msg).catch(() => {});
});

// ── Start ──
main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[FATAL] Worker failed to start: ${msg}`);
  process.exit(1);
});
