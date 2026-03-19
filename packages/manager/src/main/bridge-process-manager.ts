import { spawn, type ChildProcess } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  openSync,
  closeSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BridgeConfig, BridgeStatus, SessionState } from '@mlb/shared';
import {
  WORKSPACE_ROOT,
  PID_FILE,
  LOG_FILE,
  CONFIG_FILE,
  SESSION_FILE,
  MONITOR_INTERVAL_MS,
} from '@mlb/shared';

export class BridgeProcessManager {
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private logTails = new Map<string, ChildProcess>();

  // --- Bridge discovery and status ---

  /**
   * List all bridges by scanning WORKSPACE_ROOT.
   * Each subdirectory with a config.json is a bridge.
   */
  async listBridges(): Promise<BridgeStatus[]> {
    const statuses: BridgeStatus[] = [];

    if (!existsSync(WORKSPACE_ROOT)) return statuses;

    let entries: string[];
    try {
      entries = readdirSync(WORKSPACE_ROOT);
    } catch {
      return statuses;
    }

    for (const name of entries) {
      const workspace = join(WORKSPACE_ROOT, name);
      try {
        if (!statSync(workspace).isDirectory()) continue;
      } catch {
        continue;
      }

      const configPath = join(workspace, CONFIG_FILE);
      if (!existsSync(configPath)) continue;

      const status = this.checkStatus(name);
      statuses.push(status);
    }

    return statuses;
  }

  /**
   * Check the runtime status of a single bridge.
   */
  checkStatus(name: string): BridgeStatus {
    const workspace = join(WORKSPACE_ROOT, name);
    const pidFilePath = join(workspace, PID_FILE);
    const configPath = join(workspace, CONFIG_FILE);
    const sessionPath = join(workspace, SESSION_FILE);

    let autoStart = false;
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<BridgeConfig>;
      autoStart = cfg.auto_start === true;
    } catch { /* ignore */ }

    const status: BridgeStatus = {
      name,
      workspace,
      state: 'stopped',
      autoStart,
    };

    // Check PID file
    if (existsSync(pidFilePath)) {
      try {
        const pid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0); // signal 0 = liveness check
            status.state = 'running';
            status.pid = pid;

            // Compute uptime from PID file mtime
            const pidStat = statSync(pidFilePath);
            status.uptime = Math.floor((Date.now() - pidStat.mtimeMs) / 1000);
          } catch {
            // PID exists but process is dead
            status.state = 'error';
            // Clean up stale PID file
            try { unlinkSync(pidFilePath); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }

    // Read session info
    if (existsSync(sessionPath)) {
      try {
        const session = JSON.parse(readFileSync(sessionPath, 'utf-8')) as Partial<SessionState>;
        status.sessionId = session.agentSessionId;
        status.lastActivity = session.lastActivity;
      } catch { /* ignore */ }
    }

    return status;
  }

  // --- Start/stop/restart ---

  async startBridge(name: string): Promise<void> {
    const workspace = join(WORKSPACE_ROOT, name);
    const configPath = join(workspace, CONFIG_FILE);

    if (!existsSync(configPath)) {
      throw new Error(`Bridge "${name}" not found: missing ${configPath}`);
    }

    // Check if already running
    const current = this.checkStatus(name);
    if (current.state === 'running') {
      console.log(`[process-manager] bridge "${name}" already running (PID ${current.pid})`);
      return;
    }

    // Ensure workspace directory exists
    if (!existsSync(workspace)) {
      mkdirSync(workspace, { recursive: true });
    }

    const logPath = join(workspace, LOG_FILE);
    const logFd = openSync(logPath, 'a');

    // Find the bridge entry point
    const bridgeEntry = this.findBridgeEntry();

    // Only pass necessary env vars to avoid leaking sensitive environment variables.
    // ELECTRON_RUN_AS_NODE=1 is required for packaged Electron apps to run Node scripts.
    const childEnv: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: '1',
    };
    // Copy necessary env vars
    for (const key of ['PATH', 'HOME', 'SHELL', 'NODE_ENV', 'NODE_PATH']) {
      if (process.env[key]) childEnv[key] = process.env[key]!;
    }
    // Forward LARK_* env vars needed by MCP server
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LARK_') && process.env[key]) {
        childEnv[key] = process.env[key]!;
      }
    }

    const child = spawn(process.execPath, [bridgeEntry, '--workspace', workspace], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv,
    });

    child.unref();

    // Close the log fd in the parent process to prevent fd leak
    try { closeSync(logFd); } catch { /* ignore */ }

    if (child.pid) {
      writeFileSync(join(workspace, PID_FILE), String(child.pid));
      console.log(`[process-manager] started bridge "${name}" (PID ${child.pid})`);
    } else {
      throw new Error(`Failed to start bridge "${name}"`);
    }
  }

  async stopBridge(name: string): Promise<void> {
    const workspace = join(WORKSPACE_ROOT, name);
    const pidFilePath = join(workspace, PID_FILE);

    if (!existsSync(pidFilePath)) {
      console.log(`[process-manager] bridge "${name}" is not running (no PID file)`);
      return;
    }

    const pid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);
    if (isNaN(pid)) {
      unlinkSync(pidFilePath);
      return;
    }

    try {
      process.kill(pid, 0); // Check alive
      process.kill(pid, 'SIGTERM');
      console.log(`[process-manager] sent SIGTERM to bridge "${name}" (PID ${pid})`);

      // Wait up to 5s for graceful shutdown, then SIGKILL
      await new Promise<void>((resolve) => {
        let checks = 0;
        const timer = setInterval(() => {
          checks++;
          try {
            process.kill(pid, 0);
            if (checks >= 10) {
              clearInterval(timer);
              try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
              resolve();
            }
          } catch {
            // Process exited
            clearInterval(timer);
            resolve();
          }
        }, 500);
      });
    } catch {
      console.log(`[process-manager] bridge "${name}" process already dead`);
    }

    // Clean up PID file
    try { unlinkSync(pidFilePath); } catch { /* ignore */ }
  }

  async restartBridge(name: string): Promise<void> {
    await this.stopBridge(name);
    // Brief pause for port release etc.
    await new Promise((r) => setTimeout(r, 500));
    await this.startBridge(name);
  }

  // --- Create/delete ---

  async createBridge(config: BridgeConfig): Promise<void> {
    const workspace = join(WORKSPACE_ROOT, config.name);

    if (existsSync(workspace)) {
      throw new Error(`Bridge "${config.name}" already exists`);
    }

    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, CONFIG_FILE), JSON.stringify(config, null, 2));
    console.log(`[process-manager] created bridge "${config.name}" at ${workspace}`);
  }

  async deleteBridge(name: string): Promise<void> {
    // Stop first if running
    await this.stopBridge(name);

    const workspace = join(WORKSPACE_ROOT, name);
    if (existsSync(workspace)) {
      const { rmSync } = await import('node:fs');
      rmSync(workspace, { recursive: true, force: true });
      console.log(`[process-manager] deleted bridge "${name}"`);
    }
  }

  // --- Logs ---

  async getLogs(name: string, lines = 5000): Promise<string[]> {
    const logPath = join(WORKSPACE_ROOT, name, LOG_FILE);
    if (!existsSync(logPath)) return [];

    return new Promise<string[]>((resolve) => {
      const child = spawn('tail', ['-n', String(lines), logPath]);
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on('close', () => {
        resolve(output.split('\n').filter(Boolean));
      });
      child.on('error', () => resolve([]));
    });
  }

  /**
   * Start tailing a bridge's log file.
   * Returns a cleanup function to stop tailing.
   */
  tailLogs(name: string, onLine: (line: string) => void): () => void {
    // Stop existing tail for this bridge
    this.stopLogTail(name);

    const logPath = join(WORKSPACE_ROOT, name, LOG_FILE);
    if (!existsSync(logPath)) {
      return () => {};
    }

    const child = spawn('tail', ['-f', '-n', '50', logPath]);
    this.logTails.set(name, child);

    child.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        onLine(line);
      }
    });

    child.on('close', () => {
      this.logTails.delete(name);
    });

    return () => this.stopLogTail(name);
  }

  private stopLogTail(name: string): void {
    const existing = this.logTails.get(name);
    if (existing) {
      existing.kill('SIGTERM');
      this.logTails.delete(name);
    }
  }

  // --- Session state ---

  getSession(name: string): SessionState | null {
    const sessionPath = join(WORKSPACE_ROOT, name, SESSION_FILE);
    if (!existsSync(sessionPath)) return null;

    try {
      return JSON.parse(readFileSync(sessionPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  // --- Monitoring ---

  startMonitoring(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      // Periodic health check: scan all bridges to detect crashed processes
      // and clean up stale PID files. checkStatus() already handles stale PID cleanup.
      try {
        this.listBridges().catch((err) => {
          console.warn('[process-manager] monitoring scan failed:', (err as Error).message);
        });
      } catch (err) {
        console.warn('[process-manager] monitoring scan failed:', (err as Error).message);
      }
    }, MONITOR_INTERVAL_MS);
  }

  stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    // Stop all log tails
    for (const [name] of this.logTails) {
      this.stopLogTail(name);
    }
  }

  // --- Internal ---

  /**
   * Find the bridge package entry point.
   * In development: use the bridge package's src/index.ts via tsx
   * After packaging: use the bundled bridge in resources
   */
  private findBridgeEntry(): string {
    // Check if running in packaged Electron app
    const { app } = require('electron');
    if (app.isPackaged) {
      // Packaged: single-file ESM bundle (no node_modules needed)
      for (const name of ['index.mjs', 'index.js']) {
        const p = join(process.resourcesPath, 'bridge', 'dist', name);
        if (existsSync(p)) return p;
      }
    }

    // Development: try multiple strategies to find bridge/dist/index.js

    // 1. Relative to __dirname (packages/manager/dist/main/ → packages/bridge/dist/)
    const fromDirname = join(__dirname, '../../bridge/dist/index.js');
    if (existsSync(fromDirname)) return fromDirname;

    // 2. Relative to app path (electron-vite dev may set app path to manager root)
    const fromAppPath = join(app.getAppPath(), '../bridge/dist/index.js');
    if (existsSync(fromAppPath)) return fromAppPath;

    // 3. Relative to cwd (monorepo root)
    const fromCwd = join(process.cwd(), 'packages/bridge/dist/index.js');
    if (existsSync(fromCwd)) return fromCwd;

    // 4. Fallback: require.resolve
    try {
      return require.resolve('@mlb/bridge');
    } catch { /* ignore */ }

    throw new Error(
      'Cannot find bridge entry point. ' +
      'Run `pnpm -F @mlb/bridge build` first, or ensure bridge is bundled in resources. ' +
      `Searched: ${fromDirname}, ${fromAppPath}, ${fromCwd}`,
    );
  }
}
