/**
 * rlbotline Worker — Command Context
 *
 * Tracks the in-flight command (if any) an outbound LINE send is happening
 * inside of, via `AsyncLocalStorage`. This is its own module — not folded
 * into `event-router.ts` or `line-client.ts` — specifically to avoid a
 * `line-client ↔ event-router` import cycle: `line-client.ts` needs to read
 * the active context (to gate `sendBotMessage` on the `cmdoutput` toggle),
 * while `event-router.ts` needs to set it (around `feature.handleCommand()`).
 * `database.ts` imports neither of these two modules, so
 * `line-client.ts → database.ts` stays a clean, cycle-free import.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface CommandContext {
  chatId: string;
  command: string;
  source: "chat" | "ui";
}

const storage = new AsyncLocalStorage<CommandContext>();

/**
 * Run `fn` with `ctx` bound as the active command context. `AsyncLocalStorage`
 * follows async continuations, so any fire-and-forget send spawned inside
 * `fn` (including ones that outlive `fn`'s own awaited return) is also
 * covered by the context — this is intended, not a leak.
 */
export function runInCommandContext<T>(ctx: CommandContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** Returns the active command context, or `undefined` if none is set. */
export function getCommandContext(): CommandContext | undefined {
  return storage.getStore();
}
