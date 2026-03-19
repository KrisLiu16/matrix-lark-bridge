import React, { useState } from 'react';
import type { BridgeConfig } from '@mlb/shared';

const DEFAULT_CLAUDE_ENV = {
  ANTHROPIC_BASE_URL: 'https://talkie-ali-virginia-prod-internal.xaminim.com/llm/debug/claude',
  ANTHROPIC_AUTH_TOKEN: 'none',
  ANTHROPIC_CUSTOM_HEADERS: 'X-Biz-Id: claude-code',
};
import { useBridgeStore } from '../stores/bridge-store';
import { useI18n } from '../i18n';
import FeishuSetup from '../components/FeishuSetup';

export default function NewBridge() {
  const { navigate, createBridge, loading } = useBridgeStore();
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [workDirManual, setWorkDirManual] = useState(false);
  const [mode, setMode] = useState<'default' | 'acceptEdits' | 'bypassPermissions'>('default');
  const [autoStart, setAutoStart] = useState(false);
  const [botName, setBotName] = useState('');

  function handleNameChange(v: string) {
    setName(v);
    if (!workDirManual && v.trim()) {
      setWorkDir(`~/mlb-workspace/${v.trim()}`);
    }
  }

  function handleWorkDirChange(v: string) {
    setWorkDirManual(true);
    setWorkDir(v);
  }
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<'feishu' | 'config'>('feishu');

  function handleFeishuCredentials(id: string, secret: string, detectedBotName?: string) {
    setAppId(id);
    setAppSecret(secret);
    if (detectedBotName) setBotName(detectedBotName);
    setStep('config');
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = t('new.error.nameRequired');
    else if (!/^[a-zA-Z0-9_-]+$/.test(name.trim())) e.name = t('new.error.nameInvalid');
    if (!appId.trim() || !appSecret.trim()) e.credentials = t('new.error.credentialsRequired');
    if (!workDir.trim()) e.workDir = t('new.error.workDirRequired');
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleCreate() {
    if (!validate()) return;

    const config: BridgeConfig = {
      name: name.trim(),
      app_id: appId.trim(),
      app_secret: appSecret.trim(),
      api_base_url: 'https://open.feishu.cn',
      work_dir: workDir.trim(),
      claude: {
        mode,
        model: 'sonnet',
        effort: 'medium',
        env: { ...DEFAULT_CLAUDE_ENV },
      },
      stream_preview: {
        enabled: true,
        interval_ms: 2000,
        min_delta_chars: 50,
        max_chars: 3000,
      },
      auto_start: autoStart,
      bot_name: botName || undefined,
    };

    try {
      await createBridge(config);
    } catch (err) {
      setErrors({ general: (err as Error).message });
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('list')} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
          {t('new.back')}
        </button>
        <h1 className="text-lg font-semibold">{t('new.title')}</h1>
      </div>

      {errors.general && (
        <div className="mb-4 px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-700 dark:text-red-400">
          {errors.general}
        </div>
      )}

      {/* Step 1: Feishu setup */}
      {step === 'feishu' && (
        <Section>
          <div className="text-sm text-slate-500 dark:text-slate-400 mb-3">
            {t('new.step1.desc')}
          </div>
          <FeishuSetup onCredentials={handleFeishuCredentials} />

          <div className="pt-3 border-t border-slate-200 dark:border-slate-700 mt-4">
            <button
              onClick={() => setStep('config')}
              className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
            >
              {t('new.step1.skip')}
            </button>
          </div>
        </Section>
      )}

      {/* Step 2: Bridge config */}
      {step === 'config' && (
        <div className="space-y-4">
          {/* Name */}
          <Section title={t('new.step2.identity')}>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('new.step2.name')}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => { handleNameChange(e.target.value); setErrors((prev) => { const { name: _, ...rest } = prev; return rest; }); }}
                placeholder={t('new.step2.name.placeholder')}
                className={`w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors
                  bg-slate-50 dark:bg-slate-700/50
                  border ${errors.name ? 'border-red-400 dark:border-red-600' : 'border-slate-200 dark:border-slate-600'}
                  text-slate-900 dark:text-slate-100
                  focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20`}
              />
              {errors.name ? (
                <p className="text-xs text-red-500 mt-1">{errors.name}</p>
              ) : (
                <p className="text-xs text-slate-400 mt-1">
                  {t('new.step2.name.hint', { name: name || '<name>' })}
                </p>
              )}
            </div>
          </Section>

          {/* Feishu credentials */}
          <Section title={t('new.step2.feishu')}>
            <div className="space-y-3">
              <InputField label={t('config.feishu.appId')} value={appId} onChange={setAppId} placeholder="cli_..." error={errors.credentials} />
              <InputField label={t('config.feishu.appSecret')} value={appSecret} onChange={setAppSecret} type="password" />
            </div>
            {botName && (
              <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">Bot: {botName}</div>
            )}
          </Section>

          {/* Claude settings */}
          <Section title={t('new.step2.claude')}>
            <div className="space-y-3">
              <InputField label={t('new.step2.workDir')} value={workDir} onChange={handleWorkDirChange} placeholder={t('new.step2.workDir.placeholder')} error={errors.workDir} />
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('new.step2.permissionMode')}</label>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors
                    bg-slate-50 dark:bg-slate-700/50
                    border border-slate-200 dark:border-slate-600
                    text-slate-900 dark:text-slate-100
                    focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                >
                  <option value="default">Default</option>
                  <option value="acceptEdits">Accept Edits</option>
                  <option value="bypassPermissions">Bypass Permissions</option>
                </select>
              </div>
            </div>
          </Section>

          {/* Behavior */}
          <Section title={t('new.step2.behavior')}>
            <label className="flex items-center gap-2.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-600 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-slate-700 dark:text-slate-300">{t('new.step2.autoStart')}</span>
            </label>
          </Section>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              disabled={loading}
              className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl
                hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? t('new.creating') : t('new.create')}
            </button>
            <button
              onClick={() => setStep('feishu')}
              className="px-5 py-2.5 text-sm font-medium rounded-xl transition-colors
                bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300
                hover:bg-slate-200 dark:hover:bg-slate-600"
            >
              {t('new.backToFeishu')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-5 shadow-sm">
      {title && <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">{title}</h2>}
      {children}
    </div>
  );
}

function InputField({
  label, value, onChange, type = 'text', placeholder, error,
}: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; error?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors
          bg-slate-50 dark:bg-slate-700/50
          border ${error ? 'border-red-400 dark:border-red-600' : 'border-slate-200 dark:border-slate-600'}
          text-slate-900 dark:text-slate-100
          focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20`}
      />
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}
