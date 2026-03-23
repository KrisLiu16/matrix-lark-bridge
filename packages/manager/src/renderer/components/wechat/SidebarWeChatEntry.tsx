/**
 * SidebarWeChatEntry — Sidebar 中的微信导航入口
 *
 * 添加到现有 Sidebar 组件中，与飞书入口风格一致。
 * 使用方式：在 Sidebar 的导航列表中插入 <SidebarWeChatEntry />
 */

import React, { useEffect, useRef, useState } from 'react';
import type { ConnectionStatus, StatusPayload } from '../../../shared/wechat-types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SidebarWeChatEntryProps {
  active: boolean;
  onClick: () => void;
}

// ---------------------------------------------------------------------------
// WeChat icon SVG (official shape, 24x24 viewBox)
// ---------------------------------------------------------------------------

function WeChatIcon({ className }: { className?: string }) {
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
// Component
// ---------------------------------------------------------------------------

const DOT_COLORS: Record<ConnectionStatus, string> = {
  connected: 'bg-green-500',
  scanning: 'bg-yellow-400 animate-pulse',
  scanned: 'bg-blue-400 animate-pulse',
  reconnecting: 'bg-orange-400 animate-pulse',
  expired: 'bg-red-400',
  disconnected: 'bg-gray-400',
};

const ICON_COLORS: Record<ConnectionStatus, string> = {
  connected: 'text-green-600 dark:text-green-400',
  scanning: 'text-yellow-600 dark:text-yellow-400',
  scanned: 'text-blue-600 dark:text-blue-400',
  reconnecting: 'text-orange-600 dark:text-orange-400',
  expired: 'text-red-600 dark:text-red-400',
  disconnected: '',
};

export default function SidebarWeChatEntry({
  active,
  onClick,
}: SidebarWeChatEntryProps) {
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('disconnected');
  const [unreadCount, setUnreadCount] = useState(0);
  const lastSeenRef = useRef(0);

  useEffect(() => {
    // Fetch initial status
    window.mlb.wechat
      .status()
      .then((p: unknown) => {
        const payload = p as StatusPayload;
        setConnStatus(payload.status);
      })
      .catch(() => {});

    // Subscribe to live updates
    const unsub = window.mlb.wechat.onStatusUpdate((payload: StatusPayload) => {
      setConnStatus(payload.status);

      // Count new inbound messages since last seen
      if (payload.activity) {
        const inbound = payload.activity.filter(
          (a) => a.direction === 'inbound' && a.time > lastSeenRef.current,
        );
        if (inbound.length > 0) {
          setUnreadCount((prev) => prev + inbound.length);
          lastSeenRef.current = Math.max(...inbound.map((a) => a.time));
        }
      }
    });

    return () => {
      unsub?.();
    };
  }, []);

  // Clear unread when user clicks into the WeChat page
  const handleClick = () => {
    setUnreadCount(0);
    lastSeenRef.current = Date.now();
    onClick();
  };

  const iconColor = active ? '' : ICON_COLORS[connStatus];

  return (
    <button
      onClick={handleClick}
      className={`
        group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors
        ${
          active
            ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
        }
      `}
    >
      <div className="relative">
        <WeChatIcon className={`h-5 w-5 ${iconColor}`} />
        {/* Connection indicator dot */}
        <span
          className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-white dark:border-gray-900 ${
            DOT_COLORS[connStatus]
          }`}
        />
      </div>
      <span className="flex-1 text-left">微信</span>
      {/* Unread badge */}
      {unreadCount > 0 && (
        <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold leading-none text-white">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
}
