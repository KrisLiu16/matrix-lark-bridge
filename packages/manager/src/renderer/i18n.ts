import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';

export type Locale = 'zh' | 'en';

const messages: Record<Locale, Record<string, string>> = {
  zh: {
    // App / Header
    'app.title': 'Matrix Lark Bridge 管理器',
    'app.subtitle': '飞书 Bridge 管理',
    // Theme
    'theme.light': '浅色',
    'theme.dark': '深色',
    'theme.system': '系统',
    // BridgeList
    'bridge.list.title': 'Matrix Lark Bridge',
    'bridge.list.new': '+ 新建',
    'bridge.list.count': '{count} 个 bridge',
    'bridge.list.count.one': '1 个 bridge',
    'bridge.list.empty': '还没有 Bridge',
    'bridge.list.empty.cta': '创建第一个 Bridge',
    'bridge.list.search': '搜索 bridge...',
    'bridge.status.running': '运行中',
    'bridge.status.stopped': '已停止',
    'bridge.status.error': '异常',
    'bridge.action.start': '启动',
    'bridge.action.stop': '停止',
    'bridge.action.restart': '重启',
    'bridge.action.logs': '日志',
    'bridge.action.config': '配置',
    'bridge.action.session': '会话',
    'bridge.action.delete': '删除',
    'bridge.action.delete.confirm': '删除 Bridge "{name}"? 此操作不可撤销。',
    'bridge.action.delete.title': '确认删除',
    'bridge.autoStart': '开机启动',
    'bridge.toast.started': '已启动 {name}',
    'bridge.toast.stopped': '已停止 {name}',
    'bridge.toast.restarted': '已重启 {name}',
    'bridge.toast.deleted': '已删除 {name}',
    'bridge.toast.created': '已创建 {name}',
    'bridge.toast.error': '操作失败: {error}',
    // StatusBar
    'statusbar.total': '共 {count} 个',
    'statusbar.running': '{count} 运行中',
    // BridgeConfig
    'config.title': '配置: {name}',
    'config.back': '返回',
    'config.feishu': '飞书凭据',
    'config.feishu.appId': 'App ID',
    'config.feishu.appSecret': 'App Secret',
    'config.feishu.apiBase': 'API Base URL',
    'config.feishu.hideSetup': '收起设置',
    'config.feishu.showSetup': '注册新飞书应用...',
    'config.claude': 'Claude Code',
    'config.claude.workDir': '工作目录',
    'config.claude.mode': '模式',
    'config.claude.model': '模型',
    'config.claude.effort': '推理强度',
    'config.claude.model.placeholder': 'sonnet (默认)',
    'config.claude.systemPrompt': '系统提示 (可选)',
    'config.claude.systemPrompt.placeholder': '可选系统提示',
    'config.claude.env': '运行时环境变量',
    'config.claude.env.reset': '恢复默认',
    'config.behavior': '行为',
    'config.behavior.autoStart': '开机自启',
    'config.behavior.streamPreview': '流式预览',
    'config.behavior.maxQueue': '最大排队数',
    'config.save': '保存',
    'config.saving': '保存中...',
    'config.saved': '配置已保存',
    'config.cancel': '取消',
    'config.loadFailed': '加载配置失败',
    // NewBridge
    'new.title': '新建 Bridge',
    'new.back': '返回',
    'new.step1.desc': '第一步: 设置飞书应用凭据',
    'new.step1.skip': '跳过 (我将手动输入凭据)',
    'new.step2.identity': 'Bridge 标识',
    'new.step2.name': '名称',
    'new.step2.name.placeholder': 'my-project',
    'new.step2.name.hint': '作为工作区目录名: ~/mlb-workspace/{name}',
    'new.step2.feishu': '飞书凭据',
    'new.step2.claude': 'Claude Code',
    'new.step2.workDir': '工作目录',
    'new.step2.workDir.placeholder': '自动根据名称生成',
    'new.step2.permissionMode': '权限模式',
    'new.step2.behavior': '行为',
    'new.step2.autoStart': '开机自启',
    'new.create': '创建 Bridge',
    'new.creating': '创建中...',
    'new.backToFeishu': '返回飞书设置',
    'new.error.nameRequired': 'Bridge 名称是必填的',
    'new.error.nameInvalid': '名称只允许字母、数字、连字符和下划线',
    'new.error.credentialsRequired': 'App ID 和 App Secret 是必填的',
    'new.error.workDirRequired': '工作目录是必填的',
    // FeishuSetup
    'feishu.title': '飞书应用注册',
    'feishu.qr.label': '扫码注册',
    'feishu.qr.desc': '推荐。用飞书扫码。',
    'feishu.manual.label': '手动输入',
    'feishu.manual.desc': '直接输入 App ID 和 App Secret。',
    'feishu.qr.title': '扫码注册',
    'feishu.qr.back': '返回',
    'feishu.qr.initializing': '初始化中...',
    'feishu.qr.scanHint': '用飞书扫码注册',
    'feishu.qr.waiting': '等待授权...',
    'feishu.qr.success': '授权成功!',
    'feishu.qr.tryAgain': '重试',
    'feishu.manual.title': '手动输入凭据',
    'feishu.manual.back': '返回',
    'feishu.manual.appId': 'App ID',
    'feishu.manual.appSecret': 'App Secret',
    'feishu.manual.appSecret.placeholder': '输入 App Secret',
    'feishu.validate': '验证',
    'feishu.validating': '验证中...',
    'feishu.valid': '验证通过! {botName}',
    'feishu.invalid': '验证失败: {error}',
    // LogViewer
    'logs.title': '日志: {name}',
    'logs.back': '返回',
    'logs.live': 'live',
    'logs.filter.placeholder': '过滤...',
    'logs.autoScroll': '自动滚动',
    'logs.stream.stop': '停止',
    'logs.stream.start': '实时',
    'logs.refresh': '刷新',
    'logs.empty': '暂无日志',
    'logs.empty.filtered': '没有匹配过滤条件的日志',
    // SessionViewer
    'session.title': '会话: {name}',
    'session.back': '返回',
    'session.refresh': '刷新',
    'session.loading': '加载中...',
    'session.empty': '暂无会话数据',
    'session.info': '会话信息',
    'session.id': '会话 ID',
    'session.id.none': '(无)',
    'session.workDir': '工作目录',
    'session.lastActivity': '最后活跃',
    'session.stepCount': '步骤数',
    'session.started': '启动时间',
    'session.currentMessage': '当前消息',
    'session.history': '工具调用历史 ({count} 步)',
    // Claude Setup
    'claude.setup.title': '需要安装 Claude Code',
    'claude.setup.desc': 'Bridge 需要 Claude Code CLI 才能运行。点击下方按钮一键安装。',
    'claude.setup.install': '一键安装 Claude Code',
    'claude.setup.manual': '手动安装指南',
    'claude.setup.step.env': '检测系统环境',
    'claude.setup.step.check': '检查已有安装',
    'claude.setup.step.download': '下载 Claude Code 到 ~/.mlb/bin/',
    'claude.setup.step.verify': '验证安装',
    'claude.setup.success': 'Claude Code 安装成功!',
    'claude.setup.version': '版本 {version}',
    'claude.setup.continue': '继续',
    'claude.setup.retry': '重试',
    'claude.setup.error': '安装失败',
    'claude.setup.installed': 'Claude Code 已安装',
    // Common
    'common.loading': '加载中...',
    'common.error': '出错了',
    'common.language': '语言',
    'common.confirm': '确认',
    'common.cancel': '取消',
    'common.noSelection': '从左侧选择一个 Bridge 查看详情',
  },
  en: {
    'app.title': 'Matrix Lark Bridge Manager',
    'app.subtitle': 'Lark Bridge Management',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'theme.system': 'System',
    'bridge.list.title': 'Matrix Lark Bridge',
    'bridge.list.new': '+ New Bridge',
    'bridge.list.count': '{count} bridges',
    'bridge.list.count.one': '1 bridge',
    'bridge.list.empty': 'No bridges configured',
    'bridge.list.empty.cta': 'Create your first bridge',
    'bridge.list.search': 'Search bridges...',
    'bridge.status.running': 'Running',
    'bridge.status.stopped': 'Stopped',
    'bridge.status.error': 'Error',
    'bridge.action.start': 'Start',
    'bridge.action.stop': 'Stop',
    'bridge.action.restart': 'Restart',
    'bridge.action.logs': 'Logs',
    'bridge.action.config': 'Config',
    'bridge.action.session': 'Session',
    'bridge.action.delete': 'Delete',
    'bridge.action.delete.confirm': 'Delete bridge "{name}"? This cannot be undone.',
    'bridge.action.delete.title': 'Confirm Delete',
    'bridge.autoStart': 'auto-start',
    'bridge.toast.started': 'Started {name}',
    'bridge.toast.stopped': 'Stopped {name}',
    'bridge.toast.restarted': 'Restarted {name}',
    'bridge.toast.deleted': 'Deleted {name}',
    'bridge.toast.created': 'Created {name}',
    'bridge.toast.error': 'Operation failed: {error}',
    'statusbar.total': '{count} total',
    'statusbar.running': '{count} running',
    'config.title': 'Configure: {name}',
    'config.back': 'Back',
    'config.feishu': 'Feishu Credentials',
    'config.feishu.appId': 'App ID',
    'config.feishu.appSecret': 'App Secret',
    'config.feishu.apiBase': 'API Base URL',
    'config.feishu.hideSetup': 'Hide setup',
    'config.feishu.showSetup': 'Register new Feishu app...',
    'config.claude': 'Claude Code',
    'config.claude.workDir': 'Work Directory',
    'config.claude.mode': 'Mode',
    'config.claude.model': 'Model',
    'config.claude.effort': 'Effort Level',
    'config.claude.model.placeholder': 'sonnet (default)',
    'config.claude.systemPrompt': 'System Prompt (optional)',
    'config.claude.systemPrompt.placeholder': 'Optional system prompt',
    'config.claude.env': 'Runtime Environment',
    'config.claude.env.reset': 'Reset to defaults',
    'config.behavior': 'Behavior',
    'config.behavior.autoStart': 'Auto-start on boot',
    'config.behavior.streamPreview': 'Stream preview',
    'config.behavior.maxQueue': 'Max queue size',
    'config.save': 'Save',
    'config.saving': 'Saving...',
    'config.saved': 'Configuration saved',
    'config.cancel': 'Cancel',
    'config.loadFailed': 'Failed to load config',
    'new.title': 'Create New Bridge',
    'new.back': 'Back',
    'new.step1.desc': 'Step 1: Set up Feishu app credentials',
    'new.step1.skip': 'Skip (I\'ll enter credentials manually)',
    'new.step2.identity': 'Bridge Identity',
    'new.step2.name': 'Name',
    'new.step2.name.placeholder': 'my-project',
    'new.step2.name.hint': 'Used as the workspace directory name: ~/mlb-workspace/{name}',
    'new.step2.feishu': 'Feishu Credentials',
    'new.step2.claude': 'Claude Code',
    'new.step2.workDir': 'Work Directory',
    'new.step2.workDir.placeholder': '自动根据名称生成',
    'new.step2.permissionMode': 'Permission Mode',
    'new.step2.behavior': 'Behavior',
    'new.step2.autoStart': 'Auto-start on boot',
    'new.create': 'Create Bridge',
    'new.creating': 'Creating...',
    'new.backToFeishu': 'Back to Feishu Setup',
    'new.error.nameRequired': 'Bridge name is required',
    'new.error.nameInvalid': 'Name must contain only letters, numbers, hyphens, and underscores',
    'new.error.credentialsRequired': 'App ID and App Secret are required',
    'new.error.workDirRequired': 'Work directory is required',
    'feishu.title': 'Feishu App Registration',
    'feishu.qr.label': 'Scan QR Code',
    'feishu.qr.desc': 'Recommended. Scan with Feishu app.',
    'feishu.manual.label': 'Manual Input',
    'feishu.manual.desc': 'Enter App ID and App Secret directly.',
    'feishu.qr.title': 'Scan QR Code',
    'feishu.qr.back': 'Back',
    'feishu.qr.initializing': 'Initializing...',
    'feishu.qr.scanHint': 'Scan with Feishu to register',
    'feishu.qr.waiting': 'Waiting for authorization...',
    'feishu.qr.success': 'Authorization successful!',
    'feishu.qr.tryAgain': 'Try again',
    'feishu.manual.title': 'Manual Credentials',
    'feishu.manual.back': 'Back',
    'feishu.manual.appId': 'App ID',
    'feishu.manual.appSecret': 'App Secret',
    'feishu.manual.appSecret.placeholder': 'Enter app secret',
    'feishu.validate': 'Validate',
    'feishu.validating': 'Validating...',
    'feishu.valid': 'Valid! {botName}',
    'feishu.invalid': 'Invalid: {error}',
    'logs.title': 'Logs: {name}',
    'logs.back': 'Back',
    'logs.live': 'live',
    'logs.filter.placeholder': 'Filter...',
    'logs.autoScroll': 'Auto-scroll',
    'logs.stream.stop': 'Stop',
    'logs.stream.start': 'Stream',
    'logs.refresh': 'Refresh',
    'logs.empty': 'No log entries',
    'logs.empty.filtered': 'No log entries matching filter',
    'session.title': 'Session: {name}',
    'session.back': 'Back',
    'session.refresh': 'Refresh',
    'session.loading': 'Loading...',
    'session.empty': 'No session data available',
    'session.info': 'Session Info',
    'session.id': 'Session ID',
    'session.id.none': '(none)',
    'session.workDir': 'Working Directory',
    'session.lastActivity': 'Last Activity',
    'session.stepCount': 'Step Count',
    'session.started': 'Started',
    'session.currentMessage': 'Current Message',
    'session.history': 'Tool Call History ({count} steps)',
    'claude.setup.title': 'Claude Code Required',
    'claude.setup.desc': 'Bridge requires Claude Code CLI to run. Click below to install automatically.',
    'claude.setup.install': 'Install Claude Code',
    'claude.setup.manual': 'Manual install guide',
    'claude.setup.step.env': 'Detect system environment',
    'claude.setup.step.check': 'Check existing installation',
    'claude.setup.step.download': 'Download Claude Code to ~/.mlb/bin/',
    'claude.setup.step.verify': 'Verify installation',
    'claude.setup.success': 'Claude Code installed successfully!',
    'claude.setup.version': 'Version {version}',
    'claude.setup.continue': 'Continue',
    'claude.setup.retry': 'Retry',
    'claude.setup.error': 'Installation failed',
    'claude.setup.installed': 'Claude Code is installed',
    'common.loading': 'Loading...',
    'common.error': 'Error',
    'common.language': 'Language',
    'common.confirm': 'Confirm',
    'common.cancel': 'Cancel',
    'common.noSelection': 'Select a bridge from the sidebar to view details',
  },
};

// --- Locale state (singleton) ---

let currentLocale: Locale = 'en';
const listeners = new Set<() => void>();

function detectLocale(): Locale {
  // Check localStorage first (user preference persisted)
  const stored = localStorage.getItem('mlb-locale');
  if (stored === 'zh' || stored === 'en') return stored;

  // Then try system locale from Electron
  // (will be set asynchronously on startup via initLocale)
  return 'en'; // fallback
}

/** Call once at app startup to detect system locale via Electron IPC */
export async function initLocale(): Promise<void> {
  // Check localStorage first
  const stored = localStorage.getItem('mlb-locale');
  if (stored === 'zh' || stored === 'en') {
    currentLocale = stored;
    notify();
    return;
  }

  // Get system locale from Electron main process
  try {
    const systemLocale: string = await window.mlb.system.getLocale();
    currentLocale = systemLocale.startsWith('zh') ? 'zh' : 'en';
  } catch {
    currentLocale = 'en';
  }
  notify();
}

function notify(): void {
  listeners.forEach((fn) => fn());
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (currentLocale === locale) return;
  currentLocale = locale;
  localStorage.setItem('mlb-locale', locale);
  notify();
}

/**
 * Translate a key with optional variable interpolation.
 * Variables use `{name}` syntax: `t('config.title', { name: 'foo' })` => "Configure: foo"
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let text = messages[currentLocale]?.[key] ?? messages.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}

/**
 * React hook for i18n. Re-renders component when locale changes.
 */
export function useI18n() {
  const locale = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => currentLocale,
  );

  return {
    t,
    locale,
    setLocale,
  };
}
