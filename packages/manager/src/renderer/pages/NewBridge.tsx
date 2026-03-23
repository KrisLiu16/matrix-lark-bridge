import React, { useEffect, useState } from 'react';
import type { BridgeConfig, WechatConfig } from '@mlb/shared';

const DEFAULT_CLAUDE_ENV = {
  ANTHROPIC_BASE_URL: 'https://talkie-ali-virginia-prod-internal.xaminim.com/llm/debug/claude',
  ANTHROPIC_AUTH_TOKEN: 'none',
  ANTHROPIC_CUSTOM_HEADERS: 'X-Biz-Id: claude-code',
};
import { useBridgeStore } from '../stores/bridge-store';
import { useI18n } from '../i18n';
import FeishuSetup from '../components/FeishuSetup';

type Platform = 'feishu' | 'wechat' | 'both';
type Step = 'platform' | 'feishu' | 'config';

export default function NewBridge() {
  const { navigate, createBridge, loading } = useBridgeStore();
  const { t } = useI18n();

  const [platform, setPlatform] = useState<Platform | null>(null);
  const [name, setName] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [workDirManual, setWorkDirManual] = useState(false);
  const [mode, setMode] = useState<'default' | 'acceptEdits' | 'bypassPermissions'>('default');
  const [autoStart, setAutoStart] = useState(false);
  const [botName, setBotName] = useState('');
  const [wechatToken, setWechatToken] = useState<{ botToken: string; ilinkBotId: string; baseUrl?: string; userId?: string } | null>(null);
  const [wechatLoggedIn, setWechatLoggedIn] = useState(false);

  // Check WeChat login status on mount
  useEffect(() => {
    window.mlb.wechat.getToken().then((token) => {
      setWechatToken(token);
      setWechatLoggedIn(!!token);
    });
  }, []);

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
  const [step, setStep] = useState<Step>('platform');

  function handlePlatformSelect(p: Platform) {
    setPlatform(p);
    if (p === 'wechat') {
      // Skip feishu setup, go directly to config
      setStep('config');
    } else {
      setStep('feishu');
    }
  }

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

    const needsFeishu = platform === 'feishu' || platform === 'both';
    if (needsFeishu && (!appId.trim() || !appSecret.trim())) {
      e.credentials = t('new.error.credentialsRequired');
    }

    const needsWechat = platform === 'wechat' || platform === 'both';
    if (needsWechat && !wechatToken) {
      e.wechat = '请先在微信页面扫码登录';
    }

    if (!workDir.trim()) e.workDir = t('new.error.workDirRequired');
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleCreate() {
    if (!validate()) return;

    const needsFeishu = platform === 'feishu' || platform === 'both';
    const needsWechat = platform === 'wechat' || platform === 'both';

    const config: BridgeConfig = {
      name: name.trim(),
      app_id: needsFeishu ? appId.trim() : undefined,
      app_secret: needsFeishu ? appSecret.trim() : undefined,
      api_base_url: needsFeishu ? 'https://open.feishu.cn' : undefined,
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
      wechat: needsWechat && wechatToken ? {
        bot_token: wechatToken.botToken,
        ilink_bot_id: wechatToken.ilinkBotId,
        state: 'connected' as const,
        last_active: new Date().toISOString(),
      } as WechatConfig : undefined,
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

      {/* Step 0: Platform selection */}
      {step === 'platform' && (
        <Section>
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">选择接入平台</h2>
          <div className="grid grid-cols-3 gap-3">
            <PlatformCard
              icon={<FeishuIcon />}
              label="飞书"
              desc="通过飞书 Bot 接入"
              selected={platform === 'feishu'}
              onClick={() => handlePlatformSelect('feishu')}
            />
            <PlatformCard
              icon={<WeChatIcon />}
              label="微信"
              desc={wechatLoggedIn ? '已登录，可直接绑定' : '需要先扫码登录'}
              selected={platform === 'wechat'}
              disabled={!wechatLoggedIn}
              onClick={() => handlePlatformSelect('wechat')}
            />
            <PlatformCard
              icon={<BothIcon />}
              label="飞书 + 微信"
              desc="同时接入两个平台"
              selected={platform === 'both'}
              disabled={!wechatLoggedIn}
              onClick={() => handlePlatformSelect('both')}
            />
          </div>
          {!wechatLoggedIn && (
            <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
              微信未登录 — 请先在左侧「微信」页面扫码登录后再选择微信接入
            </p>
          )}
        </Section>
      )}

      {/* Step 1: Feishu setup (only for feishu / both) */}
      {step === 'feishu' && (
        <Section>
          <div className="text-sm text-slate-500 dark:text-slate-400 mb-3">
            {t('new.step1.desc')}
          </div>
          <FeishuSetup onCredentials={handleFeishuCredentials} />

          <div className="pt-3 border-t border-slate-200 dark:border-slate-700 mt-4 flex justify-between">
            <button
              onClick={() => setStep('platform')}
              className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
            >
              返回选择平台
            </button>
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
          {/* Platform badge */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">平台:</span>
            {(platform === 'feishu' || platform === 'both') && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                <FeishuIcon className="h-3 w-3" /> 飞书
              </span>
            )}
            {(platform === 'wechat' || platform === 'both') && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
                <WeChatIcon className="h-3 w-3" /> 微信
              </span>
            )}
          </div>

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

          {/* Feishu credentials — only show if feishu / both */}
          {(platform === 'feishu' || platform === 'both') && (
            <Section title={t('new.step2.feishu')}>
              <div className="space-y-3">
                <InputField label={t('config.feishu.appId')} value={appId} onChange={setAppId} placeholder="cli_..." error={errors.credentials} />
                <InputField label={t('config.feishu.appSecret')} value={appSecret} onChange={setAppSecret} type="password" />
              </div>
              {botName && (
                <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">Bot: {botName}</div>
              )}
            </Section>
          )}

          {/* WeChat info — only show if wechat / both */}
          {(platform === 'wechat' || platform === 'both') && (
            <Section title="微信接入">
              {wechatToken ? (
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                    <WeChatIcon className="h-4 w-4 text-green-600 dark:text-green-400" />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-300">微信已登录</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 break-all">Bot ID: {wechatToken.ilinkBotId}</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-red-500">{errors.wechat || '请先在微信页面扫码登录'}</p>
              )}
            </Section>
          )}

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
              onClick={() => setStep(platform === 'wechat' ? 'platform' : 'feishu')}
              className="px-5 py-2.5 text-sm font-medium rounded-xl transition-colors
                bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300
                hover:bg-slate-200 dark:hover:bg-slate-600"
            >
              {platform === 'wechat' ? '返回选择平台' : t('new.backToFeishu')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Platform card ---

function PlatformCard({ icon, label, desc, selected, disabled, onClick }: {
  icon: React.ReactNode; label: string; desc: string; selected: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-center gap-2 rounded-xl border-2 p-4 text-center transition-all
        ${selected
          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
          : disabled
            ? 'border-slate-200 dark:border-slate-700 opacity-50 cursor-not-allowed'
            : 'border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 cursor-pointer'
        }`}
    >
      <span className="text-2xl">{icon}</span>
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      <span className="text-xs text-slate-500 dark:text-slate-400">{desc}</span>
    </button>
  );
}

// --- Icons ---

function FeishuIcon({ className }: { className?: string }) {
  return (
    <svg className={className || 'h-6 w-6'} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.5 2.5c0-.83.67-1.5 1.5-1.5h12c.83 0 1.5.67 1.5 1.5v19c0 .83-.67 1.5-1.5 1.5H6c-.83 0-1.5-.67-1.5-1.5v-19zM7 4v2h10V4H7zm0 4v2h10V8H7zm0 4v2h7v-2H7z" className="text-blue-500" />
    </svg>
  );
}

function WeChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className || 'h-6 w-6'} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05a6.127 6.127 0 0 1-.253-1.738c0-3.578 3.381-6.479 7.554-6.479.258 0 .507.026.758.043C16.803 4.56 13.087 2.188 8.691 2.188zm-2.87 4.4a1.035 1.035 0 1 1 0-2.07 1.035 1.035 0 0 1 0 2.07zm5.743 0a1.035 1.035 0 1 1 0-2.07 1.035 1.035 0 0 1 0 2.07z" className="text-green-500" />
      <path d="M23.503 14.666c0-3.309-3.139-5.992-7.009-5.992-3.87 0-7.009 2.683-7.009 5.992 0 3.309 3.14 5.993 7.01 5.993a8.87 8.87 0 0 0 2.365-.32.72.72 0 0 1 .598.082l1.585.926a.27.27 0 0 0 .14.046c.133 0 .241-.11.241-.245 0-.06-.024-.119-.04-.177l-.325-1.233a.493.493 0 0 1 .178-.556c1.526-1.124 2.266-2.835 2.266-4.516zm-9.592-.818a.863.863 0 1 1 0-1.726.863.863 0 0 1 0 1.726zm5.167 0a.863.863 0 1 1 0-1.726.863.863 0 0 1 0 1.726z" className="text-green-500" />
    </svg>
  );
}

function BothIcon() {
  return (
    <span className="flex items-center gap-1">
      <FeishuIcon className="h-5 w-5" />
      <span className="text-slate-400">+</span>
      <WeChatIcon className="h-5 w-5" />
    </span>
  );
}

// --- Shared components ---

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
