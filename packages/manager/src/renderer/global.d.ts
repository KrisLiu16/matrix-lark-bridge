import type { BridgeConfig, BridgeStatus, SessionState, FeishuQRInit, FeishuCredentials, FeishuValidation } from '@mlb/shared';
import type { StatusPayload } from '../shared/wechat-types';

interface MlbAPI {
  bridge: {
    list(): Promise<BridgeStatus[]>;
    start(name: string): Promise<void>;
    stop(name: string): Promise<void>;
    restart(name: string): Promise<void>;
    create(config: BridgeConfig): Promise<void>;
    delete(name: string): Promise<void>;
    updateConfig(name: string, config: Partial<BridgeConfig>): Promise<void>;
    logs(name: string, lines?: number): Promise<string[]>;
    logsStream(name: string): Promise<void>;
    logsStop(name: string): Promise<void>;
    session(name: string): Promise<SessionState | null>;
    readConfig(name: string): Promise<BridgeConfig>;
    files(name: string, subpath?: string): Promise<{
      entries: { name: string; path: string; isDirectory: boolean; size: number; modifiedTime: string }[];
      workDir: string;
      currentPath: string;
    }>;
    fileContent(name: string, filePath: string, maxBytes?: number): Promise<{
      content: string; truncated: boolean; size: number;
    }>;
    revealFile(name: string, filePath?: string): Promise<void>;
  };
  feishu: {
    initQR(): Promise<FeishuQRInit & { qrDataUrl: string }>;
    pollQR(deviceCode: string): Promise<FeishuCredentials | null>;
    validate(appId: string, appSecret: string): Promise<FeishuValidation>;
  };
  autostart: {
    enable(name: string): Promise<void>;
    disable(name: string): Promise<void>;
    status(name: string): Promise<boolean>;
  };
  deepforge: {
    list(): Promise<{
      id: string; title: string; phase: string; currentIteration: number;
      totalIterations: number; totalCostUsd: number; totalTokens: number;
      isRunning: boolean; source: string; maxConcurrent: number;
      tasks: { id?: string; role: string; status: string; description?: string; error?: string; output?: string; startedAt?: string }[];
    }[]>;
    status(projectId: string): Promise<any>;
    logs(projectId: string, lines?: number): Promise<string[]>;
    taskLog(projectId: string, taskId: string): Promise<string[]>;
    reveal(projectId: string): Promise<void>;
    stop(projectId: string): Promise<void>;
    resume(projectId: string): Promise<void>;
    delete(projectId: string): Promise<void>;
    inject(projectId: string, message: string): Promise<void>;
    package(projectId: string): Promise<{ path: string }>;
    packageStop(projectId: string): Promise<void>;
    onPackageProgress(callback: (data: { projectId: string; step: string }) => void): () => void;
    setConfig(projectId: string, key: string, value: any): Promise<void>;
    attach(projectId: string, taskId: string): Promise<void>;
  };
  wechat: {
    login(): Promise<{ qrcodeUrl: string }>;
    status(): Promise<StatusPayload>;
    logout(): Promise<void>;
    cancel(): Promise<void>;
    getToken(): Promise<{ botToken: string; ilinkBotId: string; baseUrl?: string; userId?: string } | null>;
    onStatusUpdate(callback: (payload: StatusPayload) => void): () => void;
  };
  system: {
    getWorkspaceRoot(): Promise<string>;
    getLocale(): Promise<string>;
    getRunningCount(): Promise<number>;
    checkUpdate(): Promise<{
      hasUpdate: boolean; forceUpdate?: boolean; version?: string;
      notes?: string; downloadUrl?: string; publishDate?: string;
    }>;
    openUrl(url: string): Promise<void>;
  };
  claude: {
    check(): Promise<{ installed: boolean; version?: string; path?: string }>;
    install(): Promise<{ installed: boolean; version?: string; path?: string }>;
    uninstall(): Promise<{ success: boolean; removed: string[] }>;
  };
  onClaudeSetupProgress(callback: (progress: {
    step: number; totalSteps: number; status: string; label: string; detail?: string; error?: string;
  }) => void): () => void;
  onLogLine(callback: (data: { name: string; line: string }) => void): () => void;
}

declare global {
  interface Window {
    mlb: MlbAPI;
  }
}

export {};
