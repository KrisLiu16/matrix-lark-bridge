import React, { useEffect, useCallback } from 'react';
import { useBridgeStore } from './stores/bridge-store';
import { useClaudeSetupStore } from './stores/claude-setup-store';
import { useI18n } from './i18n';
import Sidebar from './components/Sidebar';
import ToastContainer from './components/Toast';
import ClaudeSetup from './components/ClaudeSetup';
import BridgeConfig from './pages/BridgeConfig';
import NewBridge from './pages/NewBridge';
import LogViewer from './pages/LogViewer';
import SessionViewer from './pages/SessionViewer';

export default function App() {
  const { currentPage, selectedBridge, fetchBridges, navigate, bridges } = useBridgeStore();
  const { installed: claudeInstalled, checking: claudeChecking, checkClaude } = useClaudeSetupStore();
  const { locale, setLocale, t } = useI18n();

  // Check Claude Code on mount
  useEffect(() => { checkClaude(); }, [checkClaude]);

  // Fetch bridges on mount and every 5 seconds
  useEffect(() => {
    fetchBridges();
    const interval = setInterval(fetchBridges, 5000);
    return () => clearInterval(interval);
  }, [fetchBridges]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 'n') {
        e.preventDefault();
        navigate('new');
      } else if (meta && e.key === 'r') {
        e.preventDefault();
        fetchBridges();
      } else if (e.key === 'Escape') {
        if (currentPage !== 'list') {
          navigate('list', selectedBridge ?? undefined);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, selectedBridge, navigate, fetchBridges]);

  const runningCount = bridges.filter((b) => b.state === 'running').length;

  const renderContent = () => {
    switch (currentPage) {
      case 'config':
        return selectedBridge ? <BridgeConfig name={selectedBridge} /> : <EmptyState t={t} />;
      case 'new':
        return <NewBridge />;
      case 'logs':
        return selectedBridge ? <LogViewer name={selectedBridge} /> : <EmptyState t={t} />;
      case 'session':
        return selectedBridge ? <SessionViewer name={selectedBridge} /> : <EmptyState t={t} />;
      default:
        return selectedBridge ? <BridgeDetail name={selectedBridge} /> : <EmptyState t={t} />;
    }
  };


  return (
    <div className="h-screen flex bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 overflow-hidden">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar — drag region + controls */}
        <div className="drag-region h-11 flex items-center justify-end gap-2 px-4 shrink-0
          bg-white/60 dark:bg-slate-800/60 backdrop-blur border-b border-slate-200 dark:border-slate-700/50">
          {/* Spacer — no need for traffic light padding here since sidebar covers them */}
          <div className="flex-1" />

          {/* Language toggle */}
          <button
            onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
            className="no-drag px-2 py-1 text-xs font-medium rounded-lg
              text-slate-500 dark:text-slate-400
              hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors"
            title={locale === 'zh' ? 'Switch to English' : '切换到中文'}
          >
            {locale === 'zh' ? 'EN' : '中文'}
          </button>
        </div>

        {/* Page content */}
        <div className="flex-1 overflow-auto animate-fade-in">
          {claudeInstalled === false ? (
            <ClaudeSetup onComplete={() => checkClaude()} />
          ) : (
            renderContent()
          )}
        </div>

        {/* Status bar */}
        <div className="h-7 flex items-center px-4 text-[11px] shrink-0
          bg-white/60 dark:bg-slate-800/60 backdrop-blur border-t border-slate-200 dark:border-slate-700/50
          text-slate-500 dark:text-slate-500 gap-4">
          <span>{t('statusbar.total', { count: bridges.length })}</span>
          <span className="flex items-center gap-1">
            {runningCount > 0 && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse-dot" />}
            {t('statusbar.running', { count: runningCount })}
          </span>
          <span className="ml-auto flex items-center gap-3">
            <button
              onClick={async () => {
                if (!confirm('卸载内置 Claude Code？\n\n仅删除 ~/.mlb/bin/claude，不影响系统中其他 Claude Code。')) return;
                try {
                  await window.mlb.claude.uninstall();
                  checkClaude(); // re-check → will show setup page for reinstall
                } catch (e) { alert(`操作失败: ${e}`); }
              }}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
              title="卸载内置 Claude Code"
            >
              卸载内置CC
            </button>
            <span>MLB Manager v{__MLB_VERSION__}</span>
          </span>
        </div>
      </main>

      <ToastContainer />
    </div>
  );
}

/** Shown when no bridge is selected in the content area */
function EmptyState({ t }: { t: (key: string) => string }) {
  return (
    <div className="flex-1 flex items-center justify-center h-full">
      <div className="text-center text-slate-400 dark:text-slate-600">
        <svg className="w-16 h-16 mx-auto mb-4 opacity-30" fill="none" viewBox="0 0 24 24" strokeWidth="1" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
        </svg>
        <p className="text-sm">{t('common.noSelection')}</p>
      </div>
    </div>
  );
}

/** Quick detail view when a bridge is selected from the sidebar (list page) */
function BridgeDetail({ name }: { name: string }) {
  const { bridges, navigate, startBridge, stopBridge, restartBridge, loading } = useBridgeStore();
  const { t } = useI18n();
  const bridge = bridges.find((b) => b.name === name);

  if (!bridge) {
    return <EmptyState t={t} />;
  }

  return (
    <div className="max-w-2xl mx-auto p-6 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-semibold">{bridge.name}</h1>
        <StatusDot state={bridge.state} />
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <InfoCard label="Status" value={t(`bridge.status.${bridge.state}`)} />
        {bridge.pid && <InfoCard label="PID" value={String(bridge.pid)} />}
        {bridge.uptime !== undefined && <InfoCard label="Uptime" value={formatUptime(bridge.uptime)} />}
        {bridge.sessionId && <InfoCard label="Session" value={bridge.sessionId.substring(0, 8)} mono />}
        {bridge.lastActivity && <InfoCard label="Last Activity" value={formatLastActivity(bridge.lastActivity)} />}
        {bridge.autoStart && <InfoCard label={t('bridge.autoStart')} value="ON" />}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {bridge.state === 'running' ? (
          <>
            <ActionBtn label={t('bridge.action.stop')} onClick={() => stopBridge(bridge.name)} variant="danger" disabled={loading} />
            <ActionBtn label={t('bridge.action.restart')} onClick={() => restartBridge(bridge.name)} disabled={loading} />
          </>
        ) : (
          <ActionBtn label={t('bridge.action.start')} onClick={() => startBridge(bridge.name)} variant="primary" disabled={loading} />
        )}
        <ActionBtn label={t('bridge.action.logs')} onClick={() => navigate('logs', bridge.name)} />
        <ActionBtn label={t('bridge.action.session')} onClick={() => navigate('session', bridge.name)} />
        <ActionBtn label={t('bridge.action.config')} onClick={() => navigate('config', bridge.name)} />
      </div>
    </div>
  );
}

function InfoCard({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-3">
      <div className="text-[11px] text-slate-500 dark:text-slate-500 mb-1">{label}</div>
      <div className={`text-sm font-medium ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  );
}

function StatusDot({ state }: { state: string }) {
  const color = state === 'running' ? 'bg-emerald-500' : state === 'error' ? 'bg-red-500' : 'bg-slate-400';
  return (
    <span className={`w-2.5 h-2.5 rounded-full ${color} ${state === 'running' ? 'animate-pulse-dot' : ''}`} />
  );
}

function ActionBtn({
  label, onClick, variant = 'default', disabled = false,
}: {
  label: string; onClick: () => void; variant?: 'default' | 'primary' | 'danger'; disabled?: boolean;
}) {
  const styles = {
    default: 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600',
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    danger: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 text-sm font-medium rounded-xl transition-colors disabled:opacity-50 ${styles[variant]}`}
    >
      {label}
    </button>
  );
}

function formatUptime(seconds?: number): string {
  if (!seconds) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatLastActivity(iso?: string): string {
  if (!iso) return '';
  try {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return '';
  }
}

