import { contextBridge, ipcRenderer } from 'electron';
import type { BridgeConfig, BridgeStatus, SessionState, FeishuQRInit, FeishuCredentials, FeishuValidation } from '@mlb/shared';
import type { StatusPayload } from '../shared/wechat-types.js';

const api = {
  bridge: {
    list: (): Promise<BridgeStatus[]> => ipcRenderer.invoke('bridge:list'),
    start: (name: string): Promise<void> => ipcRenderer.invoke('bridge:start', name),
    stop: (name: string): Promise<void> => ipcRenderer.invoke('bridge:stop', name),
    restart: (name: string): Promise<void> => ipcRenderer.invoke('bridge:restart', name),
    create: (config: BridgeConfig): Promise<void> => ipcRenderer.invoke('bridge:create', config),
    delete: (name: string): Promise<void> => ipcRenderer.invoke('bridge:delete', name),
    updateConfig: (name: string, config: Partial<BridgeConfig>): Promise<void> =>
      ipcRenderer.invoke('bridge:update-config', name, config),
    logs: (name: string, lines?: number): Promise<string[]> =>
      ipcRenderer.invoke('bridge:logs', name, lines),
    logsStream: (name: string): Promise<void> => ipcRenderer.invoke('bridge:logs-stream', name),
    logsStop: (name: string): Promise<void> => ipcRenderer.invoke('bridge:logs-stop', name),
    session: (name: string): Promise<SessionState | null> => ipcRenderer.invoke('bridge:session', name),
    readConfig: (name: string): Promise<BridgeConfig> => ipcRenderer.invoke('bridge:read-config', name),
    files: (name: string, subpath?: string): Promise<{
      entries: { name: string; path: string; isDirectory: boolean; size: number; modifiedTime: string }[];
      workDir: string;
      currentPath: string;
    }> => ipcRenderer.invoke('bridge:files', name, subpath),
    fileContent: (name: string, filePath: string, maxBytes?: number): Promise<{
      content: string; truncated: boolean; size: number;
    }> => ipcRenderer.invoke('bridge:file-content', name, filePath, maxBytes),
    revealFile: (name: string, filePath?: string): Promise<void> =>
      ipcRenderer.invoke('bridge:reveal-file', name, filePath),
  },
  feishu: {
    initQR: (): Promise<FeishuQRInit & { qrDataUrl: string }> => ipcRenderer.invoke('feishu:init-qr'),
    pollQR: (deviceCode: string): Promise<FeishuCredentials | null> =>
      ipcRenderer.invoke('feishu:poll-qr', deviceCode),
    validate: (appId: string, appSecret: string): Promise<FeishuValidation> =>
      ipcRenderer.invoke('feishu:validate', appId, appSecret),
  },
  autostart: {
    enable: (name: string): Promise<void> => ipcRenderer.invoke('autostart:enable', name),
    disable: (name: string): Promise<void> => ipcRenderer.invoke('autostart:disable', name),
    status: (name: string): Promise<boolean> => ipcRenderer.invoke('autostart:status', name),
  },
  deepforge: {
    list: (): Promise<{
      id: string; title: string; phase: string; currentIteration: number;
      totalIterations: number; totalCostUsd: number; isRunning: boolean;
      source: string; tasks: { role: string; status: string }[];
    }[]> => ipcRenderer.invoke('deepforge:list'),
    status: (projectId: string): Promise<any> => ipcRenderer.invoke('deepforge:status', projectId),
    logs: (projectId: string, lines?: number): Promise<string[]> =>
      ipcRenderer.invoke('deepforge:logs', projectId, lines),
    taskLog: (projectId: string, taskId: string): Promise<string[]> =>
      ipcRenderer.invoke('deepforge:task-log', projectId, taskId),
    reveal: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('deepforge:reveal', projectId),
    stop: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('deepforge:stop', projectId),
    resume: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('deepforge:resume', projectId),
    delete: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('deepforge:delete', projectId),
    inject: (projectId: string, message: string): Promise<void> =>
      ipcRenderer.invoke('deepforge:inject', projectId, message),
    package: (projectId: string): Promise<{ path: string }> =>
      ipcRenderer.invoke('deepforge:package', projectId),
    packageStop: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('deepforge:package-stop', projectId),
    onPackageProgress: (callback: (data: { projectId: string; step: string }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on('deepforge:package-progress', handler);
      return () => { ipcRenderer.removeListener('deepforge:package-progress', handler); };
    },
    setConfig: (projectId: string, key: string, value: any): Promise<void> =>
      ipcRenderer.invoke('deepforge:set-config', projectId, key, value),
    attach: (projectId: string, taskId: string): Promise<void> =>
      ipcRenderer.invoke('deepforge:attach', projectId, taskId),
  },
  wechat: {
    login: (): Promise<{ qrcodeUrl: string }> => ipcRenderer.invoke('wechat:login'),
    status: (): Promise<StatusPayload> => ipcRenderer.invoke('wechat:status'),
    logout: (): Promise<void> => ipcRenderer.invoke('wechat:logout'),
    cancel: (): Promise<void> => ipcRenderer.invoke('wechat:cancel'),
    getToken: (): Promise<{ botToken: string; ilinkBotId: string; baseUrl?: string; userId?: string } | null> =>
      ipcRenderer.invoke('wechat:getToken'),
    onStatusUpdate: (callback: (payload: StatusPayload) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: StatusPayload) => callback(payload);
      ipcRenderer.on('wechat:status-update', handler);
      return () => { ipcRenderer.removeListener('wechat:status-update', handler); };
    },
  },
  claude: {
    check: (): Promise<{ installed: boolean; version?: string; path?: string }> =>
      ipcRenderer.invoke('claude:check'),
    install: (): Promise<{ installed: boolean; version?: string; path?: string }> =>
      ipcRenderer.invoke('claude:install'),
    uninstall: (): Promise<{ success: boolean; removed: string[] }> =>
      ipcRenderer.invoke('claude:uninstall'),
  },
  system: {
    getWorkspaceRoot: (): Promise<string> => ipcRenderer.invoke('app:get-workspace-root'),
    getLocale: (): Promise<string> => ipcRenderer.invoke('app:get-locale'),
    getRunningCount: (): Promise<number> => ipcRenderer.invoke('app:get-running-count'),
    checkUpdate: (): Promise<{
      hasUpdate: boolean; forceUpdate?: boolean; version?: string;
      notes?: string; downloadUrl?: string; publishDate?: string;
    }> => ipcRenderer.invoke('app:check-update'),
    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('app:open-url', url),
  },
  onClaudeSetupProgress: (callback: (progress: {
    step: number; totalSteps: number; status: string; label: string; detail?: string; error?: string;
  }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: any) => callback(progress);
    ipcRenderer.on('claude-setup:step-progress', handler);
    return () => { ipcRenderer.removeListener('claude-setup:step-progress', handler); };
  },
  onLogLine: (callback: (data: { name: string; line: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { name: string; line: string }) => callback(data);
    ipcRenderer.on('log-line', handler);
    return () => {
      ipcRenderer.removeListener('log-line', handler);
    };
  },
};

contextBridge.exposeInMainWorld('mlb', api);

export type MlbAPI = typeof api;
