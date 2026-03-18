import React from 'react';
import { useI18n } from '../i18n';

interface StatusBadgeProps {
  state: 'running' | 'stopped' | 'error';
  compact?: boolean;
}

const STATUS_KEY: Record<string, string> = {
  running: 'bridge.status.running',
  stopped: 'bridge.status.stopped',
  error: 'bridge.status.error',
};

export default function StatusBadge({ state, compact = false }: StatusBadgeProps) {
  const { t } = useI18n();

  const config = {
    running: {
      bg: 'bg-emerald-100 dark:bg-emerald-900/30',
      text: 'text-emerald-700 dark:text-emerald-400',
      dot: 'bg-emerald-500',
      pulse: true,
    },
    stopped: {
      bg: 'bg-slate-100 dark:bg-slate-700/50',
      text: 'text-slate-600 dark:text-slate-400',
      dot: 'bg-slate-400 dark:bg-slate-500',
      pulse: false,
    },
    error: {
      bg: 'bg-red-100 dark:bg-red-900/30',
      text: 'text-red-700 dark:text-red-400',
      dot: 'bg-red-500',
      pulse: false,
    },
  }[state];

  if (compact) {
    return (
      <span className={`w-2 h-2 rounded-full shrink-0 ${config.dot} ${config.pulse ? 'animate-pulse-dot' : ''}`} />
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot} ${config.pulse ? 'animate-pulse-dot' : ''}`} />
      {t(STATUS_KEY[state])}
    </span>
  );
}
