import { contextBridge, ipcRenderer } from 'electron';
import type { BridgeConfig, BridgeStatus, SessionState, FeishuQRInit, FeishuCredentials, FeishuValidation } from '@mlb/shared';

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
