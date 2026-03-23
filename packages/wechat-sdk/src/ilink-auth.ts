/**
 * iLink Bot SDK — QR code authentication module.
 *
 * Implements the full scan-to-login flow:
 *   1. GET get_bot_qrcode → QR code URL
 *   2. Long-poll GET get_qrcode_status → wait/scaned/confirmed/expired
 *   3. On confirmed → extract bot_token + ilink_bot_id
 */

import type { QRCodeResponse, StatusResponse } from "./ilink-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_QR_REFRESH_COUNT = 3;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface QrLoginResult {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  userId?: string;
}

export type QrStatusCallback = (status: StatusResponse["status"], message: string) => void;

// ---------------------------------------------------------------------------
// ILinkAuth
// ---------------------------------------------------------------------------

export class ILinkAuth {
  private baseUrl: string;
  private botType: string;

  constructor(opts: { baseUrl?: string; botType?: string } = {}) {
    this.baseUrl = ensureTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.botType = opts.botType ?? DEFAULT_BOT_TYPE;
  }

  /**
   * Fetch a new QR code for scanning.
   * Returns the qrcode token and the image URL for display.
   */
  async getQrCode(): Promise<{ qrcode: string; qrcodeUrl: string }> {
    const url = new URL(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(this.botType)}`,
      this.baseUrl,
    );
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`Failed to fetch QR code: ${res.status} ${res.statusText} body=${body}`);
    }
    const data = (await res.json()) as QRCodeResponse;
    console.log(`[ilink-auth] getQrCode response: qrcode=${data.qrcode?.slice(0, 20)}..., img_content type=${typeof data.qrcode_img_content}, length=${data.qrcode_img_content?.length}, prefix=${data.qrcode_img_content?.slice(0, 30)}`);
    let qrcodeUrl = data.qrcode_img_content;
    // If the server returns raw base64 (no data: prefix), add it
    if (qrcodeUrl && !qrcodeUrl.startsWith('data:') && !qrcodeUrl.startsWith('http')) {
      qrcodeUrl = `data:image/png;base64,${qrcodeUrl}`;
    }
    return {
      qrcode: data.qrcode,
      qrcodeUrl,
    };
  }

  /**
   * Single long-poll for QR status (~35s).
   * Returns "wait" on timeout (normal behavior).
   */
  async pollQrStatus(qrcode: string): Promise<StatusResponse> {
    const url = new URL(
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      this.baseUrl,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);

    try {
      const res = await fetch(url.toString(), {
        headers: { "iLink-App-ClientVersion": "1" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => "(unreadable)");
        throw new Error(`QR status poll failed: ${res.status} ${res.statusText} body=${body}`);
      }
      return (await res.json()) as StatusResponse;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return { status: "wait" };
      }
      throw err;
    }
  }

  /**
   * Complete login flow: get QR → poll until confirmed/timeout.
   *
   * @param opts.timeoutMs  Overall timeout (default 5 min)
   * @param opts.onStatus   Status callback for UI updates
   * @param opts.onQrCode   Called with qrcodeUrl each time a new QR is generated
   */
  async login(opts?: {
    timeoutMs?: number;
    onStatus?: QrStatusCallback;
    onQrCode?: (qrcodeUrl: string) => void;
  }): Promise<QrLoginResult> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let refreshCount = 0;

    let { qrcode, qrcodeUrl } = await this.getQrCode();
    opts?.onQrCode?.(qrcodeUrl);
    opts?.onStatus?.("wait", "请使用微信扫描二维码");

    while (Date.now() < deadline) {
      const resp = await this.pollQrStatus(qrcode);

      switch (resp.status) {
        case "wait":
          // Normal long-poll timeout, continue
          break;

        case "scaned":
          opts?.onStatus?.("scaned", "已扫码，请在微信上确认");
          break;

        case "expired":
          refreshCount++;
          if (refreshCount >= MAX_QR_REFRESH_COUNT) {
            throw new Error("二维码多次过期，请重新开始登录流程");
          }
          opts?.onStatus?.("expired", `二维码已过期，正在刷新 (${refreshCount}/${MAX_QR_REFRESH_COUNT})`);
          const refreshed = await this.getQrCode();
          qrcode = refreshed.qrcode;
          qrcodeUrl = refreshed.qrcodeUrl;
          opts?.onQrCode?.(qrcodeUrl);
          break;

        case "confirmed":
          if (!resp.ilink_bot_id) {
            throw new Error("登录失败：服务器未返回 ilink_bot_id");
          }
          if (!resp.bot_token) {
            throw new Error("登录失败：服务器未返回 bot_token");
          }
          opts?.onStatus?.("confirmed", "登录成功");
          return {
            botToken: resp.bot_token,
            ilinkBotId: resp.ilink_bot_id,
            baseUrl: resp.baseurl,
            userId: resp.ilink_user_id,
          };
      }
    }

    throw new Error("登录超时，请重试");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
