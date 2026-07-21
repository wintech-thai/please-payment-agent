/**
 * rlbotline Worker — WebSocket Sync Client
 *
 * Connects to the Central API WebSocket Hub to enable Multi-Bot Sync (บอทอัพพวง).
 */

import { logger } from "./logger.js";
import { applyStateUpdate } from "./state-cache.js";
import { loadWatchedChats } from "./chat-registry.js";

// Event types
export type SyncEventType = "sync_command";

export interface SyncEvent {
  type: SyncEventType;
  command: string;
  data: Record<string, any>;
  timestamp: number;
}

type SyncCallback = (event: SyncEvent) => void;
export type RpcHandler = (args: unknown) => Promise<unknown> | unknown;

class SyncClient {
  private ws: WebSocket | null = null;
  private url: string;
  private instanceId: string;
  private callbacks: Set<SyncCallback> = new Set();
  private rpcHandlers: Map<string, RpcHandler> = new Map();
  private reconnectInterval: number = 5000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting: boolean = false;
  private isIntentionalClose: boolean = false;

  constructor() {
    // Determine WS URL
    const envUrl = process.env.SYNC_URL;
    let wsUrl = "";

    if (envUrl) {
      wsUrl = envUrl;
    } else {
      // Fallback: derive from API_BASE_URL, then fall back to WEBHOOK_URL origin.
      const apiBaseUrl = process.env.API_BASE_URL ?? "";
      if (apiBaseUrl) {
        try {
          const urlObj = new URL(apiBaseUrl);
          urlObj.protocol = urlObj.protocol === "https:" ? "wss:" : "ws:";
          urlObj.pathname = "/ws/sync";
          wsUrl = urlObj.toString();
        } catch {
          wsUrl = "ws://localhost:3000/ws/sync";
        }
      } else {
        const webhookUrl = process.env.WEBHOOK_URL ?? "";
        if (webhookUrl) {
          try {
            const urlObj = new URL(webhookUrl);
            urlObj.protocol = urlObj.protocol === "https:" ? "wss:" : "ws:";
            urlObj.pathname = "/ws/sync";
            wsUrl = urlObj.toString();
          } catch {
            wsUrl = "ws://localhost:3000/ws/sync";
          }
        } else {
          wsUrl = "ws://localhost:3000/ws/sync";
        }
      }
    }

    this.instanceId = process.env.INSTANCE_ID ?? "unknown-worker";
    this.url = `${wsUrl}?instanceId=${encodeURIComponent(this.instanceId)}`;
  }

  /**
   * Connect to the WebSocket Hub.
   */
  public connect(): void {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;

    this.isConnecting = true;
    this.isIntentionalClose = false;

    try {
      logger.info(`Connecting to Sync Hub at ${this.url}`, { context: "SyncClient" });
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        logger.info("Connected to Sync Hub", { context: "SyncClient" });
        this.isConnecting = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as SyncEvent;
          if (payload.type === "sync_command") {
            this.handleEvent(payload);
          } else if ((payload as any).type === "state_update") {
            // Push-with-ack: invalidate local cache, reply with verify hash.
            const { updateId, table, payload: data } = payload as any;
            const tableName = String(table ?? "unknown");
            const verify = applyStateUpdate(tableName, data);
            if (tableName === "watched-chats") {
              // TTL-cache invalidation alone doesn't refresh chat-registry's
              // separate in-memory Map that isWatched()/intercept.ts read.
              loadWatchedChats().catch((error) => {
                logger.error(`Failed to reload watched chats after state_update: ${String(error)}`, {
                  context: "SyncClient",
                });
              });
            }
            try {
              this.ws?.send(JSON.stringify({ type: "state_ack", updateId, verify }));
            } catch (error) {
              logger.error(`Failed to send state_ack: ${String(error)}`, { context: "SyncClient" });
            }
          } else if ((payload as any).type === "connected") {
            logger.info(`Authenticated with Hub as User ID: ${(payload as any).userId}`, { context: "SyncClient" });
          } else if ((payload as any).type === "rpc_request") {
            void this.handleRpcRequest(payload as any);
          } else if ((payload as any).error) {
            logger.error(`Hub Error: ${(payload as any).error}`, { context: "SyncClient" });
          }
        } catch (error) {
          logger.warn(`Failed to parse incoming message: ${event.data}`, { context: "SyncClient" });
        }
      };

      this.ws.onclose = () => {
        this.isConnecting = false;
        this.ws = null;
        if (!this.isIntentionalClose) {
          logger.warn("Disconnected from Sync Hub, reconnecting...", { context: "SyncClient" });
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        logger.error(`WebSocket Error: ${String(error)}`, { context: "SyncClient" });
      };
    } catch (error) {
      this.isConnecting = false;
      logger.error(`Failed to initialize WebSocket: ${String(error)}`, { context: "SyncClient" });
      this.scheduleReconnect();
    }
  }

  public disconnect(): void {
    this.isIntentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info("Disconnected manually", { context: "SyncClient" });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }

  public onEvent(callback: SyncCallback): void {
    this.callbacks.add(callback);
  }

  public offEvent(callback: SyncCallback): void {
    this.callbacks.delete(callback);
  }

  public send(command: string, data: Record<string, any> = {}): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn("Cannot send sync event: not connected", { context: "SyncClient" });
      return;
    }

    const payload: SyncEvent = {
      type: "sync_command",
      command,
      data,
      timestamp: Date.now(),
    };

    try {
      this.ws.send(JSON.stringify(payload));
      logger.info(`Sent sync event: ${command}`, { context: "SyncClient" });
    } catch (error) {
      logger.error(`Failed to send sync event: ${String(error)}`, { context: "SyncClient" });
    }
  }

  private handleEvent(event: SyncEvent): void {
    logger.info(`Received sync event: ${event.command}`, { context: "SyncClient" });
    for (const callback of this.callbacks) {
      try {
        callback(event);
      } catch (error) {
        logger.error(`Error in callback: ${String(error)}`, { context: "SyncClient" });
      }
    }
  }

  /** Register an RPC handler for API-initiated commands. */
  public onRpc(command: string, handler: RpcHandler): void {
    this.rpcHandlers.set(command, handler);
  }

  private async handleRpcRequest(payload: { rpcId?: string; command?: string; args?: unknown }): Promise<void> {
    const { rpcId, command, args } = payload;
    if (!rpcId || !command) return;
    const handler = this.rpcHandlers.get(command);
    if (!handler) {
      this.replyRpc(rpcId, null, `No handler for RPC command: ${command}`);
      return;
    }
    try {
      const result = await handler(args ?? {});
      this.replyRpc(rpcId, result, null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`RPC handler ${command} failed: ${msg}`, { context: "SyncClient" });
      this.replyRpc(rpcId, null, msg);
    }
  }

  private replyRpc(rpcId: string, result: unknown, error: string | null): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type: "rpc_response", rpcId, result, error }));
    } catch (err) {
      logger.error(`Failed to send rpc_response: ${String(err)}`, { context: "SyncClient" });
    }
  }
}

// Export singleton instance
export const syncClient = new SyncClient();
