import React, { useState, useEffect, useRef } from 'react';
import { useI18n } from '../i18n';

interface FeishuSetupProps {
  onCredentials: (appId: string, appSecret: string, botName?: string) => void;
}

type SetupMode = 'choose' | 'qr' | 'manual';

export default function FeishuSetup({ onCredentials }: FeishuSetupProps) {
  const [mode, setMode] = useState<SetupMode>('choose');
  const { t } = useI18n();

  if (mode === 'choose') {
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">{t('feishu.title')}</h3>
        <div className="flex gap-3">
          <button
            onClick={() => setMode('qr')}
            className="flex-1 px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl
              hover:bg-slate-50 dark:hover:bg-slate-700/30 text-sm text-left transition-colors"
          >
            <div className="font-medium text-slate-800 dark:text-slate-200">{t('feishu.qr.label')}</div>
            <div className="text-slate-500 dark:text-slate-400 text-xs mt-1">{t('feishu.qr.desc')}</div>
          </button>
          <button
            onClick={() => setMode('manual')}
            className="flex-1 px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl
              hover:bg-slate-50 dark:hover:bg-slate-700/30 text-sm text-left transition-colors"
          >
            <div className="font-medium text-slate-800 dark:text-slate-200">{t('feishu.manual.label')}</div>
            <div className="text-slate-500 dark:text-slate-400 text-xs mt-1">{t('feishu.manual.desc')}</div>
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'qr') {
    return <QRCodeSetup onCredentials={onCredentials} onBack={() => setMode('choose')} />;
  }

  return <ManualSetup onCredentials={onCredentials} onBack={() => setMode('choose')} />;
}

// --- QR Code Setup ---

function QRCodeSetup({
  onCredentials,
  onBack,
}: {
  onCredentials: (appId: string, appSecret: string, botName?: string) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'scanning' | 'success' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    initQR();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  async function initQR() {
    try {
      setStatus('loading');
      setError(null);
      const result = await window.mlb.feishu.initQR();
      setQrDataUrl(result.qrDataUrl);
      setDeviceCode(result.deviceCode);
      setStatus('scanning');

      pollTimerRef.current = setInterval(async () => {
        if (!result.deviceCode) return;
        try {
          const creds = await window.mlb.feishu.pollQR(result.deviceCode);
          if (creds) {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setStatus('success');

            const validation = await window.mlb.feishu.validate(creds.appId, creds.appSecret);
            onCredentials(creds.appId, creds.appSecret, validation.botName);
          }
        } catch (err) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setStatus('error');
          setError((err as Error).message);
        }
      }, 5000);
    } catch (err) {
      setStatus('error');
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">{t('feishu.qr.title')}</h3>
        <button onClick={onBack} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
          {t('feishu.qr.back')}
        </button>
      </div>

      {status === 'loading' && (
        <div className="flex items-center justify-center py-8">
          <div className="text-sm text-slate-500 dark:text-slate-400">{t('feishu.qr.initializing')}</div>
        </div>
      )}

      {status === 'scanning' && qrDataUrl && (
        <div className="flex flex-col items-center gap-3">
          <img src={qrDataUrl} alt="QR Code" className="w-56 h-56 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm" />
          <div className="text-sm text-slate-500 dark:text-slate-400">{t('feishu.qr.scanHint')}</div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="inline-block w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse-dot" />
            {t('feishu.qr.waiting')}
          </div>
        </div>
      )}

      {status === 'success' && (
        <div className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">{t('feishu.qr.success')}</div>
      )}

      {status === 'error' && (
        <div className="space-y-2">
          <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
          <button
            onClick={initQR}
            className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {t('feishu.qr.tryAgain')}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Manual Setup ---

function ManualSetup({
  onCredentials,
  onBack,
}: {
  onCredentials: (appId: string, appSecret: string, botName?: string) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ valid: boolean; botName?: string; error?: string } | null>(null);

  async function handleValidate() {
    if (!appId.trim() || !appSecret.trim()) return;

    setValidating(true);
    setValidation(null);

    try {
      const result = await window.mlb.feishu.validate(appId.trim(), appSecret.trim());
      setValidation(result);

      if (result.valid) {
        onCredentials(appId.trim(), appSecret.trim(), result.botName);
      }
    } catch (err) {
      setValidation({ valid: false, error: (err as Error).message });
    } finally {
      setValidating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">{t('feishu.manual.title')}</h3>
        <button onClick={onBack} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
          {t('feishu.manual.back')}
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('feishu.manual.appId')}</label>
          <input
            type="text"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="cli_..."
            className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors
              bg-slate-50 dark:bg-slate-700/50
              border border-slate-200 dark:border-slate-600
              text-slate-900 dark:text-slate-100
              focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('feishu.manual.appSecret')}</label>
          <input
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={t('feishu.manual.appSecret.placeholder')}
            className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors
              bg-slate-50 dark:bg-slate-700/50
              border border-slate-200 dark:border-slate-600
              text-slate-900 dark:text-slate-100
              focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
          />
        </div>
      </div>

      <button
        onClick={handleValidate}
        disabled={validating || !appId.trim() || !appSecret.trim()}
        className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-xl
          hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {validating ? t('feishu.validating') : t('feishu.validate')}
      </button>

      {validation && (
        <div className={`text-sm ${validation.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
          {validation.valid
            ? t('feishu.valid', { botName: validation.botName ? `Bot name: ${validation.botName}` : '' })
            : t('feishu.invalid', { error: validation.error || '' })}
        </div>
      )}
    </div>
  );
}
