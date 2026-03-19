import { app, ipcMain, type BrowserWindow } from 'electron';
import type { BridgeConfig } from '@mlb/shared';
import { WORKSPACE_ROOT } from '@mlb/shared';
import type { BridgeProcessManager } from './bridge-process-manager.js';
import type { ConfigStore } from './config-store.js';
import type { AutoStartManager } from './auto-start.js';
import type { FeishuSetup } from './feishu-setup.js';
import type { ClaudeSetup } from './claude-setup.js';

const BRIDGE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a bridge name parameter from IPC.
 * Prevents path traversal and ensures the name is safe for filesystem use.
 */
function validateBridgeName(name: unknown): string {
  if (typeof name !== 'string' || !BRIDGE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid bridge name: "${String(name)}". Only letters, numbers, hyphens, and underscores are allowed.`,
    );
  }
  return name;
}

/**
 * Register all IPC handlers for renderer ↔ main process communication.
 */
export function registerIPCHandlers(
  processManager: BridgeProcessManager,
  configStore: ConfigStore,
  autoStart: AutoStartManager,
  feishuSetup: FeishuSetup,
  claudeSetup: ClaudeSetup,
  getMainWindow: () => BrowserWindow | null,
): void {
  // --- Bridge management ---

  ipcMain.handle('bridge:list', async () => {
    return processManager.listBridges();
  });

  ipcMain.handle('bridge:start', async (_event, name: string) => {
    await processManager.startBridge(validateBridgeName(name));
  });

  ipcMain.handle('bridge:stop', async (_event, name: string) => {
    await processManager.stopBridge(validateBridgeName(name));
  });

  ipcMain.handle('bridge:restart', async (_event, name: string) => {
    await processManager.restartBridge(validateBridgeName(name));
  });

  ipcMain.handle('bridge:create', async (_event, config: BridgeConfig) => {
    // Validate config
    const errors = configStore.validateConfig(config);
    if (errors.length > 0) {
      throw new Error(`Invalid config: ${errors.join(', ')}`);
    }
    await processManager.createBridge(config);
  });

  ipcMain.handle('bridge:delete', async (_event, name: string) => {
    const validName = validateBridgeName(name);
    // Also remove auto-start if enabled
    if (autoStart.isEnabled(validName)) {
      await autoStart.disable(validName);
    }
    await processManager.deleteBridge(validName);
  });

  ipcMain.handle('bridge:update-config', async (_event, name: string, updates: Partial<BridgeConfig>) => {
    configStore.updateConfig(validateBridgeName(name), updates);
  });

  ipcMain.handle('bridge:read-config', async (_event, name: string) => {
    return configStore.readConfig(validateBridgeName(name));
  });

  // --- Logs ---

  ipcMain.handle('bridge:logs', async (_event, name: string, lines?: number) => {
    return processManager.getLogs(validateBridgeName(name), lines);
  });

  // Log streaming via tail -f
  const activeLogStreams = new Map<string, () => void>();

  ipcMain.handle('bridge:logs-stream', async (_event, name: string) => {
    const validName = validateBridgeName(name);
    // Stop existing stream for this bridge
    const existing = activeLogStreams.get(validName);
    if (existing) existing();

    const mainWindow = getMainWindow();
    if (!mainWindow) return;

    const cleanup = processManager.tailLogs(validName, (line) => {
      try {
        mainWindow.webContents.send('log-line', { name: validName, line });
      } catch { /* window may be closed */ }
    });

    activeLogStreams.set(validName, cleanup);
  });

  ipcMain.handle('bridge:logs-stop', async (_event, name: string) => {
    const validName = validateBridgeName(name);
    const cleanup = activeLogStreams.get(validName);
    if (cleanup) {
      cleanup();
      activeLogStreams.delete(validName);
    }
  });

  // --- Session ---

  ipcMain.handle('bridge:session', async (_event, name: string) => {
    return processManager.getSession(validateBridgeName(name));
  });

  // --- Feishu setup ---

  ipcMain.handle('feishu:init-qr', async () => {
    return feishuSetup.initQR();
  });

  ipcMain.handle('feishu:poll-qr', async (_event, deviceCode: string) => {
    return feishuSetup.pollQR(deviceCode);
  });

  ipcMain.handle('feishu:validate', async (_event, appId: string, appSecret: string) => {
    return feishuSetup.validate(appId, appSecret);
  });

  // --- Auto-start ---

  ipcMain.handle('autostart:enable', async (_event, name: string) => {
    await autoStart.enable(validateBridgeName(name));
  });

  ipcMain.handle('autostart:disable', async (_event, name: string) => {
    await autoStart.disable(validateBridgeName(name));
  });

  ipcMain.handle('autostart:status', async (_event, name: string) => {
    return autoStart.isEnabled(validateBridgeName(name));
  });

  // --- System ---

  ipcMain.handle('app:get-workspace-root', async () => {
    return WORKSPACE_ROOT;
  });

  ipcMain.handle('app:get-locale', () => {
    return app.getLocale();
  });

  // --- Claude Code setup ---

  ipcMain.handle('claude:check', () => {
    return claudeSetup.check();
  });

  ipcMain.handle('claude:install', async () => {
    const win = getMainWindow();
    const result = await claudeSetup.install((progress) => {
      try { win?.webContents.send('claude-setup:step-progress', progress); } catch { /* window closed */ }
    });
    return result;
  });
}
