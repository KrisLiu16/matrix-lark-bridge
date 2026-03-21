import { app, ipcMain, shell, type BrowserWindow } from 'electron';
import { readdirSync, statSync, readFileSync, existsSync, openSync, readSync, closeSync, realpathSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFile } from 'node:child_process';
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

  const cleanupAllLogStreams = () => {
    for (const [, cleanup] of activeLogStreams) cleanup();
    activeLogStreams.clear();
  };

  ipcMain.handle('bridge:logs-stream', async (_event, name: string) => {
    const validName = validateBridgeName(name);
    // Stop existing stream for this bridge
    const existing = activeLogStreams.get(validName);
    if (existing) existing();

    const mainWindow = getMainWindow();
    if (!mainWindow) return;

    // Clean up all streams when this window's webContents is destroyed
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.once('destroyed', cleanupAllLogStreams);
    }

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

  // --- DeepForge projects ---

  const DEEPFORGE_DIRS = [
    join(homedir(), '.deepforge', 'projects'),
  ];

  ipcMain.handle('deepforge:list', async () => {
    const projects: {
      id: string;
      title: string;
      phase: string;
      currentIteration: number;
      totalIterations: number;
      totalCostUsd: number;
      totalTokens: number;
      isRunning: boolean;
      source: string;
      tasks: { role: string; status: string; description?: string; error?: string; output?: string; startedAt?: string }[];
    }[] = [];

    for (const baseDir of DEEPFORGE_DIRS) {
      if (!existsSync(baseDir)) continue;
      let entries: string[];
      try { entries = readdirSync(baseDir); } catch { continue; }

      for (const id of entries) {
        const projectDir = join(baseDir, id);
        try {
          const stat = statSync(projectDir);
          if (!stat.isDirectory()) continue;
        } catch { continue; }

        // Read state
        const statePath = join(projectDir, 'forge-state.json');
        let phase = 'unknown';
        let currentIteration = 0;
        let totalIterations = 0;
        let totalCostUsd = 0;
        let totalTokens = 0;
        let createdAt = '';
        const tasks: { role: string; status: string; description?: string; error?: string; output?: string; startedAt?: string }[] = [];

        if (existsSync(statePath)) {
          try {
            const stateData = JSON.parse(readFileSync(statePath, 'utf-8'));
            phase = stateData.phase || 'unknown';
            currentIteration = stateData.currentIteration || 0;
            totalIterations = Array.isArray(stateData.iterations) ? stateData.iterations.length : 0;
            createdAt = stateData.createdAt || '';
            // Handle both flat totalCostUsd and nested totalCost.totalCostUsd
            const tc = stateData.totalCost;
            if (tc && typeof tc === 'object') {
              totalCostUsd = tc.totalCostUsd || 0;
              totalTokens = (tc.inputTokens || 0) + (tc.outputTokens || 0);
            } else {
              totalCostUsd = stateData.totalCostUsd || 0;
            }

            // Extract tasks from latest iteration (with details)
            if (Array.isArray(stateData.iterations) && stateData.iterations.length > 0) {
              const latestIter = stateData.iterations[stateData.iterations.length - 1];
              if (Array.isArray(latestIter.tasks)) {
                for (const task of latestIter.tasks) {
                  tasks.push({
                    id: task.id,
                    role: task.role || 'unknown',
                    status: task.status || 'unknown',
                    description: task.description,
                    error: task.error,
                    output: task.output?.substring(0, 500),
                    startedAt: task.startedAt,
                  });
                }
              }
            }
            // No longer inject forced roles — engine already adds them to tasks
          } catch { /* ignore parse errors */ }
        }

        // Read project config for title and settings
        let title = id;
        let maxConcurrent = 5;
        for (const cfgName of ['forge-project.json', 'deepforge.json']) {
          const cfgPath = join(projectDir, cfgName);
          if (existsSync(cfgPath)) {
            try {
              const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
              if (cfg.title) title = cfg.title;
              if (cfg.maxConcurrent) maxConcurrent = cfg.maxConcurrent;
            } catch { /* ignore */ }
            break;
          }
        }

        // Check if running
        const pidPath = join(projectDir, 'forge.pid');
        let isRunning = false;
        if (existsSync(pidPath)) {
          try {
            const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
            if (pid > 0) {
              process.kill(pid, 0); // throws if process doesn't exist
              isRunning = true;
            }
          } catch { /* not running */ }
        }

        projects.push({
          id,
          title,
          phase,
          currentIteration,
          totalIterations,
          totalCostUsd,
          totalTokens,
          createdAt,
          isRunning,
          source: baseDir.includes('.deepforge') ? 'deepforge' : 'forge',
          maxConcurrent,
          tasks,
        });
      }
    }

    return projects;
  });

  ipcMain.handle('deepforge:status', async (_event, projectId: string) => {
    for (const baseDir of DEEPFORGE_DIRS) {
      const statePath = join(baseDir, projectId, 'forge-state.json');
      if (existsSync(statePath)) {
        try {
          return JSON.parse(readFileSync(statePath, 'utf-8'));
        } catch (err) {
          throw new Error(`Failed to parse forge-state.json: ${(err as Error).message}`);
        }
      }
    }
    throw new Error(`DeepForge project not found: ${projectId}`);
  });

  ipcMain.handle('deepforge:logs', async (_event, projectId: string, lineCount?: number) => {
    const maxLines = lineCount || 50;
    for (const baseDir of DEEPFORGE_DIRS) {
      const logPath = join(baseDir, projectId, 'forge.log');
      if (existsSync(logPath)) {
        try {
          const content = readFileSync(logPath, 'utf-8');
          const allLines = content.split('\n');
          return allLines.slice(-maxLines);
        } catch (err) {
          throw new Error(`Failed to read forge.log: ${(err as Error).message}`);
        }
      }
    }
    return [];
  });

  ipcMain.handle('deepforge:task-log', async (_event, projectId: string, taskId: string) => {
    for (const baseDir of DEEPFORGE_DIRS) {
      const logPath = join(baseDir, projectId, 'task-logs', `${taskId}.log`);
      if (existsSync(logPath)) {
        try {
          const content = readFileSync(logPath, 'utf-8');
          return content.split('\n').slice(-100);
        } catch { return []; }
      }
    }
    return [];
  });

  ipcMain.handle('deepforge:attach', async (_event, projectId: string, taskId: string) => {
    const projectDir = findProjectDir(projectId);
    if (!projectDir) throw new Error(`Project not found: ${projectId}`);

    const logPath = join(projectDir, 'task-logs', `${taskId}.log`);
    const { execSync } = require('node:child_process');

    // Open Terminal.app with tail -f on the task log
    const script = `
      tell application "Terminal"
        activate
        do script "echo '🔍 DeepForge — ${taskId}' && tail -f '${logPath}'"
      end tell
    `;
    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
    } catch {
      // Fallback: just open the log file
      shell.openPath(logPath);
    }
  });

  ipcMain.handle('deepforge:reveal', async (_event, projectId: string) => {
    for (const baseDir of DEEPFORGE_DIRS) {
      const dir = join(baseDir, projectId);
      if (existsSync(dir)) {
        // Use showItemInFolder with a known child file for reliable Finder opening
        const stateFile = join(dir, 'forge-state.json');
        if (existsSync(stateFile)) {
          shell.showItemInFolder(stateFile);
        } else {
          // Fallback: show the directory itself in its parent
          shell.showItemInFolder(dir);
        }
        return;
      }
    }
  });

  // Helper: find project directory across all DEEPFORGE_DIRS
  function findProjectDir(projectId: string): string | null {
    for (const baseDir of DEEPFORGE_DIRS) {
      const dir = join(baseDir, projectId);
      if (existsSync(dir)) return dir;
    }
    return null;
  }

  // Helper: kill process and all children by PID from forge.pid
  function killProjectProcess(projectDir: string): boolean {
    const pidPath = join(projectDir, 'forge.pid');
    if (!existsSync(pidPath)) return false;
    try {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      if (pid > 0) {
        // Kill entire process tree (main process + all CC child processes)
        try {
          const { execSync } = require('node:child_process');
          // pkill -P kills all children first
          execSync(`pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null`, { timeout: 5000 });
        } catch {
          // Fallback: just kill the main process
          try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
        }
        // Clean up pid file
        try { unlinkSync(pidPath); } catch { /* ignore */ }
        return true;
      }
    } catch { /* process not running */ }
    return false;
  }

  ipcMain.handle('deepforge:stop', async (_event, projectId: string) => {
    const projectDir = findProjectDir(projectId);
    if (!projectDir) throw new Error(`DeepForge project not found: ${projectId}`);

    // Kill the process
    killProjectProcess(projectDir);

    // Update forge-state.json phase to "paused"
    const statePath = join(projectDir, 'forge-state.json');
    if (existsSync(statePath)) {
      try {
        const stateData = JSON.parse(readFileSync(statePath, 'utf-8'));
        stateData.phase = 'paused';
        writeFileSync(statePath, JSON.stringify(stateData, null, 2), 'utf-8');
      } catch (err) {
        throw new Error(`Failed to update forge-state.json: ${(err as Error).message}`);
      }
    }
  });

  // Find deepforge entry point (same pattern as findBridgeEntry)
  function findDeepforgeEntry(): string {
    const { app: elApp } = require('electron');
    if (elApp.isPackaged) {
      for (const name of ['index.mjs', 'index.js']) {
        const p = join(process.resourcesPath, 'deepforge', 'dist', name);
        if (existsSync(p)) return p;
      }
    }
    // Dev: relative to __dirname (packages/manager/dist/main/ → packages/deepforge/dist/)
    const fromDirname = join(__dirname, '../../deepforge/dist/index.js');
    if (existsSync(fromDirname)) return fromDirname;
    // Dev: from cwd (monorepo root)
    const fromCwd = join(process.cwd(), 'packages/deepforge/dist/index.js');
    if (existsSync(fromCwd)) return fromCwd;
    try { return require.resolve('@mlb/deepforge'); } catch {}
    throw new Error('deepforge entry point not found. Run pnpm build first.');
  }

  ipcMain.handle('deepforge:resume', async (_event, projectId: string) => {
    const projectDir = findProjectDir(projectId);
    if (!projectDir) throw new Error(`DeepForge project not found: ${projectId}`);

    const deepforgeEntry = findDeepforgeEntry();

    // Read project config to get the config file
    let configFile: string | null = null;
    for (const cfgName of ['forge-project.json', 'deepforge.json']) {
      const cfgPath = join(projectDir, cfgName);
      if (existsSync(cfgPath)) { configFile = cfgPath; break; }
    }

    // Start deepforge in background using Electron as Node
    const cfgArg = configFile || join(projectDir, 'deepforge.json');
    const logPath = join(projectDir, 'forge.log');
    const logFd = openSync(logPath, 'a');
    const { spawn: spawnChild } = require('node:child_process');
    const child = spawnChild(process.execPath, [deepforgeEntry, 'start', '--config', cfgArg], {
      cwd: projectDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    try { closeSync(logFd); } catch {}

    // Write PID file
    if (child.pid) {
      writeFileSync(join(projectDir, 'forge.pid'), String(child.pid));
    }

    // Update state to running
    const statePath = join(projectDir, 'forge-state.json');
    if (existsSync(statePath)) {
      try {
        const stateData = JSON.parse(readFileSync(statePath, 'utf-8'));
        stateData.phase = 'planning';
        writeFileSync(statePath, JSON.stringify(stateData, null, 2), 'utf-8');
      } catch { /* ignore */ }
    }
  });

  ipcMain.handle('deepforge:delete', async (_event, projectId: string) => {
    // Delete from ALL possible locations (prevent ghost reappearance)
    let found = false;
    for (const baseDir of DEEPFORGE_DIRS) {
      const dir = join(baseDir, projectId);
      if (existsSync(dir)) {
        // Kill process first
        killProjectProcess(dir);
        // Delete directory
        try {
          rmSync(dir, { recursive: true, force: true });
          found = true;
        } catch (err) {
          throw new Error(`Failed to delete ${dir}: ${(err as Error).message}`);
        }
      }
    }
    if (!found) throw new Error(`DeepForge project not found: ${projectId}`);
  });

  ipcMain.handle('deepforge:inject', async (_event, projectId: string, message: string) => {
    const projectDir = findProjectDir(projectId);
    if (!projectDir) throw new Error(`DeepForge project not found: ${projectId}`);
    const { appendFileSync } = require('node:fs');
    const fbPath = join(projectDir, 'feedback.md');
    appendFileSync(fbPath, `\n\n# 用户反馈 — ${new Date().toISOString()}\n${message}\n`);
  });

  ipcMain.handle('deepforge:set-config', async (_event, projectId: string, key: string, value: any) => {
    const projectDir = findProjectDir(projectId);
    if (!projectDir) throw new Error(`DeepForge project not found: ${projectId}`);

    // Update deepforge.json config
    for (const cfgName of ['deepforge.json', 'forge-project.json']) {
      const cfgPath = join(projectDir, cfgName);
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
        cfg[key] = value;
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
        return;
      }
    }
    throw new Error('Config file not found');
  });

  ipcMain.handle('deepforge:package', async (event, projectId: string) => {
    const projectDir = findProjectDir(projectId);
    if (!projectDir) throw new Error(`DeepForge project not found: ${projectId}`);

    const sender = event.sender;
    const send = (step: string) => {
      try { sender.send('deepforge:package-progress', { projectId, step }); } catch {}
    };

    // Find claude binary
    const claudePaths = [
      join(homedir(), '.local', 'bin', 'claude'),
    ];
    let claudeBin: string | null = null;
    for (const p of claudePaths) {
      if (existsSync(p)) { claudeBin = p; break; }
    }

    if (!claudeBin) throw new Error('Claude CLI not found');

    send('正在启动整理员 Agent...');

    const templatePath = join(homedir(), '.deepforge', 'report-template.html');
    const hasTemplate = existsSync(templatePath);

    const prompt = `你是产出整理员。当前工作目录已经是项目目录。请：
1. 读取当前目录结构，区分产物（artifacts/、reports/ 下的文件）和过程文件（forge-state.json、task-logs/、iterations/、notifications/、feedback.md 等）
2. 将产物复制到 deliverables/ 目录，按类别整理（不要遗漏任何有价值的产出）
3. 在 deliverables/ 生成 report.html：
   ${hasTemplate ? `- 读取 ${templatePath} 作为设计模板，使用其中的 CSS 变量、颜色体系、组件样式` : '- 使用简约专业的暗色风格'}
   - 中文内容
   - 包含：项目概述、产出清单（文件名+相对路径+说明）、研究/工作总结、迭代历程
   - 所有产出文件列表要有相对路径方便查找
   - 风格要求：干净克制，无花哨渐变，无 AI 风格的彩色装饰
4. 打包：cd deliverables && zip -r "../${projectId}-deliverables.zip" .
5. 不要删除任何原始文件
6. 每完成一步，输出一行进度，格式：[进度] 步骤描述`;

    // Spawn CC with streaming output
    const { spawn: sp } = require('node:child_process');
    const child = sp(claudeBin, [
      '--print', prompt,
      '--permission-mode', 'bypassPermissions',
    ], {
      cwd: projectDir,
      timeout: 10 * 60 * 1000,
      env: { ...process.env, HOME: homedir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      // Extract progress lines
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) send(trimmed.slice(0, 200));
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) send(`⚠️ ${text.slice(0, 200)}`);
    });

    await new Promise<void>((resolve, reject) => {
      child.on('close', (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`CC exited with code ${code}`));
      });
      child.on('error', reject);
    });

    send('✅ 整理完成');

    const zipPath = join(projectDir, `${projectId}-deliverables.zip`);
    const deliverDir = join(projectDir, 'deliverables');
    const resultPath = existsSync(zipPath) ? zipPath : existsSync(deliverDir) ? deliverDir : projectDir;

    // Show in Finder
    shell.showItemInFolder(resultPath);

    send(`📁 产出目录: ${resultPath}`);

    return { path: resultPath };
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
