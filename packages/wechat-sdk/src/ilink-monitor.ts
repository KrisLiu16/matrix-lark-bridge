/**
 * iLink Bot SDK — Message monitor (long-polling loop).
 *
 * EventEmitter-based message listener with:
 *   - Long-poll getUpdates loop
 *   - Automatic reconnection with exponential backoff
 *   - Graceful shutdown via AbortController
 *   - get_updates_buf state management
 */
import { EventEmitter } from "node:events";

import type { ILinkClient } from "./ilink-client.js";
import type { WeixinMessage, GetUpdatesResp } from "./ilink-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

/** Session expired error code from the server. */
const SESSION_EXPIRED_ERRCODE = -14;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface MonitorEvents {
  message: [msg: WeixinMessage];
  error: [err: Error];
  status: [status: MonitorStatus];
  connected: [];
  disconnected: [reason: string];
}

export type MonitorStatus = "polling" | "reconnecting" | "stopped" | "session_expired";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MonitorOptions {
  /** The ILinkClient instance to use. */
  client: ILinkClient;
  /** Initial get_updates_buf (for resuming from persisted state). */
  getUpdatesBuf?: string;
  /** Optional AbortSignal for external shutdown. */
  abortSignal?: AbortSignal;
  /** Filter: only emit messages from these user IDs. Empty = accept all. */
  allowFrom?: string[];
  /** Called when session expires; return true to retry after pause, false to stop. */
  onSessionExpired?: () => boolean | Promise<boolean>;
  /** Session expired pause duration (ms). Default 1 hour (per reference session-guard.ts). */
  sessionExpiredPauseMs?: number;
  /** Bot's own ilink_bot_id — messages from this ID are silently dropped. */
  botId?: string;
}

// ---------------------------------------------------------------------------
// ILinkMonitor
// ---------------------------------------------------------------------------

export class ILinkMonitor extends EventEmitter<MonitorEvents> {
  private client: ILinkClient;
  private getUpdatesBuf: string;
  private abortController: AbortController;
  private externalAbortSignal?: AbortSignal;
  private allowFrom: Set<string>;
  private running = false;
  private onSessionExpired?: () => boolean | Promise<boolean>;
  private sessionExpiredPauseMs: number;
  private botId?: string;
  /** Server-suggested timeout for next long-poll; undefined = use client default. */
  private nextPollTimeoutMs?: number;

  constructor(opts: MonitorOptions) {
    super();
    this.client = opts.client;
    this.getUpdatesBuf = opts.getUpdatesBuf ?? "";
    this.abortController = new AbortController(); // replaced on each start()
    this.externalAbortSignal = opts.abortSignal;
    this.allowFrom = new Set(opts.allowFrom ?? []);
    this.onSessionExpired = opts.onSessionExpired;
    this.sessionExpiredPauseMs = opts.sessionExpiredPauseMs ?? 60 * 60_000;
    this.botId = opts.botId;
  }

  /** Current get_updates_buf value (for persistence). */
  getState(): string {
    return this.getUpdatesBuf;
  }

  /** Whether the monitor loop is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Start the long-polling loop. Returns when stopped or aborted. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Create a fresh AbortController so stop() → start() works correctly.
    this.abortController = new AbortController();

    // Listen for external abort
    if (this.externalAbortSignal) {
      this.externalAbortSignal.addEventListener("abort", () => this.stop(), { once: true });
    }

    this.emit("status", "polling");
    this.emit("connected");

    let consecutiveFailures = 0;

    while (this.running && !this.abortController.signal.aborted) {
      try {
        const resp = await this.client.getUpdates(this.getUpdatesBuf, this.nextPollTimeoutMs);

        // Check for API errors
        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);

        if (isApiError) {
          const isSessionExpired =
            resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

          if (isSessionExpired) {
            this.emit("status", "session_expired");
            const shouldRetry = this.onSessionExpired
              ? await this.onSessionExpired()
              : true;
            if (!shouldRetry) {
              this.emit("disconnected", "session_expired");
              break;
            }
            await this.sleep(this.sessionExpiredPauseMs);
            consecutiveFailures = 0;
            continue;
          }

          consecutiveFailures++;
          this.emit("error", new Error(
            `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
          ));

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.emit("status", "reconnecting");
            consecutiveFailures = 0;
            await this.sleep(BACKOFF_DELAY_MS);
          } else {
            await this.sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        // Success
        consecutiveFailures = 0;

        // Adopt server-suggested long-poll timeout if provided
        if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
          this.nextPollTimeoutMs = resp.longpolling_timeout_ms;
        }

        // Update state
        if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
          this.getUpdatesBuf = resp.get_updates_buf;
        }

        // Emit messages
        const msgs = resp.msgs ?? [];
        for (const msg of msgs) {
          // Filter out bot's own messages to prevent loops
          if (this.botId && msg.from_user_id === this.botId) {
            continue;
          }
          // Apply allowFrom filter
          if (this.allowFrom.size > 0 && msg.from_user_id && !this.allowFrom.has(msg.from_user_id)) {
            continue;
          }
          this.emit("message", msg);
        }
      } catch (err) {
        if (this.abortController.signal.aborted) break;

        consecutiveFailures++;
        this.emit("error", err instanceof Error ? err : new Error(String(err)));

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.emit("status", "reconnecting");
          consecutiveFailures = 0;
          await this.sleep(BACKOFF_DELAY_MS);
        } else {
          await this.sleep(RETRY_DELAY_MS);
        }
      }
    }

    this.running = false;
    this.emit("status", "stopped");
    this.emit("disconnected", "stopped");
  }

  /** Stop the monitor loop. */
  stop(): void {
    this.running = false;
    this.abortController.abort();
  }

  /** Add a user ID to the allowFrom filter. */
  addAllowedUser(userId: string): void {
    this.allowFrom.add(userId);
  }

  /** Remove a user ID from the allowFrom filter. */
  removeAllowedUser(userId: string): void {
    this.allowFrom.delete(userId);
  }

  /** Set the bot's own ID to filter out self-messages. */
  setBotId(botId: string): void {
    this.botId = botId;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      this.abortController.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
