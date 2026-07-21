/**
 * rlbotline Worker — Rate Limiter
 *
 * Token-bucket rate limiter to throttle LINE API calls and prevent bans.
 * Also provides sleep and jitter utilities for anti-detection.
 */

import { logger } from "./logger.js";

/**
 * Async sleep utility.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Random delay between min and max milliseconds (inclusive).
 * Used for anti-detection jitter.
 */
export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(ms);
}

/**
 * Token-bucket rate limiter.
 *
 * Allows `maxTokens` calls within `windowMs` milliseconds.
 * Callers await `acquire()` which resolves when a token is available.
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly windowMs: number;
  private lastRefill: number;

  constructor(maxTokens: number, windowMs: number) {
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillAmount = (elapsed / this.windowMs) * this.maxTokens;

    if (refillAmount > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
      this.lastRefill = now;
    }
  }

  /**
   * Acquire a token. Blocks (async) until a token is available.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate wait time until next token
    const deficit = 1 - this.tokens;
    const waitMs = Math.ceil((deficit / this.maxTokens) * this.windowMs);

    logger.debug("Rate limiter waiting", { waitMs });
    await sleep(waitMs);

    this.refill();
    this.tokens -= 1;
  }

  /**
   * Wrap an async function with rate limiting.
   * Returns a new function that acquires a token before executing.
   */
  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      await this.acquire();
      return fn(...args);
    };
  }
}

/**
 * Per-chat cooldown tracker.
 * Prevents spamming the same chat with responses too quickly.
 */
export class ChatCooldown {
  private readonly cooldownMs: number;
  private readonly lastAction: Map<string, number> = new Map();

  constructor(cooldownMs: number) {
    this.cooldownMs = cooldownMs;
  }

  /**
   * Check if an action is allowed for a given chat.
   * Returns true and records the action if the cooldown has elapsed.
   */
  tryAcquire(chatId: string): boolean {
    const now = Date.now();
    const last = this.lastAction.get(chatId) ?? 0;

    if (now - last < this.cooldownMs) {
      return false;
    }

    this.lastAction.set(chatId, now);
    return true;
  }

  /**
   * Periodically clean up old entries to prevent memory leaks.
   * Call this on an interval (e.g. every 5 minutes).
   */
  cleanup(): void {
    const now = Date.now();
    for (const [chatId, last] of this.lastAction.entries()) {
      if (now - last > this.cooldownMs * 10) {
        this.lastAction.delete(chatId);
      }
    }
  }
}

/**
 * Single process-wide limiter for OUTBOUND LINE API calls (send, invite, kick,
 * getContacts, ...). One shared bucket means concurrent features can't
 * collectively burst — everything drains at a human-like pace. Installed by
 * `line-client.ts` right after login (see `initSharedLimiter`).
 */
let sharedLimiter: RateLimiter | null = null;

export function initSharedLimiter(maxTokens: number, windowMs: number): void {
  sharedLimiter = new RateLimiter(maxTokens, windowMs);
  logger.info("Shared LINE API rate limiter installed", { maxTokens, windowMs });
}

/**
 * Wait for a token from the shared outbound limiter, then add a small random
 * "human tap" jitter so even a burst under the token cap doesn't fire back-to-
 * back. No-op if `initSharedLimiter` hasn't run yet (e.g. during login).
 */
export async function gateOutbound(): Promise<void> {
  if (!sharedLimiter) return;
  await sharedLimiter.acquire();
  await randomDelay(150, 600);
}
