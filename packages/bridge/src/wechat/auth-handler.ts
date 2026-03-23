/**
 * WeChat /auth command handler — bridges WeChat users to Feishu OAuth.
 *
 * Flow:
 *   1. WeChat user sends `/auth` to the bot
 *   2. Bot generates a Feishu OAuth Device Authorization request
 *   3. Bot replies with verification URL (user opens in browser to authorize)
 *   4. Bot polls for token in background
 *   5. On success, saves binding (wechatUserId ↔ feishu token) and notifies user
 *
 * Uses the same Device Authorization Grant (RFC 8628) flow as the Feishu channel
 * (see bridge-source/auth/oauth.ts), but initiated from WeChat instead of Feishu.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ILinkClient } from '@mlb/wechat-sdk';
import { sendTextMessage } from '@mlb/wechat-sdk';
import type { WechatFeishuBinding } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_COMMAND = '/auth';
const BINDINGS_FILE = 'wechat-feishu-bindings.json';

/**
 * Feishu OAuth scopes — same set as bridge-source/auth/oauth.ts USER_SCOPES.
 * Kept in sync so WeChat-authed users get identical Feishu capabilities.
 */
const FEISHU_USER_SCOPES = [
  'offline_access',
  // Calendar
  'calendar:calendar.event:create', 'calendar:calendar.event:delete',
  'calendar:calendar.event:read', 'calendar:calendar.event:reply',
  'calendar:calendar.event:update', 'calendar:calendar.free_busy:read',
  'calendar:calendar:read',
  // Contact
  'contact:contact.base:readonly', 'contact:user.base:readonly',
  'contact:user.employee_id:readonly', 'contact:user:search',
  // Docs
  'docs:document.comment:create', 'docs:document.comment:read',
  'docs:document.comment:update', 'docs:document.media:download',
  'docs:document.media:upload', 'docs:document:copy', 'docs:document:export',
  // Docx
  'docx:document:create', 'docx:document:readonly', 'docx:document:write_only',
  // Drive
  'drive:drive.metadata:readonly', 'drive:file:download', 'drive:file:upload',
  // IM
  'im:chat.members:read', 'im:chat:read', 'im:message',
  'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user',
  'im:message:readonly',
  // Search
  'search:docs:read', 'search:message',
  // Sheets
  'sheets:spreadsheet.meta:read', 'sheets:spreadsheet:create',
  'sheets:spreadsheet:read', 'sheets:spreadsheet:write_only',
  // Task
  'task:comment:read', 'task:comment:write', 'task:task:read',
  'task:task:write', 'task:task:writeonly', 'task:tasklist:read', 'task:tasklist:write',
  // Bitable
  'base:app:copy', 'base:app:create', 'base:app:read', 'base:app:update',
  'base:field:create', 'base:field:delete', 'base:field:read', 'base:field:update',
  'base:record:create', 'base:record:delete', 'base:record:retrieve', 'base:record:update',
  'base:table:create', 'base:table:delete', 'base:table:read', 'base:table:update',
  'base:view:read', 'base:view:write_only',
  // Wiki
  'wiki:node:copy', 'wiki:node:create', 'wiki:node:move',
  'wiki:node:read', 'wiki:node:retrieve', 'wiki:space:read',
  'wiki:space:retrieve', 'wiki:space:write_only',
  // Space
  'space:document:delete', 'space:document:move', 'space:document:retrieve',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration required for the auth handler. */
export interface AuthHandlerConfig {
  /** Feishu app ID (same as bridge config). */
  feishuAppId: string;
  /** Feishu app secret (same as bridge config). */
  feishuAppSecret: string;
  /** Feishu API base URL (e.g., https://open.feishu.cn). */
  feishuApiBaseUrl: string;
  /** Directory for persisting bindings. */
  dataDir: string;
}

/** Result of device authorization request. */
interface DeviceAuthResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/** Token data from Feishu OAuth. */
interface FeishuTokenData {
  user_access_token: string;
  refresh_token: string;
  token_expiry: string;
  scope?: string;
  /** Feishu open_id extracted from token introspection or userinfo. */
  open_id?: string;
}

// ---------------------------------------------------------------------------
// Command detection
// ---------------------------------------------------------------------------

/**
 * Check if a message is the /auth command.
 * Matches `/auth` with optional trailing whitespace or arguments.
 */
export function isAuthCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed === AUTH_COMMAND || trimmed.startsWith(AUTH_COMMAND + ' ');
}

// ---------------------------------------------------------------------------
// Feishu Device Authorization (mirrors bridge-source/auth/oauth.ts)
// ---------------------------------------------------------------------------

/**
 * Step 1: Request device authorization from Feishu.
 * Returns device_code and verification URL for the user to open.
 */
async function requestDeviceAuthorization(
  appId: string,
  appSecret: string,
  apiBaseUrl: string,
): Promise<DeviceAuthResult> {
  const scope = FEISHU_USER_SCOPES.join(' ');
  const accountsBase = apiBaseUrl.replace(/^(https?:\/\/)open\./, '$1accounts.');
  const endpoint = `${accountsBase}/oauth/v1/device_authorization`;

  const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString('base64');
  const body = new URLSearchParams({
    client_id: appId,
    scope,
  });

  console.log(`[wechat-auth] device flow: requesting authorization (${FEISHU_USER_SCOPES.length} scopes)`);
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });

  const data = await resp.json() as Record<string, unknown>;
  if (!resp.ok || data.error) {
    throw new Error(
      `Device authorization failed: ${(data.error_description ?? data.error ?? resp.statusText) as string}`,
    );
  }

  console.log(`[wechat-auth] device flow: got device_code, expires_in=${data.expires_in}s`);
  return {
    deviceCode: data.device_code as string,
    userCode: data.user_code as string,
    verificationUri: data.verification_uri as string,
    verificationUriComplete: `${(data.verification_uri_complete ?? data.verification_uri) as string}&from=wechat-bridge`,
    expiresIn: (data.expires_in as number) ?? 240,
    interval: (data.interval as number) ?? 5,
  };
}

/**
 * Step 2: Poll for token after user authorizes.
 * Returns token data on success, null on denial/expiry/abort.
 */
async function pollDeviceToken(
  appId: string,
  appSecret: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  apiBaseUrl: string,
  signal?: AbortSignal,
): Promise<FeishuTokenData | null> {
  const tokenEndpoint = `${apiBaseUrl}/open-apis/authen/v2/oauth/token`;
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval;

  while (Date.now() < deadline) {
    if (signal?.aborted) return null;

    await new Promise((r) => setTimeout(r, pollInterval * 1000));

    try {
      const resp = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: appId,
          client_secret: appSecret,
        }).toString(),
      });

      const data = await resp.json() as Record<string, unknown>;

      if (!data.error && data.access_token) {
        console.log('[wechat-auth] device flow: token obtained');
        return {
          user_access_token: data.access_token as string,
          refresh_token: (data.refresh_token ?? '') as string,
          token_expiry: new Date(Date.now() + ((data.expires_in as number) ?? 7200) * 1000).toISOString(),
          scope: (data.scope ?? '') as string,
          open_id: data.open_id as string | undefined,
        };
      }

      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') { pollInterval += 5; continue; }
      if (data.error === 'access_denied') {
        console.log('[wechat-auth] device flow: user denied');
        return null;
      }
      if (data.error === 'expired_token' || data.error === 'invalid_grant') {
        console.log('[wechat-auth] device flow: expired');
        return null;
      }

      console.warn(`[wechat-auth] device flow: unexpected error: ${data.error}`);
      return null;
    } catch (err) {
      console.warn(`[wechat-auth] device flow: poll error: ${err}`);
      continue;
    }
  }

  console.log('[wechat-auth] device flow: timeout');
  return null;
}

// ---------------------------------------------------------------------------
// Binding persistence
// ---------------------------------------------------------------------------

/** Load all WeChat↔Feishu bindings from disk. */
function loadBindings(dataDir: string): Map<string, WechatFeishuBinding> {
  const path = join(dataDir, BINDINGS_FILE);
  if (!existsSync(path)) return new Map();
  try {
    const arr = JSON.parse(readFileSync(path, 'utf-8')) as WechatFeishuBinding[];
    const map = new Map<string, WechatFeishuBinding>();
    for (const b of arr) {
      map.set(b.wechatUserId, b);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Save all bindings to disk atomically (write tmp → rename). */
function saveBindings(dataDir: string, bindings: Map<string, WechatFeishuBinding>): void {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  const arr = Array.from(bindings.values());
  const target = join(dataDir, BINDINGS_FILE);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(arr, null, 2) + '\n');
  renameSync(tmp, target);
  console.log(`[wechat-auth] bindings saved (${arr.length} entries)`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** In-memory map of pending auth flows: wechatUserId → AbortController. */
const pendingAuths = new Map<string, AbortController>();

/**
 * Handle the /auth command from a WeChat user.
 *
 * 1. Initiates Feishu Device Authorization flow
 * 2. Sends verification URL back to the WeChat user
 * 3. Polls for token in background
 * 4. On success, creates/updates WeChat↔Feishu binding
 *
 * @param userId - WeChat iLink user ID of the sender
 * @param contextToken - iLink context_token for replies
 * @param client - iLink SDK client instance for sending messages
 * @param config - Auth handler configuration (Feishu app credentials, data dir)
 */
export async function handleAuthCommand(
  userId: string,
  contextToken: string,
  client: ILinkClient,
  config: AuthHandlerConfig,
  options?: { force?: boolean; onBindingCreated?: (binding: WechatFeishuBinding) => void },
): Promise<void> {
  // Cancel any existing pending auth for this user
  const existing = pendingAuths.get(userId);
  if (existing) {
    existing.abort();
    pendingAuths.delete(userId);
  }

  // Check if user already has a valid binding (skip when force=true)
  if (!options?.force) {
    const bindings = loadBindings(config.dataDir);
    const currentBinding = bindings.get(userId);
    if (currentBinding?.feishuUserToken && currentBinding.tokenExpiry) {
      const expiryMs = new Date(currentBinding.tokenExpiry).getTime() - 5 * 60 * 1000;
      if (expiryMs > Date.now()) {
        await sendTextMessage(client, {
          to: userId,
          contextToken,
          text: '你已完成飞书授权，无需重复操作。如需重新授权，请发送 /auth force',
        });
        return;
      }
    }
  }

  // Step 1: Request device authorization
  let authResult: DeviceAuthResult;
  try {
    authResult = await requestDeviceAuthorization(
      config.feishuAppId,
      config.feishuAppSecret,
      config.feishuApiBaseUrl,
    );
  } catch (err) {
    console.error(`[wechat-auth] device auth request failed: ${err}`);
    await sendTextMessage(client, {
      to: userId,
      contextToken,
      text: `飞书授权请求失败: ${String(err).slice(0, 200)}`,
    });
    return;
  }

  // Step 2: Send verification URL to user
  const authMessage = [
    '请在浏览器中打开以下链接完成飞书授权：',
    '',
    authResult.verificationUriComplete,
    '',
    `授权码: ${authResult.userCode}`,
    `有效期: ${Math.floor(authResult.expiresIn / 60)} 分钟`,
    '',
    '授权后你就可以通过微信使用飞书日历、文档、多维表格等能力。',
  ].join('\n');

  await sendTextMessage(client, {
    to: userId,
    contextToken,
    text: authMessage,
  });

  // Step 3: Poll for token in background
  const abortController = new AbortController();
  pendingAuths.set(userId, abortController);

  // Fire-and-forget background polling
  pollDeviceToken(
    config.feishuAppId,
    config.feishuAppSecret,
    authResult.deviceCode,
    authResult.interval,
    authResult.expiresIn,
    config.feishuApiBaseUrl,
    abortController.signal,
  )
    .then(async (tokenData) => {
      pendingAuths.delete(userId);

      if (!tokenData) {
        console.log(`[wechat-auth] auth flow ended without token for user ${userId}`);
        // Don't send failure message — could be abort from a new /auth attempt
        return;
      }

      // Step 4: Save binding
      const binding: WechatFeishuBinding = {
        wechatUserId: userId,
        feishuOpenId: tokenData.open_id ?? '',
        feishuUserToken: tokenData.user_access_token,
        refreshToken: tokenData.refresh_token || undefined,
        tokenExpiry: tokenData.token_expiry,
        createdAt: new Date().toISOString(),
      };

      const updatedBindings = loadBindings(config.dataDir);
      updatedBindings.set(userId, binding);
      saveBindings(config.dataDir, updatedBindings);

      // Notify gateway to sync in-memory binding
      options?.onBindingCreated?.(binding);

      // Notify user
      try {
        await sendTextMessage(client, {
          to: userId,
          contextToken,
          text: '飞书授权成功！你现在可以通过微信使用飞书能力（日历、文档、多维表格等）。',
        });
      } catch (err) {
        console.warn(`[wechat-auth] failed to send success notification: ${err}`);
      }
    })
    .catch((err) => {
      pendingAuths.delete(userId);
      console.error(`[wechat-auth] polling error for user ${userId}: ${err}`);
    });
}

/**
 * Handle OAuth callback (for future HTTP redirect-based flow if needed).
 * Currently the device flow handles everything via polling, but this function
 * is provided for forward compatibility if the bridge later adds an HTTP
 * callback endpoint.
 *
 * @param state - OAuth state parameter containing encoded wechatUserId
 * @param code - Authorization code from Feishu
 * @param config - Auth handler configuration
 */
export async function handleOAuthCallback(
  state: string,
  code: string,
  config: AuthHandlerConfig,
): Promise<void> {
  // Parse wechatUserId from state (format: "wx:<userId>")
  if (!state.startsWith('wx:')) {
    throw new Error(`Invalid OAuth state format: ${state}`);
  }
  const wechatUserId = state.slice(3);

  // Exchange code for token
  const resp = await fetch(`${config.feishuApiBaseUrl}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.feishuAppId,
      client_secret: config.feishuAppSecret,
    }).toString(),
  });

  const data = await resp.json() as Record<string, unknown>;
  if (data.error || !data.access_token) {
    throw new Error(`OAuth token exchange failed: ${(data.error_description ?? data.error) as string}`);
  }

  // Save binding
  const binding: WechatFeishuBinding = {
    wechatUserId,
    feishuOpenId: (data.open_id ?? '') as string,
    feishuUserToken: data.access_token as string,
    refreshToken: (data.refresh_token as string) || undefined,
    tokenExpiry: new Date(Date.now() + ((data.expires_in as number) ?? 7200) * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };

  const bindings = loadBindings(config.dataDir);
  bindings.set(wechatUserId, binding);
  saveBindings(config.dataDir, bindings);

  console.log(`[wechat-auth] OAuth callback: binding saved for ${wechatUserId}`);
}

/**
 * Refresh a Feishu access token using the refresh_token grant.
 * Returns updated binding on success, null on failure.
 */
export async function refreshFeishuToken(
  binding: WechatFeishuBinding,
  config: AuthHandlerConfig,
): Promise<WechatFeishuBinding | null> {
  if (!binding.refreshToken) {
    console.log(`[wechat-auth] no refresh_token for user ${binding.wechatUserId}, cannot renew`);
    return null;
  }

  console.log(`[wechat-auth] refreshing token for user ${binding.wechatUserId}`);
  try {
    const resp = await fetch(`${config.feishuApiBaseUrl}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: binding.refreshToken,
        client_id: config.feishuAppId,
        client_secret: config.feishuAppSecret,
      }).toString(),
    });

    const data = await resp.json() as Record<string, unknown>;
    if (data.error || !data.access_token) {
      console.warn(`[wechat-auth] refresh failed: ${(data.error_description ?? data.error) as string}`);
      return null;
    }

    const updated: WechatFeishuBinding = {
      ...binding,
      feishuUserToken: data.access_token as string,
      refreshToken: (data.refresh_token as string) || binding.refreshToken,
      tokenExpiry: new Date(Date.now() + ((data.expires_in as number) ?? 7200) * 1000).toISOString(),
    };

    // Persist updated binding
    const bindings = loadBindings(config.dataDir);
    bindings.set(updated.wechatUserId, updated);
    saveBindings(config.dataDir, bindings);

    console.log(`[wechat-auth] token refreshed for user ${binding.wechatUserId}`);
    return updated;
  } catch (err) {
    console.warn(`[wechat-auth] refresh error: ${err}`);
    return null;
  }
}

/**
 * Get the Feishu binding for a WeChat user (if exists and token is valid).
 * If the token is expired but a refresh_token is available, attempts auto-renewal.
 * Returns null only if no binding, no token, or renewal fails.
 */
export async function getFeishuBinding(
  wechatUserId: string,
  dataDir: string,
  config?: AuthHandlerConfig,
): Promise<WechatFeishuBinding | null> {
  const bindings = loadBindings(dataDir);
  const binding = bindings.get(wechatUserId);
  if (!binding?.feishuUserToken || !binding.tokenExpiry) return null;

  // Check expiry (5 min buffer)
  const expiryMs = new Date(binding.tokenExpiry).getTime() - 5 * 60 * 1000;
  if (expiryMs > Date.now()) return binding;

  // Token expired or about to expire — try refresh
  if (config && binding.refreshToken) {
    const refreshed = await refreshFeishuToken(binding, config);
    if (refreshed) return refreshed;
  }

  return null;
}

/**
 * Get the Feishu binding synchronously (no auto-renewal).
 * Use when async is not possible.
 */
export function getFeishuBindingSync(
  wechatUserId: string,
  dataDir: string,
): WechatFeishuBinding | null {
  const bindings = loadBindings(dataDir);
  const binding = bindings.get(wechatUserId);
  if (!binding?.feishuUserToken || !binding.tokenExpiry) return null;

  const expiryMs = new Date(binding.tokenExpiry).getTime() - 5 * 60 * 1000;
  if (expiryMs <= Date.now()) return null;

  return binding;
}

/**
 * Check if a WeChat user has a valid Feishu binding.
 */
export function hasFeishuBinding(wechatUserId: string, dataDir: string): boolean {
  return getFeishuBindingSync(wechatUserId, dataDir) !== null;
}

/**
 * Load all bindings from disk. Exported for gateway startup sync.
 */
export function loadBindingsFromDisk(dataDir: string): Map<string, WechatFeishuBinding> {
  return loadBindings(dataDir);
}
