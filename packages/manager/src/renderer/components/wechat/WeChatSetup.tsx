/**
 * WeChatSetup — 微信 iLink Bot 配置页面
 *
 * Electron + React + Tailwind CSS
 * 与飞书配置页面风格一致，支持深色/浅色主题。
 *
 * IPC channels (via window.mlb.wechat.*):
 *   wechat.login()        → 获取二维码 URL，启动扫码流程（SDK ILinkAuth）
 *   wechat.status()       → 查询连接状态（含心跳/统计/活动日志）
 *   wechat.logout()       → 断开连接并清除 token
 *   wechat.cancel()       → 取消正在进行的扫码
 *   wechat.onStatusUpdate → main→renderer 实时状态推送
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type {
  ConnectionStatus,
  BotInfo,
  StatusPayload,
  LogEntry,
  ActivityEntry,
  MessageStats,
} from '../../../shared/wechat-types';
import { MSG_TYPE_LABELS } from '../../../shared/wechat-types';

// ---------------------------------------------------------------------------
// Timestamp & formatting helpers
// ---------------------------------------------------------------------------

function now(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  const h = Math.floor(m / 60);
  return `${h}时${m % 60}分`;
}

function formatTime(epoch: number): string {
  const d = new Date(epoch);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_META: Record<
  ConnectionStatus,
  { label: string; color: string; dotColor: string; bg: string }
> = {
  disconnected: {
    label: '未连接',
    color: 'text-gray-500 dark:text-gray-400',
    dotColor: 'bg-gray-400',
    bg: 'bg-gray-100 dark:bg-gray-700/50',
  },
  scanning: {
    label: '等待扫码',
    color: 'text-yellow-600 dark:text-yellow-400',
    dotColor: 'bg-yellow-400 animate-pulse',
    bg: 'bg-yellow-50 dark:bg-yellow-900/20',
  },
  scanned: {
    label: '已扫码待确认',
    color: 'text-blue-600 dark:text-blue-400',
    dotColor: 'bg-blue-400 animate-pulse',
    bg: 'bg-blue-50 dark:bg-blue-900/20',
  },
  connected: {
    label: '已连接',
    color: 'text-green-600 dark:text-green-400',
    dotColor: 'bg-green-500',
    bg: 'bg-green-50 dark:bg-green-900/20',
  },
  reconnecting: {
    label: '重连中',
    color: 'text-orange-600 dark:text-orange-400',
    dotColor: 'bg-orange-400 animate-pulse',
    bg: 'bg-orange-50 dark:bg-orange-900/20',
  },
  expired: {
    label: '会话过期',
    color: 'text-red-600 dark:text-red-400',
    dotColor: 'bg-red-400',
    bg: 'bg-red-50 dark:bg-red-900/20',
  },
};

function WeChatStatusBadge({ status }: { status: ConnectionStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${meta.color} ${meta.bg}`}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${meta.dotColor}`} />
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// WeChat icon SVG (official shape)
// ---------------------------------------------------------------------------

function WeChatLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05a6.127 6.127 0 0 1-.253-1.738c0-3.578 3.381-6.479 7.554-6.479.258 0 .507.026.758.043C16.803 4.56 13.087 2.188 8.691 2.188zm-2.87 4.4a1.035 1.035 0 1 1 0-2.07 1.035 1.035 0 0 1 0 2.07zm5.743 0a1.035 1.035 0 1 1 0-2.07 1.035 1.035 0 0 1 0 2.07z" />
      <path d="M23.503 14.666c0-3.309-3.139-5.992-7.009-5.992-3.87 0-7.009 2.683-7.009 5.992 0 3.309 3.14 5.993 7.01 5.993a8.87 8.87 0 0 0 2.365-.32.72.72 0 0 1 .598.082l1.585.926a.27.27 0 0 0 .14.046c.133 0 .241-.11.241-.245 0-.06-.024-.119-.04-.177l-.325-1.233a.493.493 0 0 1 .178-.556c1.526-1.124 2.266-2.835 2.266-4.516zm-9.592-.818a.863.863 0 1 1 0-1.726.863.863 0 0 1 0 1.726zm5.167 0a.863.863 0 1 1 0-1.726.863.863 0 0 1 0 1.726z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// WeChatSetup component
// ---------------------------------------------------------------------------

export default function WeChatSetup() {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [lastHeartbeat, setLastHeartbeat] = useState<number | null>(null);
  const [connectedSince, setConnectedSince] = useState<number | null>(null);
  const [msgStats, setMsgStats] = useState<MessageStats>({ received: 0, sent: 0 });
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [refreshCount, setRefreshCount] = useState(0);
  const [, setTick] = useState(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((text: string, level: LogEntry['level'] = 'info') => {
    setLogs((prev) => [...prev.slice(-49), { time: now(), text, level }]);
  }, []);

  // ── Apply a status payload from IPC ──
  const applyPayload = useCallback(
    (p: StatusPayload) => {
      setStatus(p.status);
      if (p.bot) setBotInfo(p.bot);
      if (p.lastHeartbeat) setLastHeartbeat(p.lastHeartbeat);
      if (p.connectedSince) setConnectedSince(p.connectedSince);
      if (p.stats) setMsgStats(p.stats);
      if (p.activity) setActivity(p.activity);
      if (p.refreshCount !== undefined) setRefreshCount(p.refreshCount);
    },
    [],
  );

  // ── Fetch current status on mount ──
  useEffect(() => {
    window.mlb.wechat
      .status()
      .then((payload) => {
        const p = payload as StatusPayload;
        applyPayload(p);
        addLog(`初始状态: ${STATUS_META[p.status].label}`);
      })
      .catch(() => {
        addLog('获取初始状态失败', 'warn');
      });

    // Listen for real-time status updates pushed from main process
    const unsub = window.mlb.wechat.onStatusUpdate((p: StatusPayload) => {
      applyPayload(p);

      if (p.error) {
        setError(p.error);
        addLog(p.error, 'error');
      }
      if (p.qrcodeUrl) {
        setQrCodeUrl(p.qrcodeUrl);
        if (p.refreshCount && p.refreshCount > 0) {
          addLog(`二维码已刷新 (${p.refreshCount}/3)`);
        } else {
          addLog('二维码已刷新');
        }
      }
      if (p.status === 'connected') {
        setQrCodeUrl(null);
        setRefreshCount(0);
        addLog(
          `连接成功${p.bot?.ilinkBotId ? ` (Bot: ${p.bot.ilinkBotId})` : ''}`,
        );
      } else if (p.status === 'scanned') {
        addLog('已扫码，请在微信上确认');
      } else if (p.status === 'expired') {
        addLog('会话已过期（errcode -14），请重新扫码', 'warn');
        setQrCodeUrl(null);
        setConnectedSince(null);
        setLastHeartbeat(null);
      } else if (p.status === 'disconnected' && !p.error) {
        addLog('已断开连接');
        setConnectedSince(null);
        setLastHeartbeat(null);
      }
    });

    return () => {
      unsub?.();
    };
  }, [addLog, applyPayload]);

  // Tick uptime display every second while connected
  useEffect(() => {
    if (status !== 'connected' || !connectedSince) return;
    const id = setInterval(() => setTick((k) => k + 1), 1000);
    return () => clearInterval(id);
  }, [status, connectedSince]);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // ── Login: request QR code via SDK-backed IPC ──
  const handleLogin = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRefreshCount(0);
    addLog('正在获取二维码…');
    try {
      const result = (await window.mlb.wechat.login()) as {
        qrcodeUrl: string;
      };
      setQrCodeUrl(result.qrcodeUrl);
      setStatus('scanning');
      addLog('二维码已生成，请用微信扫码');
    } catch (err) {
      const msg = (err as Error).message || '获取二维码失败';
      setError(msg);
      addLog(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [addLog]);

  // ── Cancel: stop scanning without clearing token ──
  const handleCancel = useCallback(async () => {
    addLog('取消扫码');
    try {
      await window.mlb.wechat.cancel();
      setStatus('disconnected');
      setQrCodeUrl(null);
      setRefreshCount(0);
    } catch (err) {
      addLog((err as Error).message || '取消失败', 'warn');
    }
  }, [addLog]);

  // ── Logout: disconnect and clear token ──
  const handleLogout = useCallback(async () => {
    setLoading(true);
    setError(null);
    addLog('正在断开连接…');
    try {
      await window.mlb.wechat.logout();
      setStatus('disconnected');
      setBotInfo(null);
      setQrCodeUrl(null);
      setConnectedSince(null);
      setLastHeartbeat(null);
      addLog('连接已断开');
    } catch (err) {
      const msg = (err as Error).message || '断开失败';
      setError(msg);
      addLog(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [addLog]);

  // ── Reconnect ──
  const handleReconnect = useCallback(async () => {
    setStatus('reconnecting');
    setError(null);
    addLog('正在重新连接…');
    await handleLogin();
  }, [handleLogin, addLog]);

  const isConnected = status === 'connected';
  const isScanning = status === 'scanning' || status === 'scanned';

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-8 flex items-center gap-3">
        <WeChatLogo className="h-8 w-8 text-green-500" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            微信配置
          </h1>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            通过 iLink Bot 连接微信，接收和回复微信消息
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Left column ── */}
        <div className="space-y-6">
          {/* Connection status card */}
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-medium text-gray-900 dark:text-gray-100">
                  连接状态
                </h2>
                <div className="mt-2">
                  <WeChatStatusBadge status={status} />
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                {isConnected ? (
                  <>
                    <button
                      onClick={handleReconnect}
                      disabled={loading}
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      重新连接
                    </button>
                    <button
                      onClick={handleLogout}
                      disabled={loading}
                      className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      断开连接
                    </button>
                  </>
                ) : isScanning ? (
                  <button
                    onClick={handleCancel}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    取消扫码
                  </button>
                ) : (
                  <button
                    onClick={handleLogin}
                    disabled={loading}
                    className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loading ? '获取中…' : '扫码连接'}
                  </button>
                )}
              </div>
            </div>

            {/* Connection stats — shown when connected */}
            {isConnected && connectedSince && (
              <div className="mt-4 grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-700/50">
                  <p className="text-xs text-gray-500 dark:text-gray-400">在线时长</p>
                  <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                    {formatDuration(Date.now() - connectedSince)}
                  </p>
                </div>
                <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-700/50">
                  <p className="text-xs text-gray-500 dark:text-gray-400">收/发消息</p>
                  <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                    {msgStats.received} / {msgStats.sent}
                  </p>
                </div>
                <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-700/50">
                  <p className="text-xs text-gray-500 dark:text-gray-400">最近心跳</p>
                  <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                    {lastHeartbeat ? formatTime(lastHeartbeat) : '-'}
                  </p>
                </div>
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
                <span className="mr-1 font-medium">错误:</span>
                {error}
              </div>
            )}
          </div>

          {/* Bot info section */}
          {isConnected && botInfo && (
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <h2 className="mb-4 text-base font-medium text-gray-900 dark:text-gray-100">
                Bot 信息
              </h2>
              <dl className="space-y-3">
                <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3 dark:bg-gray-700/50">
                  <dt className="text-sm text-gray-500 dark:text-gray-400">
                    iLink Bot ID
                  </dt>
                  <dd className="min-w-0 break-all text-right font-mono text-sm text-gray-900 dark:text-gray-100">
                    {botInfo.ilinkBotId}
                  </dd>
                </div>
                {botInfo.wxid && (
                  <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3 dark:bg-gray-700/50">
                    <dt className="text-sm text-gray-500 dark:text-gray-400">
                      微信号
                    </dt>
                    <dd className="min-w-0 break-all text-right font-mono text-sm text-gray-900 dark:text-gray-100">
                      {botInfo.wxid}
                    </dd>
                  </div>
                )}
                {botInfo.userId && (
                  <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3 dark:bg-gray-700/50">
                    <dt className="text-sm text-gray-500 dark:text-gray-400">
                      iLink 用户 ID
                    </dt>
                    <dd className="min-w-0 break-all text-right font-mono text-sm text-gray-900 dark:text-gray-100">
                      {botInfo.userId}
                    </dd>
                  </div>
                )}
                {botInfo.nickname && (
                  <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3 dark:bg-gray-700/50">
                    <dt className="text-sm text-gray-500 dark:text-gray-400">
                      昵称
                    </dt>
                    <dd className="min-w-0 break-all text-right text-sm text-gray-900 dark:text-gray-100">
                      {botInfo.nickname}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {/* Instructions when disconnected */}
          {status === 'disconnected' && !qrCodeUrl && (
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <h2 className="mb-3 text-base font-medium text-gray-900 dark:text-gray-100">
                使用说明
              </h2>
              <ol className="list-inside list-decimal space-y-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                <li>点击「扫码连接」获取二维码</li>
                <li>使用微信扫描二维码</li>
                <li>在微信上确认登录</li>
              </ol>
            </div>
          )}
        </div>

        {/* ── Right column ── */}
        <div className="space-y-6">
          {/* QR Code section — large for easy scanning */}
          {qrCodeUrl && isScanning && (
            <div
              className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800"
              style={{ animation: 'qr-appear 0.3s ease-out' }}
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-medium text-gray-900 dark:text-gray-100">
                  扫码登录
                </h2>
                {refreshCount > 0 && (
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    已刷新 {refreshCount}/3
                  </span>
                )}
              </div>
              <div className="flex flex-col items-center">
                <div
                  className={`rounded-2xl border-2 p-5 transition-all duration-300 ${
                    status === 'scanned'
                      ? 'border-blue-400 bg-blue-50 shadow-lg shadow-blue-100 dark:border-blue-500 dark:bg-blue-900/20 dark:shadow-blue-900/20'
                      : 'border-dashed border-green-300 bg-white dark:border-green-600 dark:bg-gray-900'
                  }`}
                >
                  <QRCodeSVG
                    value={qrCodeUrl}
                    size={288}
                    level="M"
                    className="transition-opacity duration-200"
                  />
                </div>

                {/* Status-specific prompts */}
                <div className="mt-4 text-center transition-all duration-200">
                  {status === 'scanned' ? (
                    <>
                      <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
                        已扫码，请在微信上点击确认
                      </p>
                      <p className="mt-1 text-xs text-blue-500/70 dark:text-blue-400/60">
                        等待手机端确认授权…
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        请使用微信扫描上方二维码
                      </p>
                      <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                        二维码过期后将自动刷新（最多 3 次）
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Message activity — shown when connected and has entries */}
          {isConnected && activity.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="border-b border-gray-200 px-5 py-3 dark:border-gray-700">
                <h2 className="text-base font-medium text-gray-900 dark:text-gray-100">
                  消息动态
                </h2>
              </div>
              <div className="max-h-48 overflow-y-auto px-5 py-3">
                <ul className="space-y-2">
                  {activity.slice().reverse().map((entry) => (
                    <li
                      key={entry.id}
                      className={`flex items-start gap-2 text-xs ${
                        entry.error
                          ? 'text-red-500 dark:text-red-400'
                          : 'text-gray-600 dark:text-gray-300'
                      }`}
                    >
                      <span className="mt-0.5 shrink-0">
                        {entry.direction === 'inbound' ? (
                          <span className="inline-block h-4 w-4 rounded bg-blue-100 text-center text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                            &darr;
                          </span>
                        ) : (
                          <span className="inline-block h-4 w-4 rounded bg-green-100 text-center text-green-600 dark:bg-green-900/30 dark:text-green-400">
                            &uarr;
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-gray-400 dark:text-gray-500">
                        {formatTime(entry.time)}
                      </span>
                      <span className="shrink-0 font-medium">
                        {entry.senderName}
                      </span>
                      <span className="shrink-0 rounded bg-gray-100 px-1 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                        {MSG_TYPE_LABELS[entry.msgType] || '未知'}
                      </span>
                      <span className="truncate">{entry.preview}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* System log */}
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="border-b border-gray-200 px-5 py-3 dark:border-gray-700">
              <h2 className="text-base font-medium text-gray-900 dark:text-gray-100">
                系统日志
              </h2>
            </div>
            <div className="h-48 overflow-y-auto px-5 py-3">
              {logs.length === 0 ? (
                <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">
                  暂无活动
                </p>
              ) : (
                <ul className="space-y-1">
                  {logs.map((entry, i) => (
                    <li
                      key={i}
                      className={`flex gap-2 font-mono text-xs leading-5 ${
                        entry.level === 'error'
                          ? 'text-red-600 dark:text-red-400'
                          : entry.level === 'warn'
                            ? 'text-yellow-600 dark:text-yellow-400'
                            : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      <span className="shrink-0 text-gray-400 dark:text-gray-500">
                        {entry.time}
                      </span>
                      <span>{entry.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
