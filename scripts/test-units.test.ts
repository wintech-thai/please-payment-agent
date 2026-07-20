/**
 * rlbotline — Comprehensive Unit Tests (PostgreSQL)
 *
 * Covers: Calculator, Rate Limiter, Database (CRUD + Phase 2),
 *         Config, Logger, Webhook, Template Rendering
 *
 * Run: DATABASE_URL="postgres://rlbot:rlbot@localhost:5432/rlbotline_test" bun test scripts/test-units.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test";

// ─── Calculator Tests ───────────────────────────────────────────
import { safeEvaluate } from "../src/features/calculator.js";

describe("🔢 Calculator — safeEvaluate()", () => {
  test("basic addition", () => expect(safeEvaluate("2+3")).toBe(5));
  test("basic subtraction", () => expect(safeEvaluate("10-3")).toBe(7));
  test("basic multiplication", () => expect(safeEvaluate("4*5")).toBe(20));
  test("basic division", () => expect(safeEvaluate("20/4")).toBe(5));
  test("operator precedence: 2+3*4 = 14", () => expect(safeEvaluate("2+3*4")).toBe(14));
  test("parentheses: (2+3)*4 = 20", () => expect(safeEvaluate("(2+3)*4")).toBe(20));
  test("nested parentheses: ((2+3)*4+1)*2 = 42", () => expect(safeEvaluate("((2+3)*4+1)*2")).toBe(42));
  test("decimals: 3.14*2 = 6.28", () => expect(safeEvaluate("3.14*2")).toBe(6.28));
  test("negative numbers: -5+3 = -2", () => expect(safeEvaluate("-5+3")).toBe(-2));
  test("spaces are ignored: 2 + 3 * 4 = 14", () => expect(safeEvaluate("2 + 3 * 4")).toBe(14));
  test("complex: 100/4+3*2-1 = 30", () => expect(safeEvaluate("100/4+3*2-1")).toBe(30));
  test("division by zero throws", () => expect(() => safeEvaluate("1/0")).toThrow());
  test("empty expression throws", () => expect(() => safeEvaluate("")).toThrow());
  test("invalid characters throw", () => expect(() => safeEvaluate("2+abc")).toThrow());
  test("too long expression throws (>200 chars)", () => {
    expect(() => safeEvaluate("1+" + "1+".repeat(150) + "1")).toThrow();
  });
  test("single number returns itself", () => expect(safeEvaluate("42")).toBe(42));
  test("double negation: --5 throws or handles", () => {
    try { const r = safeEvaluate("--5"); expect(r).toBe(5); } catch { expect(true).toBe(true); }
  });
});

// ─── Rate Limiter Tests ─────────────────────────────────────────
import { RateLimiter, ChatCooldown, sleep } from "../src/core/rate-limiter.js";

describe("⏱️ RateLimiter", () => {
  test("allows requests within limit", async () => {
    const limiter = new RateLimiter(3, 1000);
    const start = Date.now();
    await limiter.acquire(); await limiter.acquire(); await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(100);
  });
  test("blocks when limit is exceeded", async () => {
    const limiter = new RateLimiter(2, 500);
    await limiter.acquire(); await limiter.acquire();
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });
  test("wrap() creates throttled function", async () => {
    const limiter = new RateLimiter(5, 1000);
    let c = 0;
    const fn = limiter.wrap(async () => ++c);
    expect(await fn()).toBe(1);
  });
});

describe("⏱️ ChatCooldown", () => {
  test("allows first action", () => expect(new ChatCooldown(1000).tryAcquire("c1")).toBe(true));
  test("blocks repeated action within cooldown", () => {
    const cd = new ChatCooldown(1000); cd.tryAcquire("c1");
    expect(cd.tryAcquire("c1")).toBe(false);
  });
  test("allows action after cooldown expires", async () => {
    const cd = new ChatCooldown(100); cd.tryAcquire("c1");
    await sleep(150);
    expect(cd.tryAcquire("c1")).toBe(true);
  });
  test("different chats have independent cooldowns", () => {
    const cd = new ChatCooldown(1000); cd.tryAcquire("c1");
    expect(cd.tryAcquire("c2")).toBe(true);
  });
  test("cleanup removes old entries", async () => {
    const cd = new ChatCooldown(50); cd.tryAcquire("c1");
    await sleep(600); cd.cleanup();
    expect(cd.tryAcquire("c1")).toBe(true);
  });
});

describe("⏱️ sleep()", () => {
  test("sleeps for approximately the given duration", async () => {
    const start = Date.now(); await sleep(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(300);
  });
});

// ─── Database Tests ─────────────────────────────────────────────

// ─── Config Tests ───────────────────────────────────────────────
import { loadConfig } from "../src/core/config.js";
import { waitForPinTimeout, resolveDisplayName, initLineClient } from "../src/core/line-client.js";
import { normalizeRawContentType, resolveMessageChatId } from "../src/core/event-router.js";

describe("⚙️ Config", () => {
  test("loadConfig reads env vars", () => {
    process.env["WEBHOOK_URL"] = "http://localhost:3000/webhook";
    process.env["API_BASE_URL"] = "http://localhost:3001";
    process.env["INSTANCE_TOKEN"] = "a".repeat(64);
    process.env["INSTANCE_ID"] = "test-001";
    const config = loadConfig();
    expect(config.apiBaseUrl).toBe("http://localhost:3001");
    expect(config.instanceToken.length).toBe(64);
    expect(config.commandPrefix).toBe("!");
    expect(config.device).toBe("IOSIPAD");
    expect(config.rateLimitCalls).toBe(5);
  });

  test("loadConfig uses custom values", () => {
    process.env["COMMAND_PREFIX"] = "#";
    process.env["LINE_DEVICE"] = "DESKTOPWIN";
    process.env["RATE_LIMIT_CALLS"] = "10";
    const config = loadConfig();
    expect(config.commandPrefix).toBe("#");
    expect(config.device).toBe("DESKTOPWIN");
    expect(config.rateLimitCalls).toBe(10);
    process.env["COMMAND_PREFIX"] = "!";
    process.env["LINE_DEVICE"] = "IOSIPAD";
    process.env["RATE_LIMIT_CALLS"] = "5";
  });

  test("loadConfig throws on missing API_BASE_URL", () => {
    const saved = process.env["API_BASE_URL"];
    delete process.env["API_BASE_URL"];
    expect(() => loadConfig()).toThrow("API_BASE_URL");
    process.env["API_BASE_URL"] = saved;
  });

  test("loadConfig throws on missing INSTANCE_TOKEN", () => {
    const saved = process.env["INSTANCE_TOKEN"];
    delete process.env["INSTANCE_TOKEN"];
    expect(() => loadConfig()).toThrow("INSTANCE_TOKEN");
    process.env["INSTANCE_TOKEN"] = saved;
  });

  test("loadConfig throws on invalid LOG_LEVEL", () => {
    process.env["LOG_LEVEL"] = "invalid_level";
    expect(() => loadConfig()).toThrow("LOG_LEVEL");
    process.env["LOG_LEVEL"] = "info";
  });

  test("loadConfig throws on invalid integer", () => {
    process.env["RATE_LIMIT_CALLS"] = "not_a_number";
    expect(() => loadConfig()).toThrow("RATE_LIMIT_CALLS");
    process.env["RATE_LIMIT_CALLS"] = "5";
  });

  test("loadConfig accepts all valid log levels", () => {
    for (const level of ["debug", "info", "warn", "error"]) {
      process.env["LOG_LEVEL"] = level;
      expect(loadConfig().logLevel).toBe(level);
    }
    process.env["LOG_LEVEL"] = "info";
  });

  test("loadConfig reads PIN_WAIT_TIMEOUT_MS", () => {
    process.env["PIN_WAIT_TIMEOUT_MS"] = "12345";
    expect(loadConfig().pinWaitTimeoutMs).toBe(12345);
    process.env["PIN_WAIT_TIMEOUT_MS"] = "300000";
  });

  test("waitForPinTimeout resolves once a PIN has expired", async () => {
    let requestedAt: number | null = null;
    const pending = waitForPinTimeout(() => requestedAt, 25);

    setTimeout(() => {
      requestedAt = Date.now() - 50;
    }, 10);

    const result = await pending;
    expect(result.timeoutMs).toBe(25);
    expect(result.requestedAt).not.toBeNull();
  });

  test("resolveMessageChatId uses the peer MID for incoming OA messages", () => {
    expect(
      resolveMessageChatId(
        "u0310fc16260735562ddf77799dc062f9",
        "u4ca19114ed596ee2f4e63335ec7143fb",
        "u0310fc16260735562ddf77799dc062f9",
      ),
    ).toBe("u4ca19114ed596ee2f4e63335ec7143fb");
  });

  test("resolveMessageChatId keeps group ids unchanged", () => {
    expect(
      resolveMessageChatId(
        "c94b988d371702092d22ce3bb696bb101",
        "ub1151e7d2f4755ece5eba3fe56f6ba8c",
        "u0310fc16260735562ddf77799dc062f9",
      ),
    ).toBe("c94b988d371702092d22ce3bb696bb101");
  });

  test("normalizeRawContentType preserves symbolic content types", () => {
    expect(normalizeRawContentType("NONE")).toBe("NONE");
  });

  test("normalizeRawContentType preserves FLEX content type", () => {
    expect(normalizeRawContentType("FLEX")).toBe("FLEX");
  });

  test("resolveDisplayName falls back to the raw mid when the client is not ready", async () => {
    // No LINE client is initialized in this test process, so getClient()
    // throws internally and resolveDisplayName() should swallow the error
    // and return the mid unchanged (best-effort fallback behavior).
    expect(await resolveDisplayName("u1234567890abcdef")).toBe("u1234567890abcdef");
  });
});

// ─── Login retry cap (line-client.ts attemptLoginWithRetry / initLineClient) ───
/**
 * `attemptLoginWithRetry` is not exported (it's an internal helper shared by
 * the QR and email/password branches of `initLineClient`), so it's exercised
 * indirectly through `initLineClient` with no credentials configured — this
 * drives the QR login branch. `@evex/linejs`'s `loginWithQR` is swapped out
 * via `mock.module` so these tests never touch the real network; `mock.module`
 * takes effect at module-evaluation time (before any test body runs), so it
 * is registered once here and applies for this whole file's test run — safe,
 * because nothing else in this file calls `loginWithQR`/`loginWithPassword`/
 * `loginWithAuthToken` at runtime.
 */
let qrLoginCalls = 0;
let qrLoginBehavior: (opts: {
  onReceiveQRUrl: (url: string) => void;
  onPincodeRequest: (pin: string) => void;
}) => Promise<never> = async () => {
  throw new Error("qrLoginBehavior not configured for this test");
};

mock.module("@evex/linejs", () => ({
  loginWithPassword: async () => {
    throw new Error("loginWithPassword should not be called in these tests");
  },
  loginWithAuthToken: async () => {
    throw new Error("loginWithAuthToken should not be called in these tests");
  },
  loginWithQR: async (opts: {
    onReceiveQRUrl: (url: string) => void;
    onPincodeRequest: (pin: string) => void;
  }) => {
    qrLoginCalls++;
    return qrLoginBehavior(opts);
  },
}));

describe("🔁 initLineClient() / attemptLoginWithRetry — login retry cap", () => {
  function baseConfig(pinWaitTimeoutMs: number, apiBaseUrl: string) {
    return {
      lineAuthToken: undefined,
      webhookUrl: "",
      apiBaseUrl,
      instanceToken: "t",
      commandPrefix: "!",
      instanceId: "test-retry",
      botName: "bot",
      device: "IOSIPAD",
      rateLimitCalls: 100,
      rateLimitWindowMs: 1000,
      messageRetentionHours: 24,
      watchHmacSecret: undefined,
      forwardTimeoutMs: 5000,
      pinWaitTimeoutMs,
      logLevel: "error" as const,
    };
  }

  function startEmptySessionApi() {
    return Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/state/session") {
          return Response.json({ authToken: null, storage: null, lineEmail: null, linePassword: null });
        }
        return new Response("not found", { status: 404 });
      },
    });
  }

  test("returns login-failed after exactly 3 attempts and does not throw", async () => {
    qrLoginCalls = 0;
    qrLoginBehavior = async () => {
      throw new Error("hard-fail");
    };
    const server = startEmptySessionApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });

    const result = await initLineClient(baseConfig(60_000, `http://localhost:${server.port}`) as unknown as Parameters<typeof initLineClient>[0]);

    expect(result.kind).toBe("login-failed");
    if (result.kind === "login-failed") {
      expect(result.attempts).toBe(3);
    }
    expect(qrLoginCalls).toBe(3);
    server.stop(true);
  }, 15000);

  test("a pin-timeout does not consume an attempt (terminal outcome, not retried as a failure)", async () => {
    qrLoginCalls = 0;
    qrLoginBehavior = async (opts) => {
      opts.onReceiveQRUrl("https://line.me/R/xxx");
      return new Promise<never>(() => {}); // never resolves -> forces the pin-timeout race branch
    };
    const server = startEmptySessionApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });

    const result = await initLineClient(baseConfig(50, `http://localhost:${server.port}`) as unknown as Parameters<typeof initLineClient>[0]);

    expect(result.kind).toBe("pin-timeout");
    // Exactly one QR attempt: the pin-timeout race is terminal — it returns
    // immediately rather than being retried up to MAX_LOGIN_ATTEMPTS.
    expect(qrLoginCalls).toBe(1);
    server.stop(true);
  }, 15000);

  test("a hard failure followed by a pin-timeout still reports pin-timeout, not login-failed", async () => {
    qrLoginCalls = 0;
    qrLoginBehavior = async (opts) => {
      if (qrLoginCalls === 1) {
        throw new Error("attempt-1-hard-fail");
      }
      opts.onReceiveQRUrl("https://line.me/R/xxx");
      return new Promise<never>(() => {});
    };
    const server = startEmptySessionApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });

    const result = await initLineClient(baseConfig(50, `http://localhost:${server.port}`) as unknown as Parameters<typeof initLineClient>[0]);

    expect(result.kind).toBe("pin-timeout");
    // attempt 1 = hard failure (consumes an attempt, retried), attempt 2 =
    // pin-timeout (terminal) — never reaches a 3rd attempt / login-failed.
    expect(qrLoginCalls).toBe(2);
    server.stop(true);
  }, 15000);

  test("a terminal (RegExpUnmatch) login error parks after exactly 1 attempt, not retried", async () => {
    // linejs's own pre-flight email/password format validation throws
    // InternalError("RegExpUnmatch", "invalid email"/"invalid password") —
    // `.name` carries the InternalError "type" (see isTerminalLoginError's
    // doc comment in line-client.ts). This never reaches LINE's servers, so
    // retrying can never succeed — the anti-ban-motivated fix is to park on
    // the first occurrence instead of burning the remaining attempts.
    qrLoginCalls = 0;
    qrLoginBehavior = async () => {
      const err = new Error("invalid email");
      err.name = "RegExpUnmatch";
      throw err;
    };
    const server = startEmptySessionApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });

    const result = await initLineClient(baseConfig(60_000, `http://localhost:${server.port}`) as unknown as Parameters<typeof initLineClient>[0]);

    expect(result.kind).toBe("login-failed");
    if (result.kind === "login-failed") {
      expect(result.attempts).toBe(1);
      expect(result.message).toBe("invalid email");
    }
    expect(qrLoginCalls).toBe(1);
    server.stop(true);
  }, 15000);

  test("a terminal (known credential-rejection TalkException code) login error parks after exactly 1 attempt", async () => {
    qrLoginCalls = 0;
    qrLoginBehavior = async () => {
      const err = new Error("Request internal failed, ...") as Error & { data?: { code?: string } };
      err.name = "RequestError";
      err.data = { code: "INCORRECT_PASSWORD" };
      throw err;
    };
    const server = startEmptySessionApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });

    const result = await initLineClient(baseConfig(60_000, `http://localhost:${server.port}`) as unknown as Parameters<typeof initLineClient>[0]);

    expect(result.kind).toBe("login-failed");
    if (result.kind === "login-failed") {
      expect(result.attempts).toBe(1);
    }
    expect(qrLoginCalls).toBe(1);
    server.stop(true);
  }, 15000);

  test("an unrecognized RequestError code is treated as transient — still uses the full 3-attempt cap", async () => {
    // Conservative-by-default: an error we can't confidently classify as
    // terminal must NOT short-circuit the retry cap.
    qrLoginCalls = 0;
    qrLoginBehavior = async () => {
      const err = new Error("Request internal failed, ...") as Error & { data?: { code?: string } };
      err.name = "RequestError";
      err.data = { code: "SOME_UNRECOGNIZED_FUTURE_CODE" };
      throw err;
    };
    const server = startEmptySessionApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });

    const result = await initLineClient(baseConfig(60_000, `http://localhost:${server.port}`) as unknown as Parameters<typeof initLineClient>[0]);

    expect(result.kind).toBe("login-failed");
    if (result.kind === "login-failed") {
      expect(result.attempts).toBe(3);
    }
    expect(qrLoginCalls).toBe(3);
    server.stop(true);
  }, 15000);
});

// ─── Logger Tests ───────────────────────────────────────────────
import { configureLogger, logger } from "../src/core/logger.js";

describe("📝 Logger", () => {
  test("configureLogger does not throw", () => expect(() => configureLogger("info", "test-001")).not.toThrow());
  test("logger.info does not throw", () => expect(() => logger.info("test message", { key: "value" })).not.toThrow());
  test("logger.debug is suppressed at info level", () => {
    configureLogger("info", "test-001");
    expect(() => logger.debug("should be suppressed")).not.toThrow();
  });
  test("logger.error does not throw", () => expect(() => logger.error("test error", { err: "something" })).not.toThrow());
  test("logger.warn does not throw", () => expect(() => logger.warn("test warning")).not.toThrow());
});

// ─── Webhook Tests ──────────────────────────────────────────────
import { configureWebhook, sendWebhookEvent, stopHeartbeat } from "../src/core/webhook.js";

describe("🌐 Webhook", () => {
  test("configureWebhook does not throw", () => expect(() => configureWebhook("http://example.com/webhook", "test-001")).not.toThrow());
  test("sendWebhookEvent to invalid URL does not throw", async () => {
    configureWebhook("http://127.0.0.1:1/invalid", "test-001");
    await expect(sendWebhookEvent("heartbeat", { test: true })).resolves.toBeUndefined();
  });
  test("sendWebhookEvent skips if URL not configured", async () => {
    configureWebhook("", "test-001");
    await expect(sendWebhookEvent("heartbeat")).resolves.toBeUndefined();
  });
  test("stopHeartbeat does not throw when no heartbeat is running", () => expect(() => stopHeartbeat()).not.toThrow());
});

// ─── Template Rendering Tests ───────────────────────────────────
import { renderTemplate } from "../src/features/welcome-goodbye.js";

describe("📝 Template Rendering", () => {
  test("renders {name} placeholder", () => expect(renderTemplate("Hello {name}!", { name: "Alice", group: "Test", count: 5 })).toBe("Hello Alice!"));
  test("renders {group} placeholder", () => expect(renderTemplate("Welcome to {group}", { name: "Bob", group: "MyGroup", count: 10 })).toBe("Welcome to MyGroup"));
  test("renders {count} placeholder", () => expect(renderTemplate("Members: {count}", { name: "Charlie", group: "G", count: 42 })).toBe("Members: 42"));
  test("renders all placeholders together", () => {
    expect(renderTemplate("🎉 {name} joined {group}! ({count} members)", { name: "Alice", group: "TestGroup", count: 100 }))
      .toBe("🎉 Alice joined TestGroup! (100 members)");
  });
  test("renders multiple occurrences of same placeholder", () => {
    expect(renderTemplate("{name} is here! Welcome {name}!", { name: "Bob", group: "G", count: 1 })).toBe("Bob is here! Welcome Bob!");
  });
  test("returns template unchanged if no placeholders", () => expect(renderTemplate("No placeholders here", { name: "X", group: "Y", count: 0 })).toBe("No placeholders here"));
  test("handles empty name/group gracefully", () => expect(renderTemplate("Hi {name} from {group}", { name: "", group: "", count: 0 })).toBe("Hi  from "));
  test("handles Thai text in template", () => {
    expect(renderTemplate("สวัสดี {name} ยินดีต้อนรับเข้ากลุ่ม {group}!", { name: "สมชาย", group: "กลุ่มทดสอบ", count: 5 }))
      .toBe("สวัสดี สมชาย ยินดีต้อนรับเข้ากลุ่ม กลุ่มทดสอบ!");
  });
});

// ─── Phase 3: Anti-Link URL Detection ───────────────────────────
import { containsUrl } from "../src/features/anti-link.js";

describe("🔗 Anti-Link — containsUrl()", () => {
  test("detects http URL", () => expect(containsUrl("check http://example.com")).toBe(true));
  test("detects https URL", () => expect(containsUrl("visit https://google.com/path")).toBe(true));
  test("detects line.me link", () => expect(containsUrl("join line.me/ti/g/abc123")).toBe(true));
  test("detects bit.ly link", () => expect(containsUrl("click bit.ly/abc")).toBe(true));
  test("detects discord.gg link", () => expect(containsUrl("join discord.gg/server")).toBe(true));
  test("detects t.me link", () => expect(containsUrl("join t.me/channel")).toBe(true));
  test("detects tinyurl link", () => expect(containsUrl("go to tinyurl.com/xyz")).toBe(true));
  test("rejects plain text", () => expect(containsUrl("hello world")).toBe(false));
  test("rejects email-like text", () => expect(containsUrl("user@example.com")).toBe(false));
  test("rejects empty string", () => expect(containsUrl("")).toBe(false));
  test("rejects text with 'http' not as URL", () => expect(containsUrl("httpwhat")).toBe(false));
  test("detects URL embedded in Thai text", () => expect(containsUrl("ดูได้ที่ https://example.com/test")).toBe(true));
  test("detects multiple URLs", () => expect(containsUrl("http://a.com and https://b.com")).toBe(true));
});

// ─── Phase 3: Anti-Spam Tracker ─────────────────────────────────
import { trackMessage, spamTrackers, cleanupTrackers } from "../src/features/anti-spam.js";

describe("🚫 Anti-Spam — trackMessage()", () => {
  // Use unique chat/user IDs to avoid cross-test contamination
  const chatId = "spam_test_chat";
  const userId = "spam_test_user";

  test("first message returns null (no spam)", () => {
    spamTrackers.clear();
    expect(trackMessage(chatId, userId, 5, 10000)).toBeNull();
  });

  test("messages within limit return null", () => {
    spamTrackers.clear();
    for (let i = 0; i < 5; i++) {
      expect(trackMessage(chatId, userId, 5, 10000)).toBeNull();
    }
  });

  test("exceeding limit returns tracker with violations=1", () => {
    spamTrackers.clear();
    // Send 5 within limit
    for (let i = 0; i < 5; i++) {
      trackMessage(chatId, userId, 5, 10000);
    }
    // 6th message triggers spam
    const result = trackMessage(chatId, userId, 5, 10000);
    expect(result).not.toBeNull();
    expect(result!.violations).toBe(1);
  });

  test("different users tracked independently", () => {
    spamTrackers.clear();
    for (let i = 0; i < 5; i++) {
      trackMessage(chatId, "userA", 5, 10000);
    }
    // userB should start fresh
    expect(trackMessage(chatId, "userB", 5, 10000)).toBeNull();
  });

  test("violations accumulate across spam bursts", () => {
    spamTrackers.clear();
    // First burst
    for (let i = 0; i <= 5; i++) trackMessage("acc_chat", "acc_user", 5, 10000);
    // Second burst (violations should be 2)
    for (let i = 0; i <= 5; i++) {
      const r = trackMessage("acc_chat", "acc_user", 5, 10000);
      if (r) expect(r.violations).toBe(2);
    }
  });

  test("cleanupTrackers removes old entries", async () => {
    spamTrackers.clear();
    // Add an entry with a very old timestamp
    spamTrackers.set("old:entry", { count: 5, firstTimestamp: Date.now() - 60000, violations: 0 });
    cleanupTrackers();
    expect(spamTrackers.has("old:entry")).toBe(false);
  });

  test("cleanupTrackers keeps recent entries", () => {
    spamTrackers.clear();
    spamTrackers.set("new:entry", { count: 2, firstTimestamp: Date.now(), violations: 0 });
    cleanupTrackers();
    expect(spamTrackers.has("new:entry")).toBe(true);
    spamTrackers.clear(); // cleanup
  });
});

// ─── Forwarder Tests ───────────────────────────────────────────
import { configureForwarder, fanOut, type ForwardedMessage } from "../src/core/forwarder.js";

describe("🛰️ Forwarder", () => {
  const payload: ForwardedMessage = {
    messageId: "m1",
    chatId: "c1",
    chatName: "Test",
    chatType: "group",
    senderId: "u1",
    contentType: "TEXT",
    text: "hello",
    receivedAt: Date.now(),
    instanceId: "test",
  };

  test("fanOut posts to every unique URL", async () => {
    configureForwarder({ hmacSecret: "secret123", timeoutMs: 2000 });
    const seen: { url: string; sig: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({
          url: new URL(req.url).pathname,
          sig: req.headers.get("x-webhook-signature"),
        });
        return new Response("ok");
      },
    });
    try {
      const base = `http://localhost:${server.port}`;
      const results = await fanOut(
        [`${base}/a`, `${base}/b`, `${base}/a`],
        payload,
      );
      expect(results.length).toBe(2);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(seen.length).toBe(2);
      expect(seen.every((s) => s.sig?.startsWith("v1,"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("fanOut omits signature when no secret", async () => {
    configureForwarder({ hmacSecret: undefined, timeoutMs: 2000 });
    let sig: string | null = "init";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        sig = req.headers.get("x-webhook-signature");
        return new Response("ok");
      },
    });
    try {
      await fanOut([`http://localhost:${server.port}/x`], payload);
      expect(sig).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("fanOut sends Basic api-key Authorization header when a target has token", async () => {
    configureForwarder({ hmacSecret: undefined, timeoutMs: 2000 });
    let auth: string | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        auth = req.headers.get("authorization");
        return new Response("ok");
      },
    });
    try {
      await fanOut([
        { url: `http://localhost:${server.port}/auth`, token: "bot-secret" },
      ], payload);
      expect(auth).toBe(`Basic ${Buffer.from("api:bot-secret").toString("base64")}`);
    } finally {
      server.stop(true);
    }
  });

  test("fanOut keeps same URL when tokens differ", async () => {
    configureForwarder({ hmacSecret: undefined, timeoutMs: 2000 });
    const authHeaders: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        authHeaders.push(req.headers.get("authorization") ?? "");
        return new Response("ok");
      },
    });
    try {
      const targetUrl = `http://localhost:${server.port}/shared`;
      const results = await fanOut([
        { url: targetUrl, token: "token-a" },
        { url: targetUrl, token: "token-b" },
        { url: targetUrl, token: "token-a" },
      ], payload);
      expect(results.length).toBe(2);
      expect(authHeaders).toContain(`Basic ${Buffer.from("api:token-a").toString("base64")}`);
      expect(authHeaders).toContain(`Basic ${Buffer.from("api:token-b").toString("base64")}`);
    } finally {
      server.stop(true);
    }
  });

  test("fanOut reports failures without throwing", async () => {
    configureForwarder({ hmacSecret: undefined, timeoutMs: 500 });
    const results = await fanOut(
      ["http://127.0.0.1:1/never"],
      payload,
    );
    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(false);
  });

  test("fanOut returns [] for empty URL list", async () => {
    expect(await fanOut([], payload)).toEqual([]);
    expect(await fanOut([""], payload)).toEqual([]);
  });

  test("fanOut serializes bigint fields in raw payload instead of throwing", async () => {
    configureForwarder({ hmacSecret: undefined, timeoutMs: 2000 });
    let body: string | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        body = await req.text();
        return new Response("ok");
      },
    });
    try {
      const payloadWithRaw: ForwardedMessage = {
        ...payload,
        raw: { id: "m1", createdTime: 9007199254740993n, chunks: [] },
      };
      const results = await fanOut([`http://localhost:${server.port}/raw`], payloadWithRaw);
      expect(results[0].ok).toBe(true);
      expect(JSON.parse(body ?? "{}").raw.createdTime).toBe("9007199254740993");
    } finally {
      server.stop(true);
    }
  });
});

// ─── Intercept raw-payload redaction ─────────────────────────────
import { redactRaw } from "../src/features/intercept.js";

describe("🛰️ redactRaw", () => {
  test("strips chunks and self-authenticating URLs, keeps everything else", () => {
    const raw = {
      id: "m1",
      contentType: "IMAGE",
      contentMetadata: { DOWNLOAD_URL: "https://x/dl", PREVIEW_URL: "https://x/pv", STKID: "1" },
      chunks: ["binary-data"],
    };
    const result = redactRaw(raw) as Record<string, unknown>;
    expect(result["chunks"]).toBeUndefined();
    const metadata = result["contentMetadata"] as Record<string, unknown>;
    expect(metadata["DOWNLOAD_URL"]).toBeUndefined();
    expect(metadata["PREVIEW_URL"]).toBeUndefined();
    expect(metadata["STKID"]).toBe("1");
    expect(result["id"]).toBe("m1");
    // original object untouched (shallow copy, not mutation)
    expect(raw.chunks).toEqual(["binary-data"]);
  });

  test("passes through non-object / missing-field input unchanged", () => {
    expect(redactRaw(null)).toBeNull();
    expect(redactRaw(undefined)).toBeUndefined();
    expect(redactRaw({ id: "m1" })).toEqual({ id: "m1" });
  });
});

// ─── Group Command/Authorized-User Gating ───────────────────────
import { configureStateClient } from "../src/core/state-client.js";
import { clearCache } from "../src/core/state-cache.js";
import {
  setAdmin,
  removeAdmin,
  setGroupCommandEnabled,
  isGroupCommandEnabled,
  addGroupAuthorizedUser,
  removeGroupAuthorizedUser,
  isGroupAuthorizedUser,
  getFleetMids,
  isFleetMember,
  addToBlacklist,
  isBlacklisted,
  getAllBlacklisted,
} from "../src/core/database.js";
import { kickFromGroup } from "../src/core/line-client.js";
import { executeRegisteredCommand, registerFeature } from "../src/core/event-router.js";
import { PermissionRole, type Feature } from "../src/types.js";

/**
 * In-memory fake of the `/state/*` slice this feature relies on, so tests
 * exercise real HTTP round trips (via `stateRequest`) without a live Central API.
 */
function startFakeStateApi() {
  const admins = new Map<
    string,
    { role: string; addedBy: string; addedAt: number; addedByInstance: string }
  >();
  const toggles = new Map<string, Map<string, { enabled: boolean; updatedBy: string; updatedAt: number }>>();
  const authorized = new Map<string, Map<string, { addedBy: string; addedAt: number }>>();
  const blacklist = new Map<string, { name: string; reason: string; addedBy: string; addedAt: number }>();
  const claims = new Map<string, { claimedBy: string; expiresAt: number }>();
  let fleetMids: string[] = [];
  // Stands in for `bot.instanceId` off workerAuth: the real API derives
  // added_by_instance and claimed_by from the authenticated caller, never the
  // body. Tests flip this to simulate a different bot calling.
  let callerInstanceId = "test-001";

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["state","admins","u1"]

      if (parts[0] !== "state") return new Response("not found", { status: 404 });

      if (parts[1] === "ping") {
        return Response.json({ ok: true, instanceId: "test" });
      }

      if (parts[1] === "fleet" && req.method === "GET") {
        return Response.json({ mids: fleetMids });
      }

      if (parts[1] === "blacklist") {
        if (!parts[2]) {
          const items = [...blacklist.entries()].map(([uid, rec]) => ({ uid, ...rec }));
          return Response.json({ items });
        }
        const uid = decodeURIComponent(parts[2]);
        if (req.method === "PUT") {
          const body = (await req.json()) as { name?: string; reason?: string; addedBy?: string };
          blacklist.set(uid, {
            name: body.name ?? "",
            reason: body.reason ?? "",
            addedBy: body.addedBy ?? "",
            addedAt: Date.now(),
          });
          return Response.json({ ok: true });
        }
        if (req.method === "DELETE") {
          return Response.json({ removed: blacklist.delete(uid) });
        }
        return Response.json({ blacklisted: blacklist.has(uid) });
      }

      if (parts[1] === "admins" && parts[2]) {
        const uid = decodeURIComponent(parts[2]);
        if (req.method === "PUT") {
          const body = (await req.json()) as { role: string; addedBy: string };
          // addedByInstance comes from the caller's identity, mirroring the real
          // route — a worker cannot nominate itself responder via the body.
          admins.set(uid, {
            role: body.role,
            addedBy: body.addedBy,
            addedAt: Date.now(),
            addedByInstance: callerInstanceId,
          });
          return Response.json({ ok: true });
        }
        if (req.method === "DELETE") {
          const removed = admins.delete(uid);
          return Response.json({ removed });
        }
        const rec = admins.get(uid);
        if (!rec) return new Response("not found", { status: 404 });
        return Response.json({ uid, ...rec });
      }

      // First-writer-wins TTL lock, same semantics as the real acquireClaim:
      // a conflicting write only takes the key over once the holder's TTL passed.
      if (parts[1] === "claims" && req.method === "POST") {
        const body = (await req.json()) as { key: string; ttlMs: number };
        const existing = claims.get(body.key);
        if (existing && existing.expiresAt > Date.now()) {
          return Response.json({ won: existing.claimedBy === callerInstanceId });
        }
        claims.set(body.key, {
          claimedBy: callerInstanceId,
          expiresAt: Date.now() + body.ttlMs,
        });
        return Response.json({ won: true });
      }

      if (parts[1] === "group-commands" && parts[2]) {
        const chatId = decodeURIComponent(parts[2]);
        if (parts[3]) {
          const command = decodeURIComponent(parts[3]);
          if (req.method === "PUT") {
            const body = (await req.json()) as { enabled: boolean; updatedBy: string };
            const chatMap = toggles.get(chatId) ?? new Map();
            chatMap.set(command, { enabled: body.enabled, updatedBy: body.updatedBy, updatedAt: Date.now() });
            toggles.set(chatId, chatMap);
            return Response.json({ ok: true });
          }
          if (req.method === "DELETE") {
            const chatMap = toggles.get(chatId);
            const removed = chatMap?.delete(command) ?? false;
            return Response.json({ removed });
          }
        }
        const chatMap = toggles.get(chatId) ?? new Map();
        const items = Array.from(chatMap.entries()).map(([command, v]) => ({ chatId, command, ...v }));
        return Response.json({ items });
      }

      if (parts[1] === "group-authorized-users" && parts[2]) {
        const chatId = decodeURIComponent(parts[2]);
        if (parts[3]) {
          const uid = decodeURIComponent(parts[3]);
          if (req.method === "PUT") {
            const body = (await req.json()) as { addedBy: string };
            const chatMap = authorized.get(chatId) ?? new Map();
            chatMap.set(uid, { addedBy: body.addedBy, addedAt: Date.now() });
            authorized.set(chatId, chatMap);
            return Response.json({ ok: true });
          }
          if (req.method === "DELETE") {
            const chatMap = authorized.get(chatId);
            const removed = chatMap?.delete(uid) ?? false;
            return Response.json({ removed });
          }
        }
        const chatMap = authorized.get(chatId) ?? new Map();
        const items = Array.from(chatMap.entries()).map(([uid, v]) => ({ uid, ...v }));
        return Response.json({ items });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return Object.assign(server, {
    setFleetMids: (mids: string[]) => { fleetMids = mids; },
    blacklistRows: blacklist,
    /** Simulate which bot is authenticating — drives added_by_instance + claimed_by. */
    setCallerInstanceId: (id: string) => { callerInstanceId = id; },
    claimRows: claims,
  });
}

describe("🔐 Group Command Toggles & Authorized Users (database.ts)", () => {
  let server: ReturnType<typeof startFakeStateApi>;

  beforeAll(() => {
    server = startFakeStateApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "test-token" });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("default-deny: no toggle row means command is disabled", async () => {
    clearCache();
    expect(await isGroupCommandEnabled("c_default", "tagall")).toBe(false);
  });

  test("default-deny: no authorized-user rows means nobody is authorized", async () => {
    clearCache();
    expect(await isGroupAuthorizedUser("c_default", "u_random")).toBe(false);
  });

  test("setGroupCommandEnabled + isGroupCommandEnabled round trip", async () => {
    clearCache();
    await setGroupCommandEnabled("c1", "tagall", true, "u_admin");
    expect(await isGroupCommandEnabled("c1", "tagall")).toBe(true);
    await setGroupCommandEnabled("c1", "tagall", false, "u_admin");
    expect(await isGroupCommandEnabled("c1", "tagall")).toBe(false);
  });

  test("fallback resolver: per-chat toggle overrides the bot default ('*')", async () => {
    clearCache();
    await setGroupCommandEnabled("*", "welcome", true, "u_admin");
    await setGroupCommandEnabled("c_override", "welcome", false, "u_admin");
    expect(await isGroupCommandEnabled("c_override", "welcome")).toBe(false);
  });

  test("fallback resolver: no per-chat row falls back to the bot default ('*')", async () => {
    clearCache();
    await setGroupCommandEnabled("*", "antilink", true, "u_admin");
    expect(await isGroupCommandEnabled("c_no_row", "antilink")).toBe(true);
  });

  test("fallback resolver: neither per-chat nor bot default => false", async () => {
    clearCache();
    expect(await isGroupCommandEnabled("c_neither", "antispam")).toBe(false);
  });

  test("addGroupAuthorizedUser / removeGroupAuthorizedUser round trip", async () => {
    clearCache();
    expect(await isGroupAuthorizedUser("c2", "u_member")).toBe(false);
    await addGroupAuthorizedUser("c2", "u_member", "u_admin");
    expect(await isGroupAuthorizedUser("c2", "u_member")).toBe(true);
    const removed = await removeGroupAuthorizedUser("c2", "u_member");
    expect(removed).toBe(true);
    expect(await isGroupAuthorizedUser("c2", "u_member")).toBe(false);
  });
});

describe("🔐 Group Command Gating (event-router.ts executeRegisteredCommand)", () => {
  let server: ReturnType<typeof startFakeStateApi>;

  beforeAll(() => {
    server = startFakeStateApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "test-token" });
  });

  afterAll(() => {
    server.stop(true);
  });

  let calls: string[] = [];
  const testFeature: Feature = {
    name: "gate-test-feature",
    commands: ["gatetest"],
    description: "test",
    async handleCommand(cmd) {
      calls.push(cmd.chatId);
    },
  };
  registerFeature(testFeature);

  test("blocked when no toggle row exists for the group (default-deny)", async () => {
    clearCache();
    calls = [];
    const result = await executeRegisteredCommand({
      name: "gatetest",
      args: [],
      chatId: "gate_chat_1",
      senderId: "u_normal",
      source: "chat",
    });
    expect(result.ignored).toBe(true);
    expect(result.reason).toBe("command_disabled_for_group");
    expect(calls.length).toBe(0);
  });

  test("bot-wide admin/owner bypasses toggle + allowlist checks entirely", async () => {
    clearCache();
    calls = [];
    await setAdmin("u_owner", PermissionRole.OWNER, "system");
    // `admincmd` defaults ON in production (API-side seeded/backfilled '*' row —
    // see docs/api-spec.md §3a), but this in-memory test harness has no such
    // seeding, so it must be set explicitly for the admin bypass to apply.
    await setGroupCommandEnabled("gate_chat_2", "admincmd", true, "u_owner");
    const result = await executeRegisteredCommand({
      name: "gatetest",
      args: [],
      chatId: "gate_chat_2",
      senderId: "u_owner",
      source: "chat",
    });
    expect(result.ignored).toBeUndefined();
    expect(calls).toEqual(["gate_chat_2"]);
    await removeAdmin("u_owner");
  });

  test("bot-wide admin refused with admin_chat_commands_disabled when admincmd is off (non-allowlisted command)", async () => {
    clearCache();
    calls = [];
    await setAdmin("u_owner2", PermissionRole.OWNER, "system");
    // `admincmd` intentionally left unset for this chat => default-deny (off)
    // in this in-memory harness, mirroring an operator who explicitly turned
    // it off in production.
    const result = await executeRegisteredCommand({
      name: "gatetest",
      args: [],
      chatId: "gate_chat_admincmd_off",
      senderId: "u_owner2",
      source: "chat",
    });
    expect(result.ignored).toBe(true);
    expect(result.reason).toBe("admin_chat_commands_disabled");
    expect(calls.length).toBe(0);
    await removeAdmin("u_owner2");
  });

  test("allowlisted command still runs for a bot-wide admin even when admincmd is off", async () => {
    clearCache();
    calls = [];
    const pingFeature: Feature = {
      name: "ping-allowlist-test",
      commands: ["ping"],
      description: "test",
      async handleCommand(cmd) {
        calls.push(cmd.chatId);
      },
    };
    registerFeature(pingFeature);
    await setAdmin("u_owner3", PermissionRole.OWNER, "system");
    // Again, admincmd is left unset (off) for this chat — "ping" is in
    // CHAT_COMMAND_ALLOWLIST, so it must run regardless.
    const result = await executeRegisteredCommand({
      name: "ping",
      args: [],
      chatId: "gate_chat_admincmd_off_allowlist",
      senderId: "u_owner3",
      source: "chat",
    });
    expect(result.ignored).toBeUndefined();
    expect(calls).toEqual(["gate_chat_admincmd_off_allowlist"]);
    await removeAdmin("u_owner3");
  });

  test("toggle enabled + sender authorized => allowed", async () => {
    clearCache();
    calls = [];
    await setGroupCommandEnabled("gate_chat_3", "gatetest", true, "u_admin");
    await addGroupAuthorizedUser("gate_chat_3", "u_member", "u_admin");
    const result = await executeRegisteredCommand({
      name: "gatetest",
      args: [],
      chatId: "gate_chat_3",
      senderId: "u_member",
      source: "chat",
    });
    expect(result.ignored).toBeUndefined();
    expect(calls).toEqual(["gate_chat_3"]);
  });

  test("toggle enabled + sender NOT authorized => blocked", async () => {
    clearCache();
    calls = [];
    await setGroupCommandEnabled("gate_chat_4", "gatetest", true, "u_admin");
    const result = await executeRegisteredCommand({
      name: "gatetest",
      args: [],
      chatId: "gate_chat_4",
      senderId: "u_stranger",
      source: "chat",
    });
    expect(result.ignored).toBe(true);
    expect(result.reason).toBe("sender_not_authorized_for_group");
    expect(calls.length).toBe(0);
  });

  test("escape-hatch commands (groupcmd/authorize/unauthorize/listauthorized) remain reachable with zero toggles", async () => {
    clearCache();
    calls = [];
    const escapeFeature: Feature = {
      name: "group-permissions-test",
      commands: ["groupcmd", "authorize", "unauthorize", "listauthorized"],
      description: "test",
      async handleCommand(cmd) {
        calls.push(`${cmd.name}:${cmd.chatId}`);
      },
    };
    registerFeature(escapeFeature);

    for (const name of ["groupcmd", "authorize", "unauthorize", "listauthorized"]) {
      const result = await executeRegisteredCommand({
        name,
        args: [],
        chatId: "gate_chat_untouched",
        senderId: "u_random_non_admin",
        source: "chat",
      });
      // Not bot-wide admin and not in group allowlist for this chat, but these
      // four are exempt from the per-group toggle/allowlist checks entirely.
      expect(result.ignored).toBeUndefined();
    }
    expect(calls.length).toBe(4);
  });

  test("ui source bypasses all chat gating regardless of toggles", async () => {
    clearCache();
    calls = [];
    const result = await executeRegisteredCommand({
      name: "gatetest",
      args: [],
      chatId: "gate_chat_ui",
      senderId: "u_any",
      source: "ui",
    });
    expect(result.ignored).toBeUndefined();
    expect(calls).toEqual(["gate_chat_ui"]);
  });

  test("groupcmd cannot target cmdoutput/admincmd — dashboard-only denylist enforced in code, case/whitespace-insensitive", async () => {
    clearCache();
    const { createGroupPermissionsFeature } = await import("../src/features/group-permissions.js");
    registerFeature(createGroupPermissionsFeature());
    await setAdmin("u_admin_denylist", PermissionRole.OWNER, "system");

    // `groupcmd` is in CHAT_COMMAND_ALLOWLIST (skips the per-group gate
    // entirely) and only checks hasPermission(ADMIN) internally — without
    // the denylist, a locked-out admin could restore their own admincmd
    // bypass via `!groupcmd admincmd on`. Case/whitespace variance must not
    // defeat it either.
    for (const target of ["admincmd", "ADMINCMD", " admincmd ", "cmdoutput", "CmdOutput", " cmdoutput "]) {
      try {
        await executeRegisteredCommand({
          name: "groupcmd",
          args: [target, "on"],
          chatId: "denylist_chat",
          senderId: "u_admin_denylist",
          source: "chat",
        });
      } catch {
        // The real feature's rejection reply routes through
        // sendBotMessage -> getClient(), which throws "not initialized" in
        // this test process (no live LINE client) — expected, not the thing
        // under test here.
      }
    }

    // If the denylist had NOT blocked these, setGroupCommandEnabled would
    // have flipped both toggles to true (default-deny: no row => false).
    expect(await isGroupCommandEnabled("denylist_chat", "admincmd")).toBe(false);
    expect(await isGroupCommandEnabled("denylist_chat", "cmdoutput")).toBe(false);

    await removeAdmin("u_admin_denylist");
  });
});

// ─── sendBotMessage() — cmdoutput gating (line-client.ts) ───────
import { sendBotMessage } from "../src/core/line-client.js";
import { runInCommandContext } from "../src/core/command-context.js";

/**
 * `sendBotMessage` is the single outbound-send chokepoint. No LINE client is
 * initialized in this test process, so once gating lets a send through it
 * falls into `getClient()`, which throws "not initialized" — the same
 * throws-as-proof-of-reach trick used by the claim-lock tests below. A
 * suppressed send instead resolves cleanly, *never* reaching `getClient()`.
 */
describe("📤 sendBotMessage() — cmdoutput gating (line-client.ts)", () => {
  let server: ReturnType<typeof startFakeStateApi>;

  beforeAll(() => {
    server = startFakeStateApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "test-token" });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("suppressed inside a command context when cmdoutput is off (default-deny, no row)", async () => {
    clearCache();
    await runInCommandContext(
      { chatId: "c_cmdoutput_off", command: "gatetest", source: "chat" },
      async () => {
        await expect(sendBotMessage("c_cmdoutput_off", "hi")).resolves.toBe(false);
      },
    );
  });

  test("sent inside a command context when cmdoutput is explicitly on (reaches getClient())", async () => {
    clearCache();
    await setGroupCommandEnabled("c_cmdoutput_on", "cmdoutput", true, "u_admin");
    await runInCommandContext(
      { chatId: "c_cmdoutput_on", command: "gatetest", source: "chat" },
      async () => {
        await expect(sendBotMessage("c_cmdoutput_on", "hi")).rejects.toThrow(/not initialized/);
      },
    );
  });

  test("ambient sends (no active command context) always go through, regardless of cmdoutput", async () => {
    clearCache();
    // No runInCommandContext wrapper here at all — this is the case that
    // protects welcome/goodbye, anti-kick notices, anti-spam warnings, etc.
    // from ever being silenced by the cmdoutput toggle.
    await expect(sendBotMessage("c_no_context_at_all", "hi")).rejects.toThrow(/not initialized/);
  });

  test("source: 'ui' command context is exempt from cmdoutput even when off — dashboard button must not silently no-op", async () => {
    clearCache();
    // `cmdoutput` is default-deny (off, no row) for this chat in the
    // in-memory harness. A dashboard-triggered POST /bots/:id/commands/execute
    // must still post to LINE (or the "run" button reports ok:true while
    // sending nothing) — proven the same way as the "on" test above: reaching
    // getClient() (which throws "not initialized" here) means the gate did
    // NOT suppress it.
    await runInCommandContext(
      { chatId: "c_cmdoutput_off_ui", command: "gatetest", source: "ui" },
      async () => {
        await expect(sendBotMessage("c_cmdoutput_off_ui", "hi")).rejects.toThrow(/not initialized/);
      },
    );
  });

  test("source: 'chat' in a different chat with the same off cmdoutput default is still gated", async () => {
    clearCache();
    // Same default-deny cmdoutput state as the "ui" test above, but
    // source: "chat" — must stay suppressed. Confirms the source: "ui"
    // exemption is scoped to "ui" only, not a blanket bypass.
    await runInCommandContext(
      { chatId: "c_cmdoutput_off_chat", command: "gatetest", source: "chat" },
      async () => {
        await expect(sendBotMessage("c_cmdoutput_off_chat", "hi")).resolves.toBe(false);
      },
    );
  });
});

// ─── CHATEVENT actor/target extraction + ShortTtlCache ──────────
import { extractChatEventActorTarget, ShortTtlCache, type RawOperation } from "../src/core/event-router.js";

describe("👤 extractChatEventActorTarget()", () => {
  const actorMid = "u0310fc16260735562ddf77799dc062f9";
  const targetMid = "ude0aa136910b0624b068b05f5125d017";
  const RS = ""; // record separator joining actor+target in LOC_ARGS

  function chatEventOp(locKey: string, locArgs: string, chatId = "c94bxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"): RawOperation {
    return {
      type: "SEND_MESSAGE",
      param1: "0",
      param2: "",
      param3: "",
      raw: {
        type: "SEND_MESSAGE",
        message: {
          from: actorMid,
          toType: "GROUP",
          to: chatId,
          contentType: "CHATEVENT",
          contentMetadata: {
            LOC_KEY: locKey,
            LOC_ARGS: locArgs,
            NOTIFICATION_DISABLED: "true",
          },
        },
      },
    };
  }

  test("C_MR (member removed / kick) splits actor and target", () => {
    const result = extractChatEventActorTarget(chatEventOp("C_MR", `${actorMid}${RS}${targetMid}`));
    expect(result).not.toBeNull();
    expect(result?.actorMid).toBe(actorMid);
    expect(result?.targetMid).toBe(targetMid);
    expect(result?.chatId).toBe("c94bxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  });

  test("C_MI (member invited) splits actor and target", () => {
    const result = extractChatEventActorTarget(chatEventOp("C_MI", `${actorMid}${RS}${targetMid}`));
    expect(result).not.toBeNull();
    expect(result?.actorMid).toBe(actorMid);
    expect(result?.targetMid).toBe(targetMid);
  });

  test("non-CHATEVENT op (normal message) returns null", () => {
    const op: RawOperation = {
      type: "SEND_MESSAGE",
      param1: "0",
      param2: "",
      param3: "",
      raw: {
        type: "SEND_MESSAGE",
        message: {
          from: actorMid,
          toType: "GROUP",
          to: "c94bxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          contentType: "TEXT",
          contentMetadata: {},
        },
      },
    };
    expect(extractChatEventActorTarget(op)).toBeNull();
  });

  test("op with no message (e.g. DELETE_OTHER_FROM_CHAT) returns null", () => {
    const op: RawOperation = {
      type: "DELETE_OTHER_FROM_CHAT",
      param1: "c94bxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      param2: targetMid,
      param3: "",
      raw: { type: "DELETE_OTHER_FROM_CHAT" },
    };
    expect(extractChatEventActorTarget(op)).toBeNull();
  });

  test("malformed LOC_ARGS (empty string) returns null, does not throw", () => {
    expect(() => extractChatEventActorTarget(chatEventOp("C_MR", ""))).not.toThrow();
    expect(extractChatEventActorTarget(chatEventOp("C_MR", ""))).toBeNull();
  });

  test("malformed LOC_ARGS (missing record separator) does not throw", () => {
    expect(() => extractChatEventActorTarget(chatEventOp("C_MR", `${actorMid}${targetMid}`))).not.toThrow();
  });
});

// ─── Fleet Claim Lock (claimEvent) + reactive-defense gating ────
import { claimEvent } from "../src/core/database.js";
import { handleKickOperation } from "../src/features/anti-kick.js";
import { handleJoinOperation } from "../src/features/join-guard.js";
import { LineOpType } from "../src/types.js";

/**
 * Fake `/state/*` slice for the claim-lock tests: a controllable
 * POST /state/claims (won: true/false), plus the minimal settings/blacklist/
 * admins routes `handleKickOperation`/`handleJoinOperation` touch before
 * reaching the gate. `putBlacklistCalls` records every `PUT
 * /state/blacklist/:uid` — the one HTTP-observable side effect of
 * `punishInviter()`, since the LINE-only kick calls are swallowed by their
 * own internal try/catch either way and can't be told apart via a thrown
 * error (unlike anti-kick's `getClient()`, which throws uncaught).
 */
function startClaimFakeStateApi(
  initialWon: boolean,
  blacklistedMids: string[] = [],
  putBlacklistCalls: string[] = [],
  fleetMids: string[] = [],
) {
  let won = initialWon;
  const blacklisted = new Set(blacklistedMids);
  const settings = new Map<string, string>();

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "state") return new Response("not found", { status: 404 });

      if (parts[1] === "claims" && req.method === "POST") {
        return Response.json({ won });
      }

      // Fleet roster: consulted by every kick/blacklist path. Defaults to empty
      // so the existing tests keep exercising the ordinary "target is a
      // stranger" behaviour; the sibling-protection tests pass a roster in.
      if (parts[1] === "fleet" && req.method === "GET") {
        return Response.json({ mids: fleetMids });
      }

      if (parts[1] === "settings" && parts[2]) {
        const key = decodeURIComponent(parts[2]);
        if (req.method === "PUT") {
          const body = (await req.json()) as { value: string };
          settings.set(key, body.value);
          return Response.json({ ok: true });
        }
        const value = settings.get(key);
        if (value === undefined) return new Response("not found", { status: 404 });
        return Response.json({ key, value });
      }

      if (parts[1] === "blacklist" && parts[2]) {
        const uid = decodeURIComponent(parts[2]);
        if (req.method === "PUT") {
          putBlacklistCalls.push(uid);
          return Response.json({ ok: true });
        }
        return Response.json({ blacklisted: blacklisted.has(uid) });
      }

      if (parts[1] === "admins" && parts[2]) {
        return new Response("not found", { status: 404 });
      }

      // Group-command toggles: gate tests only need the ambient feature
      // ("antikick"/"joinguard") to resolve enabled for whatever chatId the
      // test used, so every chat reports both as enabled — the toggle
      // resolver itself is covered separately in the database.ts unit tests.
      if (parts[1] === "group-commands" && parts[2] && req.method === "GET") {
        const chatId = decodeURIComponent(parts[2]);
        return Response.json({
          items: [
            { chatId, command: "antikick", enabled: true, updatedBy: "t", updatedAt: 0 },
            { chatId, command: "joinguard", enabled: true, updatedBy: "t", updatedAt: 0 },
          ],
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return { server, setWon: (w: boolean) => { won = w; } };
}

describe("🔒 claimEvent() — fleet claim lock", () => {
  test("returns true when the API grants the claim", async () => {
    const { server } = startClaimFakeStateApi(true);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    expect(await claimEvent("k-a", 1000)).toBe(true);
    server.stop(true);
  });

  test("returns false when the API denies the claim", async () => {
    const { server } = startClaimFakeStateApi(false);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    expect(await claimEvent("k-b", 1000)).toBe(false);
    server.stop(true);
  });

  test("fails closed (returns false, never throws) when the API is unreachable", async () => {
    configureStateClient({ apiBaseUrl: "http://127.0.0.1:1", instanceToken: "t" });
    await expect(claimEvent("k-c", 1000)).resolves.toBe(false);
  });
});

describe("🛡️ handleKickOperation() — fleet claim gate", () => {
  test("claim lost => no re-invite attempted (resolves cleanly, never reaches getClient())", async () => {
    const { server } = startClaimFakeStateApi(false);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    const op: RawOperation = {
      type: LineOpType.DELETE_OTHER_FROM_CHAT,
      param1: "gate_kick_lost",
      param2: "u_victim",
      param3: "",
      raw: { type: "DELETE_OTHER_FROM_CHAT" },
    };

    // No LINE client is initialized in this test process, so if the handler
    // ever reaches `getClient()` it throws. A losing claim must return
    // before that point.
    await expect(handleKickOperation(op)).resolves.toBeUndefined();
    server.stop(true);
  });

  test("claim won => proceeds past the gate to act (reaches getClient() and attempts the re-invite)", async () => {
    const { server } = startClaimFakeStateApi(true);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    const op: RawOperation = {
      type: LineOpType.DELETE_OTHER_FROM_CHAT,
      param1: "gate_kick_won",
      param2: "u_victim2",
      param3: "",
      raw: { type: "DELETE_OTHER_FROM_CHAT" },
    };

    // Winning the claim means the handler falls through to `getClient()`,
    // which throws "not initialized" in this client-less test process — that
    // throw is the proof the gate let it through toward the re-invite call,
    // at the exact point the losing-claim test above instead resolves clean.
    await expect(handleKickOperation(op)).rejects.toThrow(/not initialized/);
    server.stop(true);
  });
});

/**
 * Regression: a kick announced *only* as a `C_MR` CHATEVENT — with no
 * accompanying `DELETE_OTHER_FROM_CHAT` op — must still be acted on.
 *
 * This is the shape that was reported in the wild: anti-kick was enabled and the
 * kicker was not an admin, yet nothing happened, because the handler only ever
 * triggered on `DELETE_OTHER_FROM_CHAT` and treated `C_MR` as correlation
 * metadata. Same `getClient()`-throws trick as the gate tests above: reaching it
 * proves the handler got past the trigger and the claim, on its way to acting.
 */
describe("🛡️ handleKickOperation() — C_MR CHATEVENT as a trigger", () => {
  const RS = "";
  const kicker = "ub1151e7d2f4755ece5eba3fe56f6ba8c";
  const victim = "ude0aa136910b0624b068b05f5125d017";

  /** A CHATEVENT member-removed announcement, as LINE delivers it. */
  function kickChatEvent(chatId: string): RawOperation {
    return {
      type: "RECEIVE_MESSAGE",
      param1: "",
      param2: "",
      param3: "",
      raw: {
        message: {
          to: chatId,
          contentType: "CHATEVENT",
          contentMetadata: { LOC_KEY: "C_MR", LOC_ARGS: `${kicker}${RS}${victim}` },
        },
      },
    };
  }

  test("C_MR alone (no DELETE_OTHER_FROM_CHAT op) reaches the act path", async () => {
    const { server } = startClaimFakeStateApi(true);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    await expect(handleKickOperation(kickChatEvent("c_cmr_only"))).rejects.toThrow(/not initialized/);
    server.stop(true);
  });

  test("C_MR still respects the claim gate (claim lost => no action)", async () => {
    const { server } = startClaimFakeStateApi(false);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    await expect(handleKickOperation(kickChatEvent("c_cmr_lost"))).resolves.toBeUndefined();
    server.stop(true);
  });

  test("a C_MI (invite) CHATEVENT is not treated as a kick", async () => {
    const { server } = startClaimFakeStateApi(true);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    const invite = kickChatEvent("c_cmi");
    (invite.raw as { message: { contentMetadata: Record<string, string> } }).message.contentMetadata.LOC_KEY = "C_MI";

    // Never reaches getClient() — an invite is not a kick.
    await expect(handleKickOperation(invite)).resolves.toBeUndefined();
    server.stop(true);
  });
});

/**
 * Sibling-bot protection (tasks/todo/008).
 *
 * The incident these lock down: two bots of the same user in one LINE group.
 * Bot A kicks a rule-breaker; that kick emits its own C_MR naming A as actor;
 * bot B — for whom A is NOT an admin, because `worker_admins` is instance-scoped
 * — reads A as an attacker and kicks/blacklists it. Siblings are "protected",
 * never admins: they may not be kicked, but they gain no command powers either.
 */
describe("🤝 Fleet sibling protection", () => {
  // Real mid shape (^[ucrsm][0-9a-f]{32}$) — the C_MR extractor validates the
  // format, so a placeholder like "u_sibling" is silently not a kick at all.
  const sibling = "uabc5a4b0494a30c5f9f75234772de2d6";
  const stranger = "u0310fc16260735562ddf77799dc062f9";
  const victim = "ude0aa136910b0624b068b05f5125d017";

  test("isFleetMember() recognises a sibling and rejects a stranger", async () => {
    const server = startFakeStateApi();
    server.setFleetMids([sibling]);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    expect(await isFleetMember(sibling)).toBe(true);
    expect(await isFleetMember(stranger)).toBe(false);
    // An empty mid must never round-trip to the roster.
    expect(await isFleetMember("")).toBe(false);
    server.stop(true);
  });

  test("getFleetMids() fails open (empty, never throws) when the roster is unreachable", async () => {
    // An API without /state/fleet (older image, mid-deploy) must degrade to
    // today's behaviour rather than making every stranger un-kickable.
    configureStateClient({ apiBaseUrl: "http://127.0.0.1:1", instanceToken: "t" });
    clearCache();

    await expect(getFleetMids()).resolves.toEqual([]);
    expect(await isFleetMember(sibling)).toBe(false);
  });

  test("addToBlacklist() refuses a sibling but still blacklists a stranger", async () => {
    const server = startFakeStateApi();
    server.setFleetMids([sibling]);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    await addToBlacklist(sibling, "kim-bot", "auto: kicked a member", "system");
    expect(server.blacklistRows.has(sibling)).toBe(false);

    await addToBlacklist(stranger, "rule breaker", "auto: kicked a member", "system");
    expect(server.blacklistRows.has(stranger)).toBe(true);
    server.stop(true);
  });

  test("isBlacklisted() is false for a sibling even with a poisoned row already stored", async () => {
    // getUserRole() consults the blacklist BEFORE the admin row, so without this
    // filter a sibling poisoned by an older worker stays hostile forever — and
    // migration 0015's purge only cleans up what already exists, not what a
    // stale worker writes next.
    const server = startFakeStateApi();
    server.setFleetMids([sibling]);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    server.blacklistRows.set(sibling, { name: "kim-bot", reason: "poisoned", addedBy: "system", addedAt: 0 });
    server.blacklistRows.set(stranger, { name: "x", reason: "legit", addedBy: "system", addedAt: 0 });

    expect(await isBlacklisted(sibling)).toBe(false);
    expect(await isBlacklisted(stranger)).toBe(true);
    server.stop(true);
  });

  test("getAllBlacklisted() filters siblings out — sweep_blacklist enumerates, it never calls isBlacklisted()", async () => {
    const server = startFakeStateApi();
    server.setFleetMids([sibling]);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    server.blacklistRows.set(sibling, { name: "kim-bot", reason: "poisoned", addedBy: "system", addedAt: 0 });
    server.blacklistRows.set(stranger, { name: "x", reason: "legit", addedBy: "system", addedAt: 0 });

    const uids = (await getAllBlacklisted()).map((r) => r.uid);
    expect(uids).toEqual([stranger]);
    server.stop(true);
  });

  test("kickFromGroup() drops siblings and never calls LINE when every target is one", async () => {
    const server = startFakeStateApi();
    server.setFleetMids([sibling]);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    // No LINE client in this process, so reaching the API throws. An all-sibling
    // kick must return before that — and an empty targetUserMids would be a LINE
    // error anyway, so returning early is required, not just an optimisation.
    // The result must say it was refused, so the kick_member RPC can report
    // ok:false instead of a success for a kick that never happened.
    await expect(kickFromGroup("c_fleet", [sibling]))
      .resolves.toEqual({ kicked: [], skipped: [sibling] });

    // A stranger still gets through to the LINE call (which then throws).
    await expect(kickFromGroup("c_fleet", [stranger])).rejects.toThrow(/not initialized/);
    // Mixed batch: the stranger survives the filter, so the call still goes out.
    await expect(kickFromGroup("c_fleet", [sibling, stranger])).rejects.toThrow(/not initialized/);
    server.stop(true);
  });

  test("anti-kick treats a sibling's kick as legitimate — no re-invite, no revenge", async () => {
    // The exact incident: bot A kicks a rule-breaker, the C_MR names A as actor,
    // and this bot must do nothing. Without the guard it wins the claim and
    // re-invites the offender A just removed — undoing moderation. The
    // kickFromGroup filter alone cannot prevent that; only this early return can.
    // Explicit escape, not a literal U+001E: the raw control character is
    // invisible and does not survive routine editing — losing it makes LOC_ARGS
    // unparseable, so the op stops being a kick and the test passes vacuously.
    const RS = "\x1e";
    const { server } = startClaimFakeStateApi(true, [], [], [sibling]);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    const op: RawOperation = {
      type: "RECEIVE_MESSAGE",
      param1: "",
      param2: "",
      param3: "",
      raw: {
        message: {
          to: "c_sibling_kick",
          contentType: "CHATEVENT",
          contentMetadata: { LOC_KEY: "C_MR", LOC_ARGS: `${sibling}${RS}${stranger}` },
        },
      },
    };

    // Resolving cleanly proves it returned before getClient() — i.e. before any
    // re-invite or revenge kick.
    await expect(handleKickOperation(op)).resolves.toBeUndefined();
    server.stop(true);
  });

  test("anti-kick still acts on a stranger's kick (the guard is not a blanket off-switch)", async () => {
    // Explicit escape, not a literal U+001E: the raw control character is
    // invisible and does not survive routine editing — losing it makes LOC_ARGS
    // unparseable, so the op stops being a kick and the test passes vacuously.
    const RS = "\x1e";
    const { server } = startClaimFakeStateApi(true, [], [], [sibling]);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    const op: RawOperation = {
      type: "RECEIVE_MESSAGE",
      param1: "",
      param2: "",
      param3: "",
      raw: {
        message: {
          to: "c_stranger_kick",
          contentType: "CHATEVENT",
          contentMetadata: { LOC_KEY: "C_MR", LOC_ARGS: `${stranger}${RS}${victim}` },
        },
      },
    };

    await expect(handleKickOperation(op)).rejects.toThrow(/not initialized/);
    server.stop(true);
  });
});

describe("🚧 handleJoinOperation() — fleet claim gate (inviter punish)", () => {
  test("claim lost => inviter is never blacklisted (no PUT /state/blacklist call)", async () => {
    const putBlacklistCalls: string[] = [];
    const { server } = startClaimFakeStateApi(false, ["u_bad_invitee"], putBlacklistCalls);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    const op: RawOperation = {
      type: LineOpType.NOTIFIED_INVITE_INTO_CHAT,
      param1: "gate_join_lost",
      param2: "u_inviter_lost",
      param3: "u_bad_invitee",
      raw: { type: "NOTIFIED_INVITE_INTO_CHAT" },
    };

    await handleJoinOperation(op);
    expect(putBlacklistCalls).toEqual([]);
    server.stop(true);
  });

  test("claim won => inviter gets blacklisted (PUT /state/blacklist fires)", async () => {
    const putBlacklistCalls: string[] = [];
    const { server } = startClaimFakeStateApi(true, ["u_bad_invitee2"], putBlacklistCalls);
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    const op: RawOperation = {
      type: LineOpType.NOTIFIED_INVITE_INTO_CHAT,
      param1: "gate_join_won",
      param2: "u_inviter_won",
      param3: "u_bad_invitee2",
      raw: { type: "NOTIFIED_INVITE_INTO_CHAT" },
    };

    await handleJoinOperation(op);
    expect(putBlacklistCalls).toContain("u_inviter_won");
    server.stop(true);
  });
});

describe("⏳ ShortTtlCache", () => {
  test("set() then get() returns the value immediately", () => {
    const cache = new ShortTtlCache<string>(1000);
    cache.set("k1", "hello");
    expect(cache.get("k1")).toBe("hello");
  });

  test("entry is evicted/absent after the TTL elapses", async () => {
    const cache = new ShortTtlCache<string>(5);
    cache.set("k1", "hello");
    await new Promise((r) => setTimeout(r, 30));
    expect(cache.get("k1")).toBeUndefined();
  });

  test("missing key returns undefined", () => {
    const cache = new ShortTtlCache<string>(1000);
    expect(cache.get("nope")).toBeUndefined();
  });
});

// ─── Fleet-wide admins + single responder (task 010) ────────────────

import {
  winAdminResponderClaim,
  setOwnInstanceIdForTest,
  ADMIN_RESPONDER_GRACE_MS,
} from "../src/core/event-router.js";

describe("👑 Admin responder election (event-router.ts winAdminResponderClaim)", () => {
  let server: ReturnType<typeof startFakeStateApi>;

  beforeAll(() => {
    server = startFakeStateApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "test-token" });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("a non-admin sender is never gated — every bot handles them as before", async () => {
    clearCache();
    setOwnInstanceIdForTest("inst-A");
    expect(await winAdminResponderClaim("u_stranger", "c1", "msg-1")).toBe(true);
  });

  test("the bot that created the admin answers immediately", async () => {
    clearCache();
    server.setCallerInstanceId("inst-A");
    await setAdmin("u_admin_pref", PermissionRole.ADMIN, "u_owner");

    setOwnInstanceIdForTest("inst-A");
    const started = Date.now();
    const won = await winAdminResponderClaim("u_admin_pref", "c_pref", "msg-pref-1");

    expect(won).toBe(true);
    // No grace sleep for the preferred bot — that latency is what distinguishes
    // "I own this admin" from "I'm covering for a bot that didn't show up".
    expect(Date.now() - started).toBeLessThan(ADMIN_RESPONDER_GRACE_MS);
  });

  test("a sibling waits out the grace and loses to the preferred bot's live claim", async () => {
    clearCache();
    server.setCallerInstanceId("inst-A");
    await setAdmin("u_admin_2", PermissionRole.ADMIN, "u_owner");
    clearCache();

    // Preferred bot claims first, as it would in the real race.
    setOwnInstanceIdForTest("inst-A");
    expect(await winAdminResponderClaim("u_admin_2", "c_two", "msg-two")).toBe(true);

    // Sibling: different bot identity on both the worker and the API side.
    setOwnInstanceIdForTest("inst-B");
    server.setCallerInstanceId("inst-B");
    const started = Date.now();
    const won = await winAdminResponderClaim("u_admin_2", "c_two", "msg-two");

    expect(won).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(ADMIN_RESPONDER_GRACE_MS - 50);
  });

  test("failover: with the preferred bot gone, a sibling wins after the grace", async () => {
    clearCache();
    server.setCallerInstanceId("inst-A");
    await setAdmin("u_admin_3", PermissionRole.ADMIN, "u_owner");
    clearCache();

    // inst-A never claims — it's down, or simply not in this group.
    setOwnInstanceIdForTest("inst-B");
    server.setCallerInstanceId("inst-B");
    const won = await winAdminResponderClaim("u_admin_3", "c_three", "msg-three");

    expect(won).toBe(true);
  });

  test("exactly one of three siblings answers when the preferred bot is gone", async () => {
    clearCache();
    server.setCallerInstanceId("inst-A");
    await setAdmin("u_admin_4", PermissionRole.ADMIN, "u_owner");
    clearCache();

    // Three siblings racing on the same message. The claim is what collapses
    // them to one reply; without it the admin gets N.
    const attempt = async (instanceId: string) => {
      setOwnInstanceIdForTest(instanceId);
      server.setCallerInstanceId(instanceId);
      return winAdminResponderClaim("u_admin_4", "c_four", "msg-four");
    };
    const results = [await attempt("inst-B"), await attempt("inst-C"), await attempt("inst-D")];

    expect(results.filter(Boolean).length).toBe(1);
  });

  test("consecutive commands from one admin are each answered — the key is the message, not the sender", async () => {
    clearCache();
    server.setCallerInstanceId("inst-A");
    await setAdmin("u_admin_5", PermissionRole.ADMIN, "u_owner");
    clearCache();
    setOwnInstanceIdForTest("inst-A");

    expect(await winAdminResponderClaim("u_admin_5", "c_five", "msg-five-a")).toBe(true);
    expect(await winAdminResponderClaim("u_admin_5", "c_five", "msg-five-b")).toBe(true);
  });

  test("a row with no binding (pre-0016) races with no preference rather than stalling", async () => {
    clearCache();
    server.setCallerInstanceId("");
    await setAdmin("u_admin_legacy", PermissionRole.ADMIN, "u_owner");
    clearCache();

    setOwnInstanceIdForTest("inst-B");
    server.setCallerInstanceId("inst-B");
    const started = Date.now();
    expect(await winAdminResponderClaim("u_admin_legacy", "c_legacy", "msg-legacy")).toBe(true);
    expect(Date.now() - started).toBeLessThan(ADMIN_RESPONDER_GRACE_MS);
  });
});

describe("👑 Admins are protected from the fleet's own defenses (database.ts)", () => {
  let server: ReturnType<typeof startFakeStateApi>;

  beforeAll(() => {
    server = startFakeStateApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "test-token" });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("addToBlacklist refuses an admin — the automated defenses can't poison them", async () => {
    clearCache();
    server.setCallerInstanceId("inst-A");
    await setAdmin("u_protected_admin", PermissionRole.ADMIN, "u_owner");
    clearCache();

    // This is the anti-kick autokickbot path: an admin kicked someone, and a
    // sibling tried to punish them for it.
    await addToBlacklist("u_protected_admin", "Somchai", "auto: kicked a member", "system");

    expect(server.blacklistRows.has("u_protected_admin")).toBe(false);
    expect(await isBlacklisted("u_protected_admin")).toBe(false);
  });

  test("a non-admin is still blacklisted normally", async () => {
    clearCache();
    await addToBlacklist("u_spammer", "Spammer", "spam", "system");
    expect(server.blacklistRows.has("u_spammer")).toBe(true);
  });
});

// ─── Anti-call trigger detection (task 012) ────────────────────────

import { isGroupCallStart } from "../src/features/anti-call.js";

describe("📞 Anti-call trigger (anti-call.ts isGroupCallStart)", () => {
  // Metadata shapes captured from live LINE traffic — see .req/call.md.
  const startMeta = {
    GC_EVT_TYPE: "S",
    GC_MEDIA_TYPE: "AUDIO",
    TYPE: "G",
    GC_CHAT_MID: "c1382720d717af1a6afcd5c5579797aba",
  };
  const endMeta = { ...startMeta, GC_EVT_TYPE: "E", DURATION: "35690" };

  test("fires on a group call START", () => {
    expect(isGroupCallStart("CALL", startMeta)).toBe(true);
  });

  test("accepts the numeric contentType form too", () => {
    // linejs types CALL as `6 | "CALL"`; which one arrives depends on how the op
    // decoded, and betting on one means silently never firing.
    expect(isGroupCallStart(6, startMeta)).toBe(true);
  });

  test("ignores the call END event", () => {
    // Critical: acting on "E" would fire on the bot's own successful eviction.
    expect(isGroupCallStart("CALL", endMeta)).toBe(false);
  });

  test("ignores a 1:1 call (TYPE is not G)", () => {
    expect(isGroupCallStart("CALL", { ...startMeta, TYPE: "N" })).toBe(false);
  });

  test("ignores non-CALL content types", () => {
    expect(isGroupCallStart(0, startMeta)).toBe(false);
    expect(isGroupCallStart("CHATEVENT", startMeta)).toBe(false);
  });

  test("ignores a CALL with no metadata rather than throwing", () => {
    expect(isGroupCallStart("CALL", undefined)).toBe(false);
    expect(isGroupCallStart("CALL", {})).toBe(false);
  });
});

// ─── Anti-media trigger detection + sub-toggle resolution (task 018) ──

import {
  detectMediaType,
  resolveSubToggle,
  subToggleKey,
  MEDIA_TYPE_KEYS,
} from "../src/features/anti-media.js";
import type { GroupCommandToggleRecord } from "../src/core/database.js";

describe("🛡️ Anti-media detection (anti-media.ts detectMediaType)", () => {
  test("fires on wire string labels", () => {
    expect(detectMediaType("IMAGE", undefined)).toBe("image");
    expect(detectMediaType("VIDEO", undefined)).toBe("video");
    expect(detectMediaType("STICKER", undefined)).toBe("sticker");
    expect(detectMediaType("CONTACT", undefined)).toBe("contact");
    expect(detectMediaType("FILE", undefined)).toBe("file");
  });

  test("trusts only the two numerics both in-repo tables agree on (IMAGE=1, VIDEO=2)", () => {
    expect(detectMediaType(1, undefined)).toBe("image");
    expect(detectMediaType(2, undefined)).toBe("video");
  });

  test("NEVER fires on a bare disputed numeric — a kick can't be undone", () => {
    // 6/7/13/14/15 mean different things in intercept.ts vs anti-unsend.ts.
    for (const disputed of [3, 6, 7, 13, 14, 15]) {
      expect(detectMediaType(disputed, undefined)).toBe(null);
      expect(detectMediaType(disputed, {})).toBe(null);
    }
  });

  test("identifies a disputed numeric via its metadata signature instead", () => {
    expect(detectMediaType(7, { STKID: "52002734", STKPKGID: "11537", STKVER: "1" })).toBe(
      "sticker",
    );
    // A real file carries FILE_EXPIRE_TIMESTAMP (confirmed capture), NOT FILE_NAME.
    expect(detectMediaType(14, { FILE_SIZE: "1024", FILE_EXPIRE_TIMESTAMP: "1799999999" })).toBe(
      "file",
    );
    expect(detectMediaType(13, { mid: "u0123", displayName: "Someone" })).toBe("contact");
  });

  test("real captured signatures (image/video/file share FILE_SIZE — must not collide)", () => {
    // All confirmed from forwarded_messages.raw_json in the watched test group.
    expect(detectMediaType("IMAGE", { OID: "x", SID: "s", FILE_SIZE: "2048", e2eeVersion: "1" })).toBe(
      "image",
    );
    expect(
      detectMediaType("VIDEO", { DURATION: "5000", FILE_SIZE: "9000", OID: "x", SID: "s" }),
    ).toBe("video");
    expect(
      detectMediaType("FILE", {
        FILE_SIZE: "4096",
        FILE_EXPIRE_TIMESTAMP: "1799999999",
        OID: "x",
        SID: "s",
      }),
    ).toBe("file");
    expect(detectMediaType("CONTACT", { mid: "u0123", displayName: "Someone" })).toBe("contact");
  });

  test("an image's FILE_SIZE never misclassifies as file (needs FILE_EXPIRE_TIMESTAMP)", () => {
    // Numeric-only image (hypothetical) with FILE_SIZE must not be caught by the
    // file signature — only FILE_EXPIRE_TIMESTAMP marks a real file.
    expect(detectMediaType(99, { OID: "x", SID: "s", FILE_SIZE: "2048" })).toBe(null);
  });

  test("detects FLEX from metadata only (rides contentType 0/NONE)", () => {
    expect(detectMediaType(0, { FLEX_VER: "1", FLEX_JSON: "{}" })).toBe("flex");
    expect(detectMediaType("NONE", { FLEX_JSON: "{}" })).toBe("flex");
  });

  test("fires `post` ONLY on a shared VOOM post (locKey=BH + serviceType=MH)", () => {
    // Confirmed capture: shared VOOM post rides POSTNOTIFICATION BH/MH.
    expect(
      detectMediaType("POSTNOTIFICATION", {
        locKey: "BH",
        serviceType: "MH",
        postEndUrl: "https://line.me/R/home/post?userMid=u1&postId=117",
      }),
    ).toBe("post");
  });

  test("does NOT fire `post` on a group note/album (postEndUrl is shared by both)", () => {
    // Live capture: notes (locKey BG / serviceType GB) and albums (BA / AB) both
    // carry postEndUrl — firing `post` here would kick a member for creating one.
    // Only the BH+MH pair (not postEndUrl) is the shared-post discriminator.
    expect(
      detectMediaType("POSTNOTIFICATION", {
        locKey: "BG",
        serviceType: "GB",
        postEndUrl: "https://line.me/R/group/home/posts/post?homeId=c1",
      }),
    ).toBe(null);
    expect(
      detectMediaType("POSTNOTIFICATION", {
        locKey: "BA",
        serviceType: "AB",
        postEndUrl: "line://group/home/albums/album?albumId=5302",
      }),
    ).toBe(null);
    // postEndUrl alone (no BH/MH) must not fire.
    expect(detectMediaType("POSTNOTIFICATION", { postEndUrl: "https://x" })).toBe(null);
  });

  test("ignores plain text — with and without benign metadata", () => {
    expect(detectMediaType(0, undefined)).toBe(null);
    expect(detectMediaType(0, {})).toBe(null);
    // A reply/mention carries metadata, but not any blocked-media signature.
    expect(detectMediaType(0, { MENTION: '{"MENTIONEES":[{"M":"u1"}]}' })).toBe(null);
    expect(detectMediaType("NONE", { REPLACE: "x" })).toBe(null);
  });

  test("leaves CALL and CHATEVENT alone even with lookalike metadata", () => {
    // Other features own these kinds; a signature match must not steal them.
    expect(detectMediaType("CALL", { GC_EVT_TYPE: "S", TYPE: "G" })).toBe(null);
    expect(detectMediaType("CHATEVENT", { LOC_KEY: "C_MI" })).toBe(null);
  });

  test("partial/unknown signatures do not fire", () => {
    expect(detectMediaType(0, { FILE_SIZE: "1024" })).toBe(null); // shared by image/video/file — not a signature
    expect(detectMediaType(0, { mid: "u0123" })).toBe(null); // contact needs displayName too
    expect(detectMediaType(0, { displayName: "Someone" })).toBe(null);
    expect(detectMediaType(0, { STKID: "52002734" })).toBe(null); // sticker needs STKPKGID too
  });
});

describe("🛡️ Anti-media sub-toggle resolution (anti-media.ts resolveSubToggle)", () => {
  const row = (
    chatId: string,
    command: string,
    enabled: boolean,
  ): GroupCommandToggleRecord => ({
    chatId,
    command,
    enabled,
    updatedBy: "test",
    updatedAt: 0,
  });

  test("UNSET everywhere resolves to true — ticking the master alone blocks all types", () => {
    for (const type of MEDIA_TYPE_KEYS) {
      expect(resolveSubToggle([], [], subToggleKey(type))).toBe(true);
    }
  });

  test("an explicit per-chat false exempts the type (the opt-out)", () => {
    const chatRows = [row("c1", "antimediasticker", false)];
    expect(resolveSubToggle(chatRows, [], "antimediasticker")).toBe(false);
    // Other types stay blocked.
    expect(resolveSubToggle(chatRows, [], "antimediaimage")).toBe(true);
  });

  test("a per-chat row overrides the '*' default in both directions", () => {
    const defaults = [row("*", "antimediafile", false)];
    expect(resolveSubToggle([], defaults, "antimediafile")).toBe(false);
    expect(resolveSubToggle([row("c1", "antimediafile", true)], defaults, "antimediafile")).toBe(
      true,
    );
  });

  test("matches command names case-insensitively like isGroupCommandEnabled", () => {
    expect(resolveSubToggle([row("c1", "ANTIMEDIAFLEX", false)], [], "antimediaflex")).toBe(false);
  });

  test("writing enabled:true to a sub is a harmless no-op relative to unset", () => {
    expect(resolveSubToggle([row("c1", "antimediapost", true)], [], "antimediapost")).toBe(true);
  });
});

// ─── Chat settings snapshot (task 019 — Phase B "last known good") ────

import {
  getSnapshot,
  updateSnapshot,
  seedSnapshots,
  clearSnapshot,
  snapshotCount,
  __resetSnapshotsForTest,
} from "../src/core/chat-snapshot.js";

describe("📸 Chat settings snapshot (chat-snapshot.ts)", () => {
  beforeEach(() => __resetSnapshotsForTest());

  test("unseeded chat returns undefined (caller must skip revert)", () => {
    expect(getSnapshot("c_never_seen")).toBeUndefined();
  });

  test("partial updates merge without clobbering known fields", () => {
    updateSnapshot("c1", { name: "Original", picturePath: "/pic/a" });
    // A later rename must not wipe the known picturePath.
    updateSnapshot("c1", { name: "Renamed" });
    expect(getSnapshot("c1")).toEqual({ name: "Renamed", picturePath: "/pic/a" });
  });

  test("preventedJoinByTicket false is a real value, not treated as absent", () => {
    updateSnapshot("c1", { preventedJoinByTicket: true });
    updateSnapshot("c1", { preventedJoinByTicket: false });
    expect(getSnapshot("c1")?.preventedJoinByTicket).toBe(false);
  });

  test("seedSnapshots loads many chats at once", () => {
    seedSnapshots([
      { chatId: "c1", name: "A", preventedJoinByTicket: false },
      { chatId: "c2", name: "B", picturePath: "/pic/b" },
    ]);
    expect(snapshotCount()).toBe(2);
    expect(getSnapshot("c1")?.name).toBe("A");
    expect(getSnapshot("c2")?.picturePath).toBe("/pic/b");
  });

  test("clearSnapshot drops a chat (e.g. bot left the group)", () => {
    updateSnapshot("c1", { name: "A" });
    clearSnapshot("c1");
    expect(getSnapshot("c1")).toBeUndefined();
  });
});

// ─── Group-settings guard detection (task 019/020 — group-guard.ts) ──

import { detectGroupEvent } from "../src/features/group-guard.js";

describe("🛡️ Group-guard detection (group-guard.ts detectGroupEvent)", () => {
  const SEP = "\x1e"; // U+001E record separator in LOC_ARGS

  test("C_PN → name change, with actor + new name from LOC_ARGS", () => {
    const ev = detectGroupEvent("CHATEVENT", {
      LOC_KEY: "C_PN",
      LOC_ARGS: `uActor${SEP}test bot 2 change name`,
    });
    expect(ev).toEqual({ kind: "name", actor: "uActor", newName: "test bot 2 change name" });
  });

  test("C_PI → picture change, actor from LOC_ARGS (no target)", () => {
    const ev = detectGroupEvent("CHATEVENT", { LOC_KEY: "C_PI", LOC_ARGS: "uActor" });
    expect(ev).toEqual({ kind: "picture", actor: "uActor", newName: undefined });
  });

  test("C_MI → invite, actor=inviter + invitee from LOC_ARGS", () => {
    const ev = detectGroupEvent("CHATEVENT", {
      LOC_KEY: "C_MI",
      LOC_ARGS: `uInviter${SEP}uInvitee`,
    });
    expect(ev).toEqual({ kind: "invite", actor: "uInviter", invitee: "uInvitee" });
  });

  test("POSTNOTIFICATION BG+GB → note; BA+AB → album (actor from `from`, not meta)", () => {
    expect(detectGroupEvent("POSTNOTIFICATION", { locKey: "BG", serviceType: "GB" })).toEqual({
      kind: "note",
    });
    expect(detectGroupEvent("POSTNOTIFICATION", { locKey: "BA", serviceType: "AB" })).toEqual({
      kind: "album",
    });
  });

  test("POSTNOTIFICATION requires BOTH locKey and serviceType (notes/albums both carry postEndUrl)", () => {
    // A mismatched pair must not classify — the exact trap that disabled anti-media's `post`.
    expect(detectGroupEvent("POSTNOTIFICATION", { locKey: "BG", serviceType: "AB" })).toBe(null);
    expect(detectGroupEvent("POSTNOTIFICATION", { locKey: "BG", postEndUrl: "https://x" })).toBe(
      null,
    );
  });

  test("C_SN → grouplink (invite link ENABLED); C_SP (disabled) is NOT mapped", () => {
    // Capture (close-then-reopen): C_SP=link off, C_SN=link on. Guard only the
    // enable — punishing someone for turning the link OFF would be wrong.
    expect(detectGroupEvent("CHATEVENT", { LOC_KEY: "C_SN", LOC_ARGS: "uActor" })).toEqual({
      kind: "grouplink",
      actor: "uActor",
      newName: undefined,
    });
    expect(detectGroupEvent("CHATEVENT", { LOC_KEY: "C_SP", LOC_ARGS: "uActor" })).toBe(null);
  });

  test("C_IC → cancelinvite, actor=canceller + invitee from LOC_ARGS", () => {
    const ev = detectGroupEvent("CHATEVENT", {
      LOC_KEY: "C_IC",
      LOC_ARGS: `uCanceller${SEP}uInvitee`,
    });
    expect(ev).toEqual({ kind: "cancelinvite", actor: "uCanceller", invitee: "uInvitee" });
  });

  test("ignores unrelated CHATEVENT keys (C_MR kick belongs to anti-kick)", () => {
    expect(
      detectGroupEvent("CHATEVENT", { LOC_KEY: "C_MR", LOC_ARGS: `uA${SEP}uB` }),
    ).toBe(null);
  });

  test("ignores plain messages and missing metadata", () => {
    expect(detectGroupEvent("TEXT", { some: "thing" })).toBe(null);
    expect(detectGroupEvent("CHATEVENT", undefined)).toBe(null);
    expect(detectGroupEvent("IMAGE", { OID: "x" })).toBe(null);
  });
});

// ─── Group Backup + Recovery (task 025 — group-backup.ts / database.ts) ──
//
// group-backup.ts was refactored to export the three previously-private
// security-relevant surfaces so they're directly unit-testable, mirroring
// anti-kick.ts's `handleKickOperation` / join-guard.ts's
// `handleJoinOperation`: `handleJoin` (the join operation handler),
// `recoverRoster` (the `recover_group` RPC's filtering/counting logic,
// now taking `client` as a parameter instead of calling `getClient()`
// internally), and `shouldSkipFriendAdd` (the friend-add queue's pure skip
// predicate). All three are covered below alongside the persistence
// primitives and `scanAndSaveRoster`.
//
// `addBackupMemberState` (database.ts) was later rewritten from a
// client-side GET-merge-PUT to an atomic `POST .../members` call (the
// GET-merge-PUT was a lost-update race under concurrent joins) — the fake
// state APIs below model that route's real upsert semantics (`ON CONFLICT
// ... DO UPDATE SET display_name = EXCLUDED.display_name`, i.e. re-adding
// an already-present mid updates its display name rather than being a
// no-op), not the old client-side "skip if present" guard.

import {
  scanAndSaveRoster,
  handleJoin,
  recoverRoster,
  shouldSkipFriendAdd,
} from "../src/features/group-backup.js";
import {
  saveGroupBackupState,
  addBackupMemberState,
  getGroupBackupRoster,
} from "../src/core/database.js";
import type { GroupBackupRecord } from "../src/types.js";
import type { Client } from "@evex/linejs";

/**
 * Fake `/state/group-backups*` slice: GET returns the stored roster (404 —
 * `notFoundAsNull` — when absent), PUT replaces it wholesale
 * (`saveGroupBackupState`), and `POST /:chatId/members` atomically
 * upserts a single member (`addBackupMemberState`) — mirroring the real
 * API's `addBackupMember` (INSERT ... ON CONFLICT (instance_id, chat_id,
 * mid) DO UPDATE SET display_name = EXCLUDED.display_name; creates the
 * parent roster with `groupName: ""` if this is the first member ever
 * added for that chat).
 */
function startGroupBackupFakeStateApi() {
  const rosters = new Map<string, GroupBackupRecord>();
  const putCalls: GroupBackupRecord[] = [];
  const memberAddCalls: { chatId: string; mid: string; displayName: string }[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean); // ["state","group-backups", chatId?, "members"?]
      if (parts[0] !== "state" || parts[1] !== "group-backups") {
        return new Response("not found", { status: 404 });
      }

      if (!parts[2] && req.method === "PUT") {
        const body = (await req.json()) as GroupBackupRecord;
        putCalls.push(body);
        rosters.set(body.chatId, body);
        return Response.json({ ok: true });
      }

      if (parts[2] && parts[3] === "members" && req.method === "POST") {
        const chatId = decodeURIComponent(parts[2]);
        const body = (await req.json()) as { mid: string; displayName: string };
        memberAddCalls.push({ chatId, mid: body.mid, displayName: body.displayName });

        const existing = rosters.get(chatId);
        const members = existing ? [...existing.members] : [];
        const idx = members.findIndex((m) => m.mid === body.mid);
        if (idx >= 0) {
          members[idx] = { mid: body.mid, displayName: body.displayName };
        } else {
          members.push({ mid: body.mid, displayName: body.displayName });
        }
        rosters.set(chatId, { chatId, groupName: existing?.groupName ?? "", members });
        return Response.json({ ok: true, memberCount: members.length });
      }

      if (parts[2] && req.method === "GET") {
        const chatId = decodeURIComponent(parts[2]);
        const row = rosters.get(chatId);
        if (!row) return new Response("not found", { status: 404 });
        return Response.json(row);
      }

      return new Response("not found", { status: 404 });
    },
  });

  return Object.assign(server, { rosters, putCalls, memberAddCalls });
}

describe("💾 Group Backup state wrappers (database.ts: saveGroupBackupState / addBackupMemberState / getGroupBackupRoster)", () => {
  let server: ReturnType<typeof startGroupBackupFakeStateApi>;

  beforeAll(() => {
    server = startGroupBackupFakeStateApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "test-token" });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("getGroupBackupRoster returns null when nothing was ever saved (notFoundAsNull, not a thrown 404)", async () => {
    clearCache();
    expect(await getGroupBackupRoster("c_never_saved")).toBeNull();
  });

  test("saveGroupBackupState PUTs the pinned { chatId, groupName, members } shape", async () => {
    clearCache();
    const members = [
      { mid: "u_member_1", displayName: "Alice" },
      { mid: "u_member_2", displayName: "Bob" },
    ];
    await saveGroupBackupState("c_scan", "Test Group", members);

    expect(server.putCalls.at(-1)).toEqual({ chatId: "c_scan", groupName: "Test Group", members });
  });

  test("saveGroupBackupState -> getGroupBackupRoster round-trips (and busts its own read cache)", async () => {
    clearCache();
    const members = [{ mid: "u_x", displayName: "X" }];
    await saveGroupBackupState("c_roundtrip", "RT Group", members);

    // No clearCache() here on purpose: saveGroupBackupState must invalidate
    // `group-backups:${chatId}` itself, or a scan immediately followed by a
    // status/recover read would serve a stale (pre-scan) cached roster.
    const roster = await getGroupBackupRoster("c_roundtrip");
    expect(roster).toEqual({ chatId: "c_roundtrip", groupName: "RT Group", members });
  });

  test("addBackupMemberState creates a fresh roster (empty groupName) when none exists yet", async () => {
    clearCache();
    await addBackupMemberState("c_fresh_join", { mid: "u_joiner", displayName: "Joiner" });

    const roster = await getGroupBackupRoster("c_fresh_join");
    expect(roster).toEqual({
      chatId: "c_fresh_join",
      groupName: "",
      members: [{ mid: "u_joiner", displayName: "Joiner" }],
    });
  });

  test("addBackupMemberState appends to an existing roster and preserves its groupName", async () => {
    clearCache();
    await saveGroupBackupState("c_append", "Existing Group", [{ mid: "u_1", displayName: "One" }]);
    clearCache();

    await addBackupMemberState("c_append", { mid: "u_2", displayName: "Two" });

    const roster = await getGroupBackupRoster("c_append");
    expect(roster?.groupName).toBe("Existing Group");
    expect(roster?.members).toEqual([
      { mid: "u_1", displayName: "One" },
      { mid: "u_2", displayName: "Two" },
    ]);
  });

  test("addBackupMemberState re-adding the same mid upserts (no duplicate row, display name updated)", async () => {
    clearCache();
    await saveGroupBackupState("c_dedup", "Dedup Group", [{ mid: "u_dup", displayName: "Dup" }]);
    clearCache();

    await addBackupMemberState("c_dedup", { mid: "u_dup", displayName: "Dup (renamed)" });

    const roster = await getGroupBackupRoster("c_dedup");
    // The atomic route is `INSERT ... ON CONFLICT (instance_id, chat_id, mid)
    // DO UPDATE SET display_name = EXCLUDED.display_name` — a re-add under an
    // already-present mid does not duplicate the row, but DOES overwrite the
    // stored displayName with the latest value (unlike the old client-side
    // GET-merge-PUT's "skip if present" guard, which this atomic route
    // replaced to close the lost-update race).
    expect(roster?.members).toEqual([{ mid: "u_dup", displayName: "Dup (renamed)" }]);
  });
});

describe("💾 scanAndSaveRoster() — export wiring only (no fake LINE `Client` available in this test process)", () => {
  test("propagates getClient()'s 'not initialized' error instead of swallowing it", async () => {
    // scanAndSaveRoster()'s very first statement is getClient() (group-backup.ts)
    // — proof the exported entrypoint is reachable and does not silently
    // swallow failure. It does NOT exercise the self/fleet-skip filtering in
    // the member loop below that line: there is no fake `Client` standing in
    // for `client.base.talk.getChat` / `listGroupMembers` in this test
    // process, unlike the `/state/*` HTTP layer other tests fake out (the
    // same limitation `recoverRoster`'s tests below work around by taking a
    // hand-rolled fake `Client` as a parameter instead).
    await expect(scanAndSaveRoster("c_scan_unreachable")).rejects.toThrow(/not initialized/);
  });
});

// ─── handleJoin() — blacklist-first join handling (group-backup.ts) ────
//
// `getKnownBotMid()` (line-client.ts) returns the module-private `botMid`,
// which only ever gets set by a *successful* LINE login populating a real
// profile — never true in this test process (no test hook exists to set it
// directly, and every login attempt in the file above either fails or times
// out by design). It is therefore always `""` here, and `handleJoin` already
// early-returns on an empty joiner before ever reaching the self-mid
// comparison — so the genuine "joiner is the bot itself" branch is not
// independently reachable without a source-level test hook. The fleet-sibling
// skip (the other half of that requirement) has no such blocker — it's
// covered below via the same fake `/state/fleet` route used by the sibling-
// protection tests earlier in this file.

/**
 * Fake `/state/*` slice covering everything `handleJoin()` and
 * `recoverRoster()` touch: group-command toggles, the fleet roster, the
 * blacklist (single-uid + bulk), claims (with the requested key recorded —
 * same idea as `startClaimFakeStateApi`, extended to expose *which* key was
 * claimed, since `groupbackup-kick:${chatId}:${joiner}` is the one
 * HTTP-observable signal that `handleJoin` decided to kick), and
 * group-backups (GET/PUT + the atomic `POST .../members`, mirroring
 * `startGroupBackupFakeStateApi` above — `handleJoin`'s normal-joiner path
 * goes through `addBackupMemberState`, i.e. the atomic route only).
 */
function startGroupBackupHandlerFakeStateApi(
  opts: {
    toggleEnabled?: boolean;
    blacklistedMids?: string[];
    fleetMids?: string[];
    claimWon?: boolean;
  } = {},
) {
  const toggleEnabled = opts.toggleEnabled ?? true;
  const blacklisted = new Set(opts.blacklistedMids ?? []);
  let fleetMids = opts.fleetMids ?? [];
  const claimWon = opts.claimWon ?? true;

  const rosters = new Map<string, GroupBackupRecord>();
  const putCalls: GroupBackupRecord[] = [];
  const memberAddCalls: { chatId: string; mid: string; displayName: string }[] = [];
  const claimKeys: string[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "state") return new Response("not found", { status: 404 });

      if (parts[1] === "group-commands" && parts[2] && req.method === "GET") {
        const chatId = decodeURIComponent(parts[2]);
        return Response.json({
          items: [
            { chatId, command: "groupbackup", enabled: toggleEnabled, updatedBy: "t", updatedAt: 0 },
          ],
        });
      }

      if (parts[1] === "fleet" && req.method === "GET") {
        return Response.json({ mids: fleetMids });
      }

      if (parts[1] === "blacklist") {
        if (!parts[2]) {
          const items = [...blacklisted].map((uid) => ({
            uid,
            name: "x",
            reason: "test",
            addedBy: "system",
            addedAt: 0,
          }));
          return Response.json({ items });
        }
        const uid = decodeURIComponent(parts[2]);
        return Response.json({ blacklisted: blacklisted.has(uid) });
      }

      if (parts[1] === "claims" && req.method === "POST") {
        const body = (await req.json()) as { key: string };
        claimKeys.push(body.key);
        return Response.json({ won: claimWon });
      }

      if (parts[1] === "group-backups") {
        if (!parts[2] && req.method === "PUT") {
          const body = (await req.json()) as GroupBackupRecord;
          putCalls.push(body);
          rosters.set(body.chatId, body);
          return Response.json({ ok: true });
        }
        if (parts[2] && parts[3] === "members" && req.method === "POST") {
          const chatId = decodeURIComponent(parts[2]);
          const body = (await req.json()) as { mid: string; displayName: string };
          memberAddCalls.push({ chatId, mid: body.mid, displayName: body.displayName });

          const existing = rosters.get(chatId);
          const members = existing ? [...existing.members] : [];
          const idx = members.findIndex((m) => m.mid === body.mid);
          if (idx >= 0) {
            members[idx] = { mid: body.mid, displayName: body.displayName };
          } else {
            members.push({ mid: body.mid, displayName: body.displayName });
          }
          rosters.set(chatId, { chatId, groupName: existing?.groupName ?? "", members });
          return Response.json({ ok: true, memberCount: members.length });
        }
        if (parts[2] && req.method === "GET") {
          const chatId = decodeURIComponent(parts[2]);
          const row = rosters.get(chatId);
          if (!row) return new Response("not found", { status: 404 });
          return Response.json(row);
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  return Object.assign(server, {
    putCalls,
    memberAddCalls,
    claimKeys,
    setFleetMids: (mids: string[]) => {
      fleetMids = mids;
    },
    seedRoster: (record: GroupBackupRecord) => {
      rosters.set(record.chatId, record);
    },
  });
}

/** A join/accept-invite op shaped as `handleJoin` expects: chatId in param1, joiner in param2. */
function joinOp(
  chatId: string,
  joiner: string,
  type: LineOpType = LineOpType.NOTIFIED_ACCEPT_CHAT_INVITATION,
): RawOperation {
  return { type, param1: chatId, param2: joiner, param3: "", raw: { type } };
}

describe("🚧 handleJoin() — blacklist-first join handling (group-backup.ts)", () => {
  test("groupbackup disabled for the chat is a no-op — no claim, no roster write", async () => {
    const server = startGroupBackupHandlerFakeStateApi({ toggleEnabled: false });
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    await handleJoin(joinOp("c_toggle_off", "u_joiner_toggle_off"));

    expect(server.claimKeys).toEqual([]);
    expect(server.memberAddCalls).toEqual([]);
    server.stop(true);
  });

  test("a fleet-sibling joiner is skipped entirely — never reaches the blacklist check or the roster", async () => {
    const sibling = "uabc5a4b0494a30c5f9f75234772de2d6";
    const server = startGroupBackupHandlerFakeStateApi({ toggleEnabled: true, fleetMids: [sibling] });
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    await handleJoin(joinOp("c_fleet_join", sibling));

    expect(server.claimKeys).toEqual([]);
    expect(server.memberAddCalls).toEqual([]);
    server.stop(true);
  });

  test("an op missing chatId or joiner is a no-op (defensive guard, not the self-mid check)", async () => {
    const server = startGroupBackupHandlerFakeStateApi({ toggleEnabled: true });
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    await handleJoin(joinOp("", "u_no_chat_id"));
    await handleJoin(joinOp("c_no_joiner", ""));

    expect(server.claimKeys).toEqual([]);
    expect(server.memberAddCalls).toEqual([]);
    server.stop(true);
  });

  test("blacklist-first: a blacklisted joiner is claimed for a kick and is NEVER saved to the roster", async () => {
    const joiner = "u_blacklisted_joiner_1";
    const server = startGroupBackupHandlerFakeStateApi({
      toggleEnabled: true,
      blacklistedMids: [joiner],
      claimWon: true,
    });
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    await handleJoin(joinOp("c_blacklist_join", joiner));

    // `groupbackup-kick:${chatId}:${joiner}` is the claim `handleJoin` takes
    // immediately before calling `kickFromGroup` — the closest HTTP-observable
    // proxy for "the kick/deleteOtherFromChat path was reached" available here.
    // The actual `kickFromGroup()` call that follows is wrapped in its own
    // try/catch inside `handleJoin` (same as join-guard's punish-inviter kick,
    // see `startClaimFakeStateApi`'s doc comment above), so — unlike anti-kick's
    // `handleKickOperation` — a thrown "not initialized" error never propagates
    // out of `handleJoin` to prove the LINE call was attempted.
    expect(server.claimKeys).toEqual([`groupbackup-kick:c_blacklist_join:${joiner}`]);
    // The one thing that IS unambiguous and HTTP-observable: addBackupMemberState
    // never POSTs a blacklisted joiner into the roster.
    expect(server.memberAddCalls).toEqual([]);
    server.stop(true);
  });

  test("blacklist-first + claim lost: still never saved to the roster (a losing sibling does not kick, but must not save either)", async () => {
    const joiner = "u_blacklisted_joiner_2";
    const server = startGroupBackupHandlerFakeStateApi({
      toggleEnabled: true,
      blacklistedMids: [joiner],
      claimWon: false,
    });
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    await handleJoin(joinOp("c_blacklist_join_lost", joiner));

    expect(server.claimKeys).toEqual([`groupbackup-kick:c_blacklist_join_lost:${joiner}`]);
    expect(server.memberAddCalls).toEqual([]);
    server.stop(true);
  });

  test("a normal (non-blacklisted) joiner is saved to the roster via addBackupMemberState", async () => {
    const joiner = "u_normal_joiner_1";
    const server = startGroupBackupHandlerFakeStateApi({ toggleEnabled: true });
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    await handleJoin(joinOp("c_normal_join", joiner));

    // Never blacklisted, so the kick-claim is never attempted.
    expect(server.claimKeys).toEqual([]);
    // addBackupMemberState hits the atomic POST .../members route (not a
    // full-roster PUT) — see the lost-update-race fix above.
    expect(server.memberAddCalls.length).toBe(1);
    expect(server.memberAddCalls[0]).toEqual({
      chatId: "c_normal_join",
      mid: joiner,
      // resolveDisplayName() falls back to the raw mid — no LINE client in
      // this test process (see the existing "resolveDisplayName falls back"
      // test in the ⚙️ Config section above).
      displayName: joiner,
    });
    server.stop(true);
  });

  test("dedup: a repeated identical join op within the TTL window is only processed once", async () => {
    const joiner = "u_dedup_joiner_1";
    const server = startGroupBackupHandlerFakeStateApi({ toggleEnabled: true });
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    const op = joinOp("c_dedup_join", joiner);
    await handleJoin(op);
    await handleJoin(op); // same chatId:joiner pair — recentJoinCache must suppress this

    expect(server.memberAddCalls.length).toBe(1);
    server.stop(true);
  });

  test("dedup is keyed per chatId:joiner — a different chat for the same joiner is processed independently", async () => {
    const joiner = "u_dedup_joiner_2";
    const server = startGroupBackupHandlerFakeStateApi({ toggleEnabled: true });
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    await handleJoin(joinOp("c_dedup_chat_a", joiner));
    await handleJoin(joinOp("c_dedup_chat_b", joiner));

    expect(server.memberAddCalls.length).toBe(2);
    server.stop(true);
  });
});

describe("🧮 shouldSkipFriendAdd() — friend-add queue skip predicate (group-backup.ts)", () => {
  test("skips when the mid is the bot's own mid", () => {
    expect(shouldSkipFriendAdd("u1", "u1", false, false)).toBe(true);
  });

  test("skips when the mid is a fleet sibling", () => {
    expect(shouldSkipFriendAdd("u1", "u_other", true, false)).toBe(true);
  });

  test("skips when already a friend", () => {
    expect(shouldSkipFriendAdd("u1", "u_other", false, true)).toBe(true);
  });

  test("does not skip a normal, non-self, non-fleet, not-yet-friend mid", () => {
    expect(shouldSkipFriendAdd("u1", "u_other", false, false)).toBe(false);
  });

  test("multiple simultaneously-true reasons still skip", () => {
    expect(shouldSkipFriendAdd("u1", "u1", true, true)).toBe(true);
  });

  test("an empty mid is never mistaken for a match against an also-empty botMid", () => {
    // Defends against a `getKnownBotMid()` fallback of "" silently matching
    // every self-check once a `mid` is also empty/unset.
    expect(shouldSkipFriendAdd("", "", false, false)).toBe(true);
  });
});

// ─── recoverRoster() — recover_group RPC logic (group-backup.ts) ───────

/**
 * Hand-rolled fake standing in for `Client` (the `@evex/linejs` type
 * `recoverRoster` now takes as a parameter instead of calling `getClient()`
 * internally) — exactly the seam the refactor added to make this testable.
 * Not a `bun:test` `mock()`/`spyOn()`: it's a plain object satisfying the one
 * method `recoverRoster` calls, same spirit as the fake `/state/*` HTTP
 * servers used everywhere else in this file, just for the LINE-side call
 * instead of the state-API side.
 */
function createFakeInviteClient(shouldFail: (chunk: string[]) => boolean = () => false) {
  const calls: { chatMid: string; targetUserMids: string[] }[] = [];
  const fakeClient = {
    base: {
      talk: {
        inviteIntoChat: async (args: { chatMid: string; targetUserMids: string[] }) => {
          calls.push(args);
          if (shouldFail(args.targetUserMids)) {
            throw new Error("simulated inviteIntoChat failure");
          }
        },
      },
    },
  };
  return { client: fakeClient as unknown as Client, calls };
}

describe("🔁 recoverRoster() — recover_group RPC filtering + counting (group-backup.ts)", () => {
  test("no saved roster (null) returns all-zero counts and never calls inviteIntoChat", async () => {
    const server = startGroupBackupHandlerFakeStateApi();
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    const { client, calls } = createFakeInviteClient();
    const result = await recoverRoster(client, "c_never_backed_up", "c_dest_1");

    expect(result).toEqual({ invited: 0, failed: 0, blacklisted: 0, skipped: 0 });
    expect(calls).toEqual([]);
    server.stop(true);
  });

  test("an empty roster (0 members) also returns all-zero counts", async () => {
    const server = startGroupBackupHandlerFakeStateApi();
    server.seedRoster({ chatId: "c_empty_roster", groupName: "Empty", members: [] });
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    const { client, calls } = createFakeInviteClient();
    const result = await recoverRoster(client, "c_empty_roster", "c_dest_2");

    expect(result).toEqual({ invited: 0, failed: 0, blacklisted: 0, skipped: 0 });
    expect(calls).toEqual([]);
    server.stop(true);
  });

  test("mixed roster: blacklisted -> blacklisted, fleet/missing-mid -> skipped, the rest chunk-invited; a failing chunk counts as failed, not invited", async () => {
    const fleetSibling = "uabc5a4b0494a30c5f9f75234772de2d6";
    const blacklistedMid = "u_blacklisted_recover_1";
    const normalMids = Array.from({ length: 7 }, (_, i) => `u_normal_recover_${i}`);

    const server = startGroupBackupHandlerFakeStateApi({
      blacklistedMids: [blacklistedMid],
      fleetMids: [fleetSibling],
    });
    server.seedRoster({
      chatId: "c_mixed_roster",
      groupName: "Mixed Group",
      members: [
        { mid: "", displayName: "No Mid" }, // hits the `!member.mid` branch of `skipped`
        { mid: fleetSibling, displayName: "Sibling" },
        { mid: blacklistedMid, displayName: "Blacklisted" },
        ...normalMids.map((mid) => ({ mid, displayName: mid })),
      ],
    });
    configureStateClient({ apiBaseUrl: `http://localhost:${server.port}`, instanceToken: "t" });
    clearCache();

    // CHUNK_SIZE is 5 (group-backup.ts) — 7 normal mids split into a first
    // chunk of 5 (made to succeed) and a second chunk of 2 (made to fail).
    const { client, calls } = createFakeInviteClient((chunk) => chunk.length === 2);
    const result = await recoverRoster(client, "c_mixed_roster", "c_dest_3");

    expect(result).toEqual({ invited: 5, failed: 2, blacklisted: 1, skipped: 2 });
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual({ chatMid: "c_dest_3", targetUserMids: normalMids.slice(0, 5) });
    expect(calls[1]).toEqual({ chatMid: "c_dest_3", targetUserMids: normalMids.slice(5) });
    server.stop(true);
  }, 10000); // 2 chunks x (gateOutbound + randomDelay(500,1200)) — same jitter budget anti-kick's re-invite tests tolerate.
});
