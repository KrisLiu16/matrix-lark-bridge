import React, { useState, useEffect } from 'react';
import type { BridgeConfig as BridgeConfigType } from '@mlb/shared';

const DEFAULT_CLAUDE_ENV = {
  ANTHROPIC_BASE_URL: 'https://talkie-ali-virginia-prod-internal.xaminim.com/llm/debug/claude',
  ANTHROPIC_AUTH_TOKEN: 'none',
  ANTHROPIC_CUSTOM_HEADERS: 'X-Biz-Id: claude-code',
};
import { useBridgeStore } from '../stores/bridge-store';
import { useI18n } from '../i18n';
import { toast } from '../stores/toast-store';
import FeishuSetup from '../components/FeishuSetup';

interface BridgeConfigProps {
  name: string;
}

export default function BridgeConfig({ name }: BridgeConfigProps) {
  const { navigate, updateConfig } = useBridgeStore();
  const { t } = useI18n();
  const [config, setConfig] = useState<BridgeConfigType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showFeishuSetup, setShowFeishuSetup] = useState(false);

  useEffect(() => {
    loadConfig();
  }, [name]);

  async function loadConfig() {
    try {
      setLoading(true);
      const existingConfig = await window.mlb.bridge.readConfig(name);
      setConfig(existingConfig);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    try {
      await updateConfig(name, config);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function updateField<K extends keyof BridgeConfigType>(key: K, value: BridgeConfigType[K]) {
    if (!config) return;
    setConfig({ ...config, [key]: value });
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="space-y-4">
          <div className="skeleton h-8 w-48 rounded-lg" />
          <div className="skeleton h-40 rounded-xl" />
          <div className="skeleton h-40 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <button onClick={() => navigate('list', name)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline mb-4">
          {t('config.back')}
        </button>
        <div className="text-sm text-red-600 dark:text-red-400">{t('config.loadFailed')}</div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('list', name)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
          {t('config.back')}
        </button>
        <h1 className="text-lg font-semibold">{t('config.title', { name })}</h1>
      </div>

      <div className="space-y-5">
        {/* Feishu Credentials */}
        <Section title={t('config.feishu')}>
          <div className="space-y-3">
            <Field label={t('config.feishu.appId')} value={config.app_id || ''} onChange={(v) => updateField('app_id', v || undefined)} />
            <Field label={t('config.feishu.appSecret')} value={config.app_secret || ''} onChange={(v) => updateField('app_secret', v || undefined)} type="password" />
            <Field label={t('config.feishu.apiBase')} value={config.api_base_url || 'https://open.feishu.cn'} onChange={(v) => updateField('api_base_url', v)} />
          </div>

          <button
            onClick={() => setShowFeishuSetup(!showFeishuSetup)}
            className="mt-3 text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {showFeishuSetup ? t('config.feishu.hideSetup') : t('config.feishu.showSetup')}
          </button>

          {showFeishuSetup && (
            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
              <FeishuSetup
                onCredentials={(appId, appSecret, botName) => {
                  setConfig({
                    ...config,
                    app_id: appId,
                    app_secret: appSecret,
                    bot_name: botName,
                  });
                  setShowFeishuSetup(false);
                }}
              />
            </div>
          )}
        </Section>

        {/* Claude Code */}
        <Section title={t('config.claude')}>
          <div className="space-y-3">
            <Field label={t('config.claude.workDir')} value={config.work_dir} onChange={(v) => updateField('work_dir', v)} />
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('config.claude.mode')}</label>
              <select
                value={config.claude.mode}
                onChange={(e) =>
                  updateField('claude', {
                    ...config.claude,
                    mode: e.target.value as 'default' | 'acceptEdits' | 'bypassPermissions',
                  })
                }
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
            <Field
              label={t('config.claude.model')}
              value={config.claude.model || ''}
              onChange={(v) => updateField('claude', { ...config.claude, model: v || undefined })}
              placeholder={t('config.claude.model.placeholder')}
            />
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('config.claude.effort')}</label>
              <select
                value={config.claude.effort || 'medium'}
                onChange={(e) => updateField('claude', { ...config.claude, effort: e.target.value as any })}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors
                  bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600
                  text-slate-900 dark:text-slate-100 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
              >
                <option value="low">Low</option>
                <option value="medium">Medium (default)</option>
                <option value="high">High</option>
                <option value="max">Max</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('config.claude.systemPrompt')}</label>
              <textarea
                value={config.claude.system_prompt || ''}
                onChange={(e) =>
                  updateField('claude', { ...config.claude, system_prompt: e.target.value || undefined })
                }
                rows={3}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-y transition-colors
                  bg-slate-50 dark:bg-slate-700/50
                  border border-slate-200 dark:border-slate-600
                  text-slate-900 dark:text-slate-100
                  focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                placeholder={t('config.claude.systemPrompt.placeholder')}
              />
            </div>
            {/* Runtime env config */}
            <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-slate-600 dark:text-slate-400">{t('config.claude.env')}</label>
                <button
                  onClick={() => updateField('claude', { ...config.claude, env: { ...DEFAULT_CLAUDE_ENV } })}
                  className="text-xs text-indigo-500 hover:text-indigo-600 transition-colors"
                >{t('config.claude.env.reset')}</button>
              </div>
              <Field
                label="ANTHROPIC_BASE_URL"
                value={config.claude.env?.ANTHROPIC_BASE_URL || ''}
                onChange={(v) => updateField('claude', { ...config.claude, env: { ...config.claude.env, ANTHROPIC_BASE_URL: v } })}
                placeholder="https://api.anthropic.com"
              />
              <Field
                label="ANTHROPIC_AUTH_TOKEN"
                value={config.claude.env?.ANTHROPIC_AUTH_TOKEN || ''}
                onChange={(v) => updateField('claude', { ...config.claude, env: { ...config.claude.env, ANTHROPIC_AUTH_TOKEN: v } })}
                placeholder="none"
              />
              <Field
                label="ANTHROPIC_CUSTOM_HEADERS"
                value={config.claude.env?.ANTHROPIC_CUSTOM_HEADERS || ''}
                onChange={(v) => updateField('claude', { ...config.claude, env: { ...config.claude.env, ANTHROPIC_CUSTOM_HEADERS: v } })}
                placeholder=""
              />
            </div>
          </div>
        </Section>

        {/* Behavior */}
        <Section title={t('config.behavior')}>
          <div className="space-y-3">
            <label className="flex items-center gap-2.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={config.auto_start}
                onChange={(e) => updateField('auto_start', e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-600 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-slate-700 dark:text-slate-300">{t('config.behavior.autoStart')}</span>
            </label>
            <label className="flex items-center gap-2.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={config.stream_preview.enabled}
                onChange={(e) =>
                  updateField('stream_preview', { ...config.stream_preview, enabled: e.target.checked })
                }
                className="rounded border-slate-300 dark:border-slate-600 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-slate-700 dark:text-slate-300">{t('config.behavior.streamPreview')}</span>
            </label>
            <div className="flex items-center gap-2.5 text-sm">
              <label className="text-slate-700 dark:text-slate-300">{t('config.behavior.maxQueue')}</label>
              <input
                type="number"
                min={0}
                max={20}
                value={config.max_queue ?? 5}
                onChange={(e) => updateField('max_queue', parseInt(e.target.value) || 0)}
                className="w-16 px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-600
                  bg-white dark:bg-slate-800 text-sm"
              />
            </div>
          </div>
        </Section>

        {/* WeChat Binding */}
        <WechatBindingSection config={config} onUpdate={(wechat) => updateField('wechat', wechat)} />

        {/* Save */}
        <div className="flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl
              hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {saving ? t('config.saving') : t('config.save')}
          </button>
          <button
            onClick={() => navigate('list', name)}
            className="px-5 py-2.5 text-sm font-medium rounded-xl transition-colors
              bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300
              hover:bg-slate-200 dark:hover:bg-slate-600"
          >
            {t('config.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">{title}</h2>
      {children}
    </section>
  );
}

function WechatBindingSection({ config, onUpdate }: { config: BridgeConfigType; onUpdate: (wechat: BridgeConfigType['wechat']) => void }) {
  const [wechatToken, setWechatToken] = React.useState<{ botToken: string; ilinkBotId: string; baseUrl?: string; userId?: string } | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    window.mlb.wechat.getToken().then((token) => {
      setWechatToken(token);
      setLoading(false);
    });
  }, []);

  const isBound = !!config.wechat?.bot_token;

  function handleBind() {
    if (!wechatToken) return;
    onUpdate({
      bot_token: wechatToken.botToken,
      ilink_bot_id: wechatToken.ilinkBotId,
      state: 'connected' as const,
      last_active: new Date().toISOString(),
    });
  }

  function handleUnbind() {
    onUpdate(undefined);
  }

  if (loading) return null;

  return (
    <Section title="微信接入">
      {isBound ? (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 text-lg">
              &#x2713;
            </span>
            <div>
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">已绑定微信</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 break-all">Bot ID: {config.wechat!.ilink_bot_id}</p>
            </div>
          </div>
          <button
            onClick={handleUnbind}
            className="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
              bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400
              hover:bg-red-100 dark:hover:bg-red-900/40"
          >
            解除绑定
          </button>
        </div>
      ) : wechatToken ? (
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-slate-600 dark:text-slate-400">微信已登录，可绑定到此 Bridge</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 break-all">Bot ID: {wechatToken.ilinkBotId}</p>
          </div>
          <button
            onClick={handleBind}
            className="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
              bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400
              hover:bg-green-100 dark:hover:bg-green-900/40"
          >
            绑定微信
          </button>
        </div>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          微信未登录 — 请先在左侧「微信」页面扫码登录
        </p>
      )}
      <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
        绑定后需点击「保存」生效。同一时间仅一个 Bridge 可绑定微信。
      </p>
    </Section>
  );
}

function Field({
  label, value, onChange, type = 'text', placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors
          bg-slate-50 dark:bg-slate-700/50
          border border-slate-200 dark:border-slate-600
          text-slate-900 dark:text-slate-100
          focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
      />
    </div>
  );
}
