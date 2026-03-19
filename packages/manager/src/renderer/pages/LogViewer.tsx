import React, { useState, useEffect, useRef } from 'react';
import { useBridgeStore } from '../stores/bridge-store';
import { useI18n } from '../i18n';

interface LogViewerProps {
  name: string;
}

type LogLevel = 'ALL' | 'ERROR' | 'WARN' | 'INFO' | 'TOOL';

const LOG_LEVEL_FILTERS: Record<LogLevel, (line: string) => boolean> = {
  ALL: () => true,
  ERROR: (line) => /error|ERR/i.test(line),
  WARN: (line) => /warn|\[warn\]/i.test(line),
  INFO: (line) => /\[info\]|\[gateway\]|\[feishu\]|\[claudecode\]|\[config\]/i.test(line),
  TOOL: (line) => /\[gateway\] tool:/i.test(line),
};

const LOG_LEVEL_STYLES: Record<LogLevel, { active: string; inactive: string }> = {
  ALL: {
    active: 'bg-slate-600 text-white',
    inactive: 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600',
  },
  ERROR: {
    active: 'bg-red-600 text-white',
    inactive: 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50',
  },
  WARN: {
    active: 'bg-amber-500 text-white',
    inactive: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/50',
  },
  INFO: {
    active: 'bg-blue-600 text-white',
    inactive: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50',
  },
  TOOL: {
    active: 'bg-emerald-600 text-white',
    inactive: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50',
  },
};

export default function LogViewer({ name }: LogViewerProps) {
  const { navigate } = useBridgeStore();
  const { t } = useI18n();
  const [lines, setLines] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [filter, setFilter] = useState('');
  const [logLevel, setLogLevel] = useState<LogLevel>('ALL');
  const [autoScroll, setAutoScroll] = useState(true);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Load initial logs
  useEffect(() => {
    loadLogs();
  }, [name]);

  // Auto-scroll when new lines arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streaming) {
        window.mlb.bridge.logsStop(name).catch(() => {});
      }
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, [name]);

  async function loadLogs() {
    try {
      setLoading(true);
      const logLines = await window.mlb.bridge.logs(name, 5000);
      setLines(logLines);
    } catch (err) {
      setLines([`Error loading logs: ${(err as Error).message}`]);
    } finally {
      setLoading(false);
    }
  }

  async function toggleStream() {
    if (streaming) {
      await window.mlb.bridge.logsStop(name);
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      setStreaming(false);
    } else {
      cleanupRef.current = window.mlb.onLogLine((data) => {
        if (data.name === name) {
          setLines((prev) => {
            const updated = [...prev, data.line];
            return updated.length > 2000 ? updated.slice(-2000) : updated;
          });
        }
      });

      await window.mlb.bridge.logsStream(name);
      setStreaming(true);
    }
  }

  const filteredLines = lines.filter((line) => {
    if (!LOG_LEVEL_FILTERS[logLevel](line)) return false;
    if (filter && !line.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 shrink-0
        bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('list', name)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
            {t('logs.back')}
          </button>
          <h1 className="text-sm font-semibold">{t('logs.title', { name })}</h1>
          {streaming && (
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse-dot" />
              {t('logs.live')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Log level filter buttons */}
          <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-slate-700/50 rounded-lg p-0.5">
            {(Object.keys(LOG_LEVEL_STYLES) as LogLevel[]).map((level) => (
              <button
                key={level}
                onClick={() => setLogLevel(level)}
                className={`px-2 py-0.5 text-xs font-medium rounded-md transition-colors ${
                  logLevel === level
                    ? LOG_LEVEL_STYLES[level].active
                    : LOG_LEVEL_STYLES[level].inactive
                }`}
              >
                {level}
              </button>
            ))}
          </div>
          <div className="w-px h-4 bg-slate-300 dark:bg-slate-600" />
          <div className="relative">
            <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('logs.filter.placeholder')}
              className="pl-7 pr-2 py-1 text-xs rounded-lg w-36
                bg-slate-100 dark:bg-slate-700/50
                border border-transparent focus:border-indigo-500/50
                text-slate-700 dark:text-slate-300
                placeholder-slate-400
                outline-none transition-all"
            />
          </div>
          <label className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-600 text-indigo-600 focus:ring-indigo-500"
            />
            {t('logs.autoScroll')}
          </label>
          <button
            onClick={toggleStream}
            className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors
              ${streaming
                ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50'
                : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50'
              }`}
          >
            {streaming ? t('logs.stream.stop') : t('logs.stream.start')}
          </button>
          <button
            onClick={loadLogs}
            className="px-3 py-1 text-xs font-medium rounded-lg transition-colors
              bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300
              hover:bg-slate-200 dark:hover:bg-slate-600"
          >
            {t('logs.refresh')}
          </button>
        </div>
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-slate-950 p-4 font-mono text-xs leading-5"
      >
        {loading ? (
          <div className="space-y-1.5">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="skeleton h-4 rounded" style={{ width: `${40 + Math.random() * 50}%` }} />
            ))}
          </div>
        ) : filteredLines.length === 0 ? (
          <div className="text-slate-600">
            {filter ? t('logs.empty.filtered') : t('logs.empty')}
          </div>
        ) : (
          filteredLines.map((line, i) => (
            <div key={i} className="text-slate-400 whitespace-pre-wrap break-all hover:bg-slate-900/50 px-1 -mx-1 rounded">
              {colorize(line)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Enhanced log line colorization with timestamp + tag + level highlighting.
 */
function colorize(line: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = line;

  // Extract timestamp — ISO format or [DD HH:mm:ss] format
  const tsMatch = remaining.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*/)
    || remaining.match(/^(\[\d{2} \d{2}:\d{2}:\d{2}\])\s*/);
  if (tsMatch) {
    parts.push(<span key="ts" className="text-slate-600">{tsMatch[1]}</span>);
    remaining = remaining.slice(tsMatch[0].length);
    parts.push(' ');
  }

  // Highlight bracket-prefixed tags
  const tagMatch = remaining.match(/^(\[[\w:-]+\])(.*)/);
  if (tagMatch) {
    const tag = tagMatch[1];
    const rest = tagMatch[2];
    parts.push(<span key="tag" className={getTagColor(tag)}>{tag}</span>);
    remaining = rest;
  }

  // Check for log levels in remaining text
  const lowerRemaining = remaining.toLowerCase();
  if (lowerRemaining.includes('error') || lowerRemaining.includes('fatal') || lowerRemaining.includes('panic')) {
    parts.push(<span key="rest" className="text-red-400">{remaining}</span>);
  } else if (lowerRemaining.includes('warn')) {
    parts.push(<span key="rest" className="text-amber-400">{remaining}</span>);
  } else if (lowerRemaining.includes('debug') || lowerRemaining.includes('trace')) {
    parts.push(<span key="rest" className="text-slate-600">{remaining}</span>);
  } else {
    parts.push(remaining);
  }

  return parts.length > 0 ? <>{parts}</> : line;
}

function getTagColor(tag: string): string {
  if (tag.includes('gateway')) return 'text-blue-400';
  if (tag.includes('feishu')) return 'text-violet-400';
  if (tag.includes('claudecode')) return 'text-emerald-400';
  if (tag.includes('config')) return 'text-amber-400';
  if (tag.includes('session')) return 'text-cyan-400';
  if (tag.includes('streaming')) return 'text-pink-400';
  if (tag.includes('lark-mcp')) return 'text-orange-400';
  if (tag.includes('error') || tag.includes('ERROR')) return 'text-red-400';
  return 'text-slate-500';
}
