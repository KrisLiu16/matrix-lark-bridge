/**
 * iLink Bot SDK — Core HTTP API client.
 *
 * Wraps all iLink Bot CGI endpoints with proper auth headers, timeouts,
 * and abort handling. No external dependencies — uses Node.js built-in fetch.
 */
import crypto from "node:crypto";

import type {
  BaseInfo,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  GetUploadUrlReq,
  GetUploadUrlResp,
  SendTypingReq,
  SendTypingResp,
  GetConfigResp,
} from "./ilink-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
const SDK_VERSION = "0.9.0";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ILinkClientOptions {
  baseUrl?: string;
  token?: string;
  /** Default timeout for regular API calls (ms). */
  timeoutMs?: number;
  /** Timeout for long-poll getUpdates (ms). */
  longPollTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// ILinkClient
// ---------------------------------------------------------------------------

export class ILinkClient {
  private baseUrl: string;
  private token: string | undefined;
  private timeoutMs: number;
  private longPollTimeoutMs: number;

  constructor(opts: ILinkClientOptions = {}) {
    this.baseUrl = ensureTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    this.longPollTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  }

  /** Update the bearer token (e.g. after QR login). */
  setToken(token: string): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // -------------------------------------------------------------------------
  // getUpdates — long-poll for inbound messages
  // -------------------------------------------------------------------------

  /**
   * Long-poll for new messages. Server holds the connection up to `longPollTimeoutMs`.
   * On client-side timeout (AbortError) returns an empty response with ret=0.
   */
  async getUpdates(getUpdatesBuf?: string, timeoutMs?: number): Promise<GetUpdatesResp> {
    try {
      const text = await this.apiFetch({
        endpoint: "ilink/bot/getupdates",
        body: {
          get_updates_buf: getUpdatesBuf ?? "",
          base_info: buildBaseInfo(),
        },
        timeoutMs: timeoutMs ?? this.longPollTimeoutMs,
        label: "getUpdates",
      });
      return JSON.parse(text) as GetUpdatesResp;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // sendMessage
  // -------------------------------------------------------------------------

  /** Send a message (text, image, video, file). */
  async sendMessage(req: SendMessageReq): Promise<void> {
    await this.apiFetch({
      endpoint: "ilink/bot/sendmessage",
      body: { ...req, base_info: buildBaseInfo() },
      timeoutMs: this.timeoutMs,
      label: "sendMessage",
    });
  }

  // -------------------------------------------------------------------------
  // getUploadUrl — pre-signed CDN upload URL
  // -------------------------------------------------------------------------

  /** Get a pre-signed CDN upload URL for media. */
  async getUploadUrl(req: GetUploadUrlReq): Promise<GetUploadUrlResp> {
    const text = await this.apiFetch({
      endpoint: "ilink/bot/getuploadurl",
      body: { ...req, base_info: buildBaseInfo() },
      timeoutMs: this.timeoutMs,
      label: "getUploadUrl",
    });
    return JSON.parse(text) as GetUploadUrlResp;
  }

  // -------------------------------------------------------------------------
  // sendTyping
  // -------------------------------------------------------------------------

  /** Send a typing indicator to a user. */
  async sendTyping(req: SendTypingReq): Promise<void> {
    await this.apiFetch({
      endpoint: "ilink/bot/sendtyping",
      body: { ...req, base_info: buildBaseInfo() },
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: "sendTyping",
    });
  }

  // -------------------------------------------------------------------------
  // getConfig
  // -------------------------------------------------------------------------

  /** Fetch bot config (typing_ticket) for a given user. */
  async getConfig(ilinkUserId: string, contextToken?: string): Promise<GetConfigResp> {
    const text = await this.apiFetch({
      endpoint: "ilink/bot/getconfig",
      body: {
        ilink_user_id: ilinkUserId,
        context_token: contextToken,
        base_info: buildBaseInfo(),
      },
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: "getConfig",
    });
    return JSON.parse(text) as GetConfigResp;
  }

  // -------------------------------------------------------------------------
  // Internal fetch wrapper
  // -------------------------------------------------------------------------

  private async apiFetch(params: {
    endpoint: string;
    body: Record<string, unknown>;
    timeoutMs: number;
    label: string;
  }): Promise<string> {
    const url = new URL(params.endpoint, this.baseUrl);
    const bodyStr = JSON.stringify(params.body);
    const headers = buildHeaders({ token: this.token, body: bodyStr });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);

    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(`${params.label} ${res.status}: ${rawText}`);
      }
      return rawText;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildBaseInfo(): BaseInfo {
  return { channel_version: SDK_VERSION };
}

/** X-WECHAT-UIN header: random uint32 → decimal string → base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}
