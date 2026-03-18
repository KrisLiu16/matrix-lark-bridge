import https from 'node:https';
import QRCode from 'qrcode';
import type { FeishuQRInit, FeishuCredentials, FeishuValidation } from '@mlb/shared';
import { FEISHU_REGISTRATION_URL, DEFAULT_API_BASE_URL } from '@mlb/shared';

/**
 * Handles Feishu app registration and credential validation.
 * Supports QR code scanning and manual credential input.
 */
export class FeishuSetup {
  /**
   * Initialize the QR code registration flow.
   * Returns the verification URL and device code for polling.
   */
  async initQR(): Promise<FeishuQRInit & { qrDataUrl: string }> {
    // Step 1: Initialize
    await this.postForm(FEISHU_REGISTRATION_URL, {
      action: 'init',
    });

    // Step 2: Begin registration
    const beginData = await this.postForm(FEISHU_REGISTRATION_URL, {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    });

    const deviceCode = beginData.device_code;
    const verificationUrl = beginData.verification_uri_complete;
    const expiresIn = beginData.expires_in || 300;

    if (!deviceCode || !verificationUrl) {
      throw new Error('Registration failed: missing device code or verification URL');
    }

    // Generate QR code as data URL for rendering in the UI
    const qrDataUrl = await QRCode.toDataURL(verificationUrl, {
      width: 280,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });

    console.log(`[feishu-setup] QR init: url=${verificationUrl}, expiresIn=${expiresIn}s`);

    return {
      verificationUrl,
      deviceCode,
      expiresIn,
      qrDataUrl,
    };
  }

  /**
   * Poll for QR code registration completion.
   * Returns credentials if authorized, null if still pending.
   * Throws on errors other than "authorization_pending".
   */
  async pollQR(deviceCode: string): Promise<FeishuCredentials | null> {
    try {
      const pollData = await this.postForm(FEISHU_REGISTRATION_URL, {
        action: 'poll',
        device_code: deviceCode,
      });

      if (pollData.client_id && pollData.client_secret) {
        console.log('[feishu-setup] QR authorization successful');
        return {
          appId: pollData.client_id,
          appSecret: pollData.client_secret,
        };
      }

      if (pollData.error && pollData.error !== 'authorization_pending') {
        throw new Error(`Authorization failed: ${pollData.error}`);
      }

      // Still pending
      return null;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('authorization_pending')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Validate Feishu app credentials by fetching bot info.
   * Returns the bot name if valid, or an error message if invalid.
   */
  async validate(appId: string, appSecret: string, apiBaseUrl?: string): Promise<FeishuValidation> {
    const baseUrl = (apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '');

    try {
      // Step 1: Get tenant access token
      const tokenResp = await fetch(
        `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
          signal: AbortSignal.timeout(5000),
        },
      );
      const tokenData = (await tokenResp.json()) as {
        tenant_access_token?: string;
        code?: number;
        msg?: string;
      };

      if (!tokenData.tenant_access_token) {
        return {
          valid: false,
          error: tokenData.msg || 'Failed to get access token',
        };
      }

      // Step 2: Get bot info
      const botResp = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(5000),
      });
      const botData = (await botResp.json()) as {
        bot?: { app_name?: string };
        code?: number;
        msg?: string;
      };

      if (botData.bot?.app_name) {
        return {
          valid: true,
          botName: botData.bot.app_name,
        };
      }

      return {
        valid: true,
        botName: undefined,
      };
    } catch (err) {
      return {
        valid: false,
        error: (err as Error).message,
      };
    }
  }

  // --- Internal ---

  /**
   * POST form data (application/x-www-form-urlencoded) to a URL.
   * Ported from mini-captain init.ts.
   */
  private postForm(url: string, data: Record<string, string>): Promise<any> {
    const body = new URLSearchParams(data).toString();
    const urlObj = new URL(url);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: urlObj.hostname,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let result = '';
          res.on('data', (chunk) => {
            result += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(result));
            } catch {
              resolve({ raw: result });
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.write(body);
      req.end();
    });
  }
}
