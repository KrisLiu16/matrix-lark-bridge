/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for Feishu/Lark.
 *
 * Flow:
 *   1. requestDeviceAuthorization() → device_code + verification_uri_complete
 *   2. Send auth card with verification_uri_complete link to user
 *   3. pollDeviceToken() → polls until user authorizes or code expires
 *
 * No redirect_uri, no localhost server, works on desktop and mobile.
 */

const USER_SCOPES = [
  'offline_access',
  // Bitable
  'base:app:copy', 'base:app:create', 'base:app:read', 'base:app:update',
  'base:field:create', 'base:field:delete', 'base:field:read', 'base:field:update',
  'base:record:create', 'base:record:delete', 'base:record:retrieve', 'base:record:update',
  'base:table:create', 'base:table:delete', 'base:table:read', 'base:table:update',
  'base:view:read', 'base:view:write_only',
  // Whiteboard
  'board:whiteboard:node:create', 'board:whiteboard:node:read',
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
  // Mail & Approval — not included in default OAuth scopes.
  // Users must enable these scopes manually on open.feishu.cn before using mail/approval tools.
  // IM
  'im:chat.members:read', 'im:chat:read', 'im:message',
  'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user',
  'im:message:readonly',
  // Search
  'search:docs:read', 'search:message',
  // Sheets
  'sheets:spreadsheet.meta:read', 'sheets:spreadsheet:create',
  'sheets:spreadsheet:read', 'sheets:spreadsheet:write_only',
  // Space
  'space:document:delete', 'space:document:move', 'space:document:retrieve',
  // Task
  'task:comment:read', 'task:comment:write', 'task:task:read',
  'task:task:write', 'task:task:writeonly', 'task:tasklist:read', 'task:tasklist:write',
  // Wiki
  'wiki:node:copy', 'wiki:node:create', 'wiki:node:move',
  'wiki:node:read', 'wiki:node:retrieve', 'wiki:space:read',
  'wiki:space:retrieve', 'wiki:space:write_only',
];

export interface TokenData {
  user_access_token: string;
  refresh_token: string;
  token_expiry: string; // ISO string
  scope?: string;
}

export interface DeviceAuthResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

// ---------------------------------------------------------------------------
// Step 1: Request Device Authorization
// ---------------------------------------------------------------------------

export async function requestDeviceAuthorization(
  appId: string,
  appSecret: string,
  apiBaseUrl: string,
): Promise<DeviceAuthResult> {
  const scope = USER_SCOPES.join(' ');
  // Derive accounts domain from API base URL
  const accountsBase = apiBaseUrl.replace(/^(https?:\/\/)open\./, '$1accounts.');
  const endpoint = `${accountsBase}/oauth/v1/device_authorization`;

  const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString('base64');
  const body = new URLSearchParams({
    client_id: appId,
    scope,
  });

  console.log(`[auth] device flow: requesting authorization (${USER_SCOPES.length} scopes)`);
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });

  const data = await resp.json() as any;
  if (!resp.ok || data.error) {
    throw new Error(`Device authorization failed: ${data.error_description ?? data.error ?? resp.statusText}`);
  }

  console.log(`[auth] device flow: got device_code, expires_in=${data.expires_in}s`);
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: `${data.verification_uri_complete ?? data.verification_uri}&from=maxclaw`,
    expiresIn: data.expires_in ?? 240,
    interval: data.interval ?? 5,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Poll Token Endpoint
// ---------------------------------------------------------------------------

export async function pollDeviceToken(
  appId: string,
  appSecret: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  apiBaseUrl: string,
  signal?: AbortSignal,
): Promise<TokenData | null> {
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

      const data = await resp.json() as any;

      if (!data.error && data.access_token) {
        console.log('[auth] device flow: token obtained');
        return {
          user_access_token: data.access_token,
          refresh_token: data.refresh_token ?? '',
          token_expiry: new Date(Date.now() + (data.expires_in ?? 7200) * 1000).toISOString(),
          scope: data.scope ?? '',
        };
      }

      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') { pollInterval += 5; continue; }
      if (data.error === 'access_denied') {
        console.log('[auth] device flow: user denied');
        return null;
      }
      if (data.error === 'expired_token' || data.error === 'invalid_grant') {
        console.log('[auth] device flow: expired');
        return null;
      }

      // Unknown error
      console.warn(`[auth] device flow: unexpected error: ${data.error}`);
      return null;
    } catch (err) {
      console.warn(`[auth] device flow: poll error: ${err}`);
      continue;
    }
  }

  console.log('[auth] device flow: timeout');
  return null;
}

// ---------------------------------------------------------------------------
// Token refresh (still uses v1 OIDC endpoint)
// ---------------------------------------------------------------------------

async function getAppAccessToken(appId: string, appSecret: string, apiBaseUrl: string): Promise<string> {
  const resp = await fetch(`${apiBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await resp.json() as any;
  if (data.code !== 0) {
    throw new Error(`app_access_token failed: code=${data.code} msg=${data.msg}`);
  }
  return data.app_access_token;
}

export async function getTenantAccessToken(appId: string, appSecret: string, apiBaseUrl: string): Promise<string> {
  const resp = await fetch(`${apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await resp.json() as any;
  if (data.code !== 0) {
    throw new Error(`tenant_access_token failed: code=${data.code} msg=${data.msg}`);
  }
  return data.tenant_access_token;
}

export async function refreshUserToken(appId: string, appSecret: string, refreshToken: string, apiBaseUrl: string): Promise<TokenData> {
  // Use v2 OAuth endpoint (matches v2 Device Flow used for authorization)
  const resp = await fetch(`${apiBaseUrl}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appId,
      client_secret: appSecret,
    }).toString(),
  });
  const data = await resp.json() as any;
  if (data.code !== 0) {
    throw new Error(`token refresh failed: code=${data.code} msg=${data.message ?? data.msg}`);
  }

  return {
    user_access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expiry: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    scope: data.scope ?? '',
  };
}
