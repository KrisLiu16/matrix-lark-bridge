import { app, ipcMain, shell, type BrowserWindow } from 'electron';
import { readdirSync, statSync, readFileSync, existsSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import type { BridgeConfig } from '@mlb/shared';
import { WORKSPACE_ROOT } from '@mlb/shared';
import type { BridgeProcessManager } from './bridge-process-manager.js';
import type { ConfigStore } from './config-store.js';
import type { AutoStartManager } from './auto-start.js';
import type { FeishuSetup } from './feishu-setup.js';
import type { ClaudeSetup } from './claude-setup.js';
import { checkForUpdate, openDownloadUrl } from './update-checker.js';

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

  // --- Files ---

  function resolveWorkDir(name: string): string {
    const config = configStore.readConfig(name);
    const workDir = (config.work_dir || '').replace(/^~/, homedir());
    if (!workDir) throw new Error(`No work_dir configured for bridge "${name}"`);
    return resolve(workDir);
  }

  function assertInsideWorkDir(workDir: string, target: string): string {
    const resolved = resolve(workDir, target);
    // Resolve symlinks to prevent escape via symlink chains
    let realTarget: string;
    let realWorkDir: string;
    try { realTarget = realpathSync(resolved); } catch { realTarget = resolved; }
    try { realWorkDir = realpathSync(workDir); } catch { realWorkDir = workDir; }
    if (!realTarget.startsWith(realWorkDir + '/') && realTarget !== realWorkDir) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
  }

  ipcMain.handle('bridge:files', async (_event, name: string, subpath?: string) => {
    const validName = validateBridgeName(name);
    const workDir = resolveWorkDir(validName);
    const targetDir = subpath ? assertInsideWorkDir(workDir, subpath) : workDir;

    if (!existsSync(targetDir)) {
      throw new Error(`Directory not found: ${targetDir}`);
    }

    const entries = readdirSync(targetDir);
    const result: { name: string; path: string; isDirectory: boolean; size: number; modifiedTime: string }[] = [];

    for (const entry of entries) {
      if (entry.startsWith('.')) continue; // skip hidden files
      try {
        const fullPath = join(targetDir, entry);
        const stat = statSync(fullPath);
        result.push({
          name: entry,
          path: relative(workDir, fullPath),
          isDirectory: stat.isDirectory(),
          size: stat.isDirectory() ? 0 : stat.size,
          modifiedTime: stat.mtime.toISOString(),
        });
      } catch { /* skip inaccessible entries */ }
    }

    // Sort: directories first, then files, alphabetical within each group
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { entries: result, workDir, currentPath: relative(workDir, targetDir) || '.' };
  });

  ipcMain.handle('bridge:file-content', async (_event, name: string, filePath: string, maxBytes?: number) => {
    const validName = validateBridgeName(name);
    const workDir = resolveWorkDir(validName);
    const fullPath = assertInsideWorkDir(workDir, filePath);

    if (!existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) throw new Error('Cannot read directory as file');

    const MAX_FILE_READ = 10 * 1024 * 1024; // 10MB hard cap
    const limit = Math.min(maxBytes ?? 512 * 1024, MAX_FILE_READ);
    const buf = Buffer.alloc(Math.min(stat.size, limit));
    const fd = openSync(fullPath, 'r');
    try {
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      return {
        content: buf.toString('utf-8', 0, bytesRead),
        truncated: stat.size > limit,
        size: stat.size,
      };
    } finally {
      closeSync(fd);
    }
  });

  ipcMain.handle('bridge:reveal-file', async (_event, name: string, filePath?: string) => {
    const validName = validateBridgeName(name);
    const workDir = resolveWorkDir(validName);
    const fullPath = filePath ? assertInsideWorkDir(workDir, filePath) : workDir;

    if (existsSync(fullPath)) {
      shell.showItemInFolder(fullPath);
    } else {
      shell.openPath(workDir);
    }
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

  ipcMain.handle('claude:uninstall', async () => {
    return claudeSetup.uninstall();
  });

  // --- Update check ---

  ipcMain.handle('app:check-update', async () => {
    try {
      const names = configStore.listNames();
      if (names.length === 0) return { hasUpdate: false };

      const config = configStore.readConfig(names[0]);
      if (!config.app_id || !config.app_secret) return { hasUpdate: false };

      return await checkForUpdate(config.app_id, config.app_secret);
    } catch (err) {
      console.error('[update] check failed:', (err as Error).message);
      return { hasUpdate: false };
    }
  });

  ipcMain.handle('app:open-url', async (_event, url: string) => {
    openDownloadUrl(url);
  });
}
