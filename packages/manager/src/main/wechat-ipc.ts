/**
 * wechat-ipc — 微信相关 IPC 通信处理器（Electron main process 侧）
 *
 * IPC channels:
 *   wechat:login          — 获取二维码，启动扫码登录流程（通过 SDK ILinkAuth）
 *   wechat:status         — 查询当前连接状态（含心跳/统计/活动日志）
 *   wechat:logout         — 断开连接并清除 token
 *   wechat:cancel         — 取消正在进行的扫码（不清 token）
 *   wechat:status-update  — main→renderer 实时状态推送
 *
 * 认证流程使用 SDK 的 ILinkAuth 类（而非直接 fetch），确保：
 *   - 长轮询超时正确处理（35s）
 *   - iLink-App-ClientVersion header 携带
 *   - 响应字段校验（bot_token、ilink_bot_id 必须存在）
 *
 * Integration layer:
 *   连接成功后创建 WechatChannel 实例并启动消息监控。
 *   WechatChannel.onStateChange → pushStatus() 同步状态到 GUI
 *   WechatChannel.onMessage → recordActivity('inbound') + WechatGateway.handleMessage
 *   WechatGateway outbound reply → recordActivity('outbound')
 *   Monitor heartbeat → touchHeartbeat() 更新心跳时间
 *
 * 使用方式：
 *   import { registerWeChatIPC } from './wechat-ipc.js';
 *   registerWeChatIPC(() => mainWindow);
 */

import { ipcMain, app, type BrowserWindow } from 'electron';
import { ILinkAuth } from '@mlb/wechat-sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ConnectionStatus,
  BotInfo,
  StatusPayload,
  ActivityEntry,
} from '../shared/wechat-types.js';

// ---------------------------------------------------------------------------
// Bridge integration types (minimal interfaces to avoid cross-package deps)
// ---------------------------------------------------------------------------

/** Minimal interface for WechatChannel from @mlb/bridge */
interface IWechatChannel {
  stop(): Promise<void>;
}

/** Minimal interface for WechatGateway from @mlb/bridge */
interface IWechatGateway {
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Persisted token file
// ---------------------------------------------------------------------------

interface PersistedToken {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  userId?: string;
  savedAt: string;
}

function getTokenPath(): string {
  return path.join(app.getPath('userData'), 'wechat-bot-token.json');
}

function saveToken(data: {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  userId?: string;
}): void {
  const payload: PersistedToken = { ...data, savedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(getTokenPath(), JSON.stringify(payload, null, 2), 'utf-8');
    log('Token saved to disk');
  } catch (err) {
    log(`Failed to save token: ${(err as Error).message}`);
  }
}

function loadToken(): PersistedToken | null {
  try {
    const raw = fs.readFileSync(getTokenPath(), 'utf-8');
    return JSON.parse(raw) as PersistedToken;
  } catch {
    return null;
  }
}

function clearToken(): void {
  try {
    fs.unlinkSync(getTokenPath());
    log('Token cleared from disk');
  } catch {
    // file may not exist
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentStatus: ConnectionStatus = 'disconnected';
let currentBot: BotInfo | null = null;
let botToken: string | null = null;
let loginAbort: AbortController | null = null;

/** Epoch ms when current connection was established. */
let connectedSince: number | null = null;
/** Epoch ms of most recent successful heartbeat/poll response. */
let lastHeartbeat: number | null = null;
/** Today's date key (YYYY-MM-DD) for resetting daily stats. */
let statsDateKey = '';
let statsReceived = 0;
let statsSent = 0;
/** Ring buffer of recent activity entries (max 50, renderer shows 20). */
const activityLog: ActivityEntry[] = [];
let activitySeq = 0;

/** Lazily-created SDK auth instance. */
let authInstance: ILinkAuth | null = null;

function getAuth(): ILinkAuth {
  if (!authInstance) {
    authInstance = new ILinkAuth();
  }
  return authInstance;
}

// ---------------------------------------------------------------------------
// Bridge integration — WechatChannel + WechatGateway references
// ---------------------------------------------------------------------------

/** Active WechatChannel instance (created after successful login). */
let wechatChannel: IWechatChannel | null = null;

/** Active WechatGateway instance (handles message routing to Claude). */
let wechatGateway: IWechatGateway | null = null;

/** Callback to obtain BrowserWindow for pushStatus. Set by registerWeChatIPC. */
let getMainWindowFn: (() => BrowserWindow | null) | null = null;

/**
 * Callback invoked when login succeeds.
 * The bootstrap layer registers this to create WechatChannel + WechatGateway
 * so that messages actually flow after GUI-driven login.
 */
let onLoginSuccessFn: ((info: {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  userId?: string;
}) => Promise<void>) | null = null;

/**
 * Register a callback that will be invoked after successful QR login.
 * The callback should create the WechatChannel and WechatGateway instances,
 * then call setBridgeInstances() to wire them into the IPC layer.
 */
export function setOnLoginSuccess(
  fn: (info: {
    botToken: string;
    ilinkBotId: string;
    baseUrl?: string;
    userId?: string;
  }) => Promise<void>,
): void {
  onLoginSuccessFn = fn;
}

/**
 * Set bridge instances for integration.
 * Called by the application bootstrap after creating WechatChannel and WechatGateway.
 *
 * Once set, the IPC layer will:
 *   - Forward WechatChannel.onStateChange to pushStatus()
 *   - Call recordActivity() on inbound/outbound messages
 *   - Call touchHeartbeat() on monitor polls
 */
export function setBridgeInstances(
  channel: IWechatChannel | null,
  gateway: IWechatGateway | null,
): void {
  wechatChannel = channel;
  wechatGateway = gateway;
}

/**
 * Notify GUI of a state change from the bridge layer.
 * Called by WechatChannel.onStateChange callback.
 */
export function notifyStateChange(state: ConnectionStatus): void {
  currentStatus = state;
  if (state === 'connected' && !connectedSince) {
    connectedSince = Date.now();
    lastHeartbeat = Date.now();
  } else if (state === 'disconnected' || state === 'expired') {
    connectedSince = null;
  }

  const win = getMainWindowFn?.();
  if (win) pushStatus(win, buildStatusPayload());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pushStatus(win: BrowserWindow, payload: StatusPayload) {
  if (!win.isDestroyed()) {
    win.webContents.send('wechat:status-update', payload);
  }
}

function log(msg: string) {
  console.log(`[wechat-ipc] ${msg}`);
}

/** Ensure daily stats reset when the date rolls over. */
function ensureStatsDate() {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== statsDateKey) {
    statsDateKey = key;
    statsReceived = 0;
    statsSent = 0;
  }
}

/**
 * Push current status to the renderer window.
 * Called internally and by external modules after state changes.
 */
export function pushStatusToRenderer(): void {
  const win = getMainWindowFn?.();
  if (win && !win.isDestroyed()) {
    pushStatus(win, buildStatusPayload());
  }
}

/**
 * Record a message activity entry and push updated status to GUI.
 * Call on every inbound/outbound message to keep GUI stats and
 * activity log in sync with actual message traffic.
 */
export function recordActivity(
  direction: 'inbound' | 'outbound',
  senderName: string,
  msgType: number,
  preview: string,
  isError = false,
) {
  ensureStatsDate();
  if (direction === 'inbound') statsReceived++;
  else statsSent++;

  activitySeq++;
  const entry: ActivityEntry = {
    id: `act-${activitySeq}`,
    time: Date.now(),
    direction,
    senderName,
    msgType,
    preview: preview.length > 50 ? preview.slice(0, 50) + '\u2026' : preview,
    error: isError || undefined,
  };
  activityLog.push(entry);
  if (activityLog.length > 50) activityLog.splice(0, activityLog.length - 50);

  // Push updated stats/activity to renderer in real-time
  pushStatusToRenderer();
}

/**
 * Update heartbeat timestamp and push to GUI.
 * Call after each successful getupdates poll.
 */
export function touchHeartbeat() {
  lastHeartbeat = Date.now();
  pushStatusToRenderer();
}

/** Build the full status payload. */
function buildStatusPayload(extra?: Partial<StatusPayload>): StatusPayload {
  ensureStatsDate();
  return {
    status: currentStatus,
    bot: currentBot ?? undefined,
    lastHeartbeat: lastHeartbeat ?? undefined,
    connectedSince: connectedSince ?? undefined,
    stats: { received: statsReceived, sent: statsSent },
    activity: activityLog.slice(-20),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Login flow — uses SDK ILinkAuth for API calls
// ---------------------------------------------------------------------------

const QR_MAX_REFRESH = 3;
const POLL_RETRY_DELAY = 2000;

async function startLoginFlow(
  win: BrowserWindow,
): Promise<{ qrcodeUrl: string }> {
  // Abort any previous login
  loginAbort?.abort();
  loginAbort = new AbortController();
  const signal = loginAbort.signal;

  const auth = getAuth();

  // Fetch initial QR code via SDK
  log('Fetching QR code from iLink...');
  const initial = await auth.getQrCode();
  log(`QR response: url_length=${initial.qrcodeUrl?.length}, prefix=${initial.qrcodeUrl?.slice(0, 50)}`);
  currentStatus = 'scanning';
  pushStatus(win, buildStatusPayload({ qrcodeUrl: initial.qrcodeUrl }));
  log('QR code pushed to renderer, waiting for scan');

  // Background polling using SDK's pollQrStatus
  (async () => {
    let refreshCount = 0;
    let currentQrcode = initial.qrcode;

    while (!signal.aborted) {
      try {
        const resp = await auth.pollQrStatus(currentQrcode);

        if (signal.aborted) return;

        switch (resp.status) {
          case 'wait':
            // Normal long-poll timeout, continue
            break;

          case 'scaned':
            if (currentStatus !== 'scanned') {
              currentStatus = 'scanned';
              pushStatus(win, buildStatusPayload());
              log('QR scanned, awaiting confirmation');
            }
            break;

          case 'expired':
            refreshCount++;
            log(`QR expired (${refreshCount}/${QR_MAX_REFRESH})`);
            if (refreshCount >= QR_MAX_REFRESH) {
              currentStatus = 'disconnected';
              pushStatus(win, buildStatusPayload({
                error: '二维码多次过期，请重新扫码',
              }));
              return;
            }
            // Auto-refresh QR via SDK
            try {
              const fresh = await auth.getQrCode();
              currentQrcode = fresh.qrcode;
              currentStatus = 'scanning';
              pushStatus(win, buildStatusPayload({
                qrcodeUrl: fresh.qrcodeUrl,
                refreshCount,
              }));
              log(`QR refreshed (${refreshCount}/${QR_MAX_REFRESH})`);
            } catch (refreshErr) {
              currentStatus = 'disconnected';
              pushStatus(win, buildStatusPayload({
                error: `刷新二维码失败: ${(refreshErr as Error).message}`,
              }));
              return;
            }
            break;

          case 'confirmed':
            // SDK's pollQrStatus returns the raw StatusResponse
            if (!resp.ilink_bot_id) {
              currentStatus = 'disconnected';
              pushStatus(win, buildStatusPayload({
                error: '登录失败：服务器未返回 ilink_bot_id',
              }));
              return;
            }
            if (!resp.bot_token) {
              currentStatus = 'disconnected';
              pushStatus(win, buildStatusPayload({
                error: '登录失败：服务器未返回 bot_token',
              }));
              return;
            }

            currentStatus = 'connected';
            connectedSince = Date.now();
            lastHeartbeat = Date.now();
            botToken = resp.bot_token;
            currentBot = {
              ilinkBotId: resp.ilink_bot_id,
              userId: resp.ilink_user_id,
              wxid: resp.ilink_user_id,
            };
            pushStatus(win, buildStatusPayload());
            log(`Connected via SDK: bot_id=${currentBot.ilinkBotId}`);

            // Persist token for reconnection
            saveToken({
              botToken: resp.bot_token,
              ilinkBotId: resp.ilink_bot_id,
              baseUrl: resp.baseurl,
              userId: resp.ilink_user_id,
            });

            // W1 fix: create bridge channel/gateway so messages actually flow
            if (onLoginSuccessFn) {
              try {
                await onLoginSuccessFn({
                  botToken: resp.bot_token,
                  ilinkBotId: resp.ilink_bot_id,
                  baseUrl: resp.baseurl,
                  userId: resp.ilink_user_id,
                });
                log('Bridge channel/gateway created after login');
              } catch (err) {
                log(`Failed to create bridge after login: ${(err as Error).message}`);
              }
            }
            return;
        }
      } catch (err) {
        if (signal.aborted) return;
        log(`Poll error: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, POLL_RETRY_DELAY));
      }
    }
  })();

  return { qrcodeUrl: initial.qrcodeUrl };
}

// ---------------------------------------------------------------------------
// Public: register IPC handlers
// ---------------------------------------------------------------------------

export function registerWeChatIPC(
  getMainWindow: () => BrowserWindow | null,
) {
  getMainWindowFn = getMainWindow;

  // Attempt to restore from saved token on startup
  const saved = loadToken();
  if (saved) {
    botToken = saved.botToken;
    currentBot = {
      ilinkBotId: saved.ilinkBotId,
      userId: saved.userId,
      wxid: saved.userId,
    };
    currentStatus = 'disconnected';
    connectedSince = null;
    log(`Restored saved token (not connected yet): bot_id=${saved.ilinkBotId}`);
  }

  // wechat:login — 获取二维码，启动扫码流程
  ipcMain.handle('wechat:login', async () => {
    const win = getMainWindow();
    if (!win) throw new Error('No main window');
    return startLoginFlow(win);
  });

  // wechat:status — 查询连接状态（含心跳、统计、活动日志）
  ipcMain.handle('wechat:status', async (): Promise<StatusPayload> => {
    return buildStatusPayload();
  });

  // wechat:logout — 断开连接并清除 token（同时停止 bridge channel/gateway）
  ipcMain.handle('wechat:logout', async () => {
    loginAbort?.abort();
    loginAbort = null;

    // Stop bridge instances
    if (wechatGateway) {
      await wechatGateway.stop().catch((err: Error) => log(`Gateway stop error: ${err.message}`));
    }
    if (wechatChannel) {
      await wechatChannel.stop().catch((err: Error) => log(`Channel stop error: ${err.message}`));
    }

    currentStatus = 'disconnected';
    currentBot = null;
    botToken = null;
    connectedSince = null;
    lastHeartbeat = null;
    clearToken();
    log('Disconnected by user');

    const win = getMainWindow();
    if (win) pushStatus(win, buildStatusPayload());
  });

  // wechat:getToken — 返回已保存的 token 信息（供 bridge 绑定用）
  ipcMain.handle('wechat:getToken', async () => {
    const saved = loadToken();
    if (!saved) return null;
    return {
      botToken: saved.botToken,
      ilinkBotId: saved.ilinkBotId,
      baseUrl: saved.baseUrl,
      userId: saved.userId,
    };
  });

  // wechat:cancel — 取消正在进行的扫码（不清 token/bot info）
  ipcMain.handle('wechat:cancel', async () => {
    loginAbort?.abort();
    loginAbort = null;

    // Stop channel if it was mid-login
    if (wechatChannel && (currentStatus === 'scanning' || currentStatus === 'scanned')) {
      await wechatChannel.stop().catch((err: Error) => log(`Channel stop error: ${err.message}`));
    }

    if (currentStatus === 'scanning' || currentStatus === 'scanned') {
      currentStatus = 'disconnected';
      log('Scan cancelled by user');

      const win = getMainWindow();
      if (win) pushStatus(win, buildStatusPayload());
    }
  });
}

/**
 * Get current bot token (for bridge integration).
 * Returns null if not connected.
 */
export function getWeChatBotToken(): string | null {
  return botToken;
}

/**
 * Get current connection status (for other modules).
 */
export function getWeChatStatus(): ConnectionStatus {
  return currentStatus;
}

/**
 * Get current bot info (for bridge integration).
 */
export function getWeChatBotInfo(): BotInfo | null {
  return currentBot;
}
