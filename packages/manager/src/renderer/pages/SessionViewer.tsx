import React, { useState, useEffect } from 'react';
import type { SessionState } from '@mlb/shared';
import { useBridgeStore } from '../stores/bridge-store';
import { useI18n } from '../i18n';

interface SessionViewerProps {
  name: string;
}

export default function SessionViewer({ name }: SessionViewerProps) {
  const { navigate } = useBridgeStore();
  const { t } = useI18n();
  const [session, setSession] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSession();
    const interval = setInterval(loadSession, 5000);
    return () => clearInterval(interval);
  }, [name]);

  async function loadSession() {
    try {
      const data = await window.mlb.bridge.session(name);
      setSession(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function formatTime(seconds?: number): string {
    if (!seconds) return '-';
    const now = Math.floor(Date.now() / 1000);
    const diff = now - seconds;
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m ago`;
  }

  return (
    <div className="max-w-2xl mx-auto p-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('list', name)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
          {t('session.back')}
        </button>
        <h1 className="text-lg font-semibold">{t('session.title', { name })}</h1>
        <button
          onClick={loadSession}
          className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 ml-auto"
        >
          {t('session.refresh')}
        </button>
      </div>

      {loading && (
        <div className="space-y-4">
          <div className="skeleton h-40 rounded-xl" />
          <div className="skeleton h-60 rounded-xl" />
        </div>
      )}

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {!loading && !session && (
        <div className="text-center py-12 text-sm text-slate-400 dark:text-slate-600">
          {t('session.empty')}
        </div>
      )}

      {session && (
        <div className="space-y-4">
          {/* Session Info */}
          <section className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">{t('session.info')}</h2>
            <div className="space-y-2.5">
              <InfoRow label={t('session.id')} value={session.agentSessionId || t('session.id.none')} mono />
              <InfoRow label={t('session.workDir')} value={session.workDir} mono />
              <InfoRow label={t('session.lastActivity')} value={session.lastActivity || '-'} />
              <InfoRow label={t('session.stepCount')} value={String(session.stepCount)} />
              {session.startTime && (
                <InfoRow label={t('session.started')} value={formatTime(session.startTime)} />
              )}
              {session.currentMessageId && (
                <InfoRow label={t('session.currentMessage')} value={session.currentMessageId} mono />
              )}
            </div>
          </section>

          {/* Tool Call History */}
          {session.steps.length > 0 && (
            <section className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">
                {t('session.history', { count: session.steps.length })}
              </h2>
              <div className="max-h-80 overflow-auto space-y-0.5">
                {session.steps.map((step, i) => (
                  <div key={i} className="flex items-start gap-2.5 py-1.5 px-2 -mx-2 rounded-lg text-xs
                    hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                    <span className="text-slate-400 w-6 text-right shrink-0 font-mono">{i + 1}</span>
                    <span className="font-medium text-indigo-600 dark:text-indigo-400 w-20 shrink-0 truncate">{step.tool}</span>
                    <span className="text-slate-600 dark:text-slate-400 truncate">{step.label}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs text-slate-500 dark:text-slate-500 w-28 shrink-0">{label}</span>
      <span className={`text-sm break-all ${mono ? 'font-mono text-xs text-slate-700 dark:text-slate-300' : 'text-slate-900 dark:text-slate-100'}`}>
        {value}
      </span>
    </div>
  );
}
