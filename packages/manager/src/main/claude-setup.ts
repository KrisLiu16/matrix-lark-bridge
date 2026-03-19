import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';

export interface ClaudeSetupStatus {
  installed: boolean;
  version?: string;
  path?: string;
  missing?: 'settings' | 'env_config' | 'settings_parse'; // what's missing if installed=false but binary exists
}

export interface InstallStepProgress {
  step: number;
  totalSteps: number;
  status: 'running' | 'done' | 'error' | 'pending';
  id: string;        // unique step id
  label: string;     // i18n key
  detail?: string;   // short detail text
  config?: {         // config key-value pairs to display
    key: string;
    value: string;
    masked?: boolean; // show as ••••
  }[];
  error?: string;
}

const TOTAL_STEPS = 8;

/** MLB-dedicated install path — isolated from user's global CC */
const MLB_BIN_DIR = join(homedir(), '.mlb', 'bin');
const MLB_CLAUDE_PATH = join(MLB_BIN_DIR, 'claude');

const ENV_CONFIG = {
  ANTHROPIC_AUTH_TOKEN: { value: 'none', masked: false },
  ANTHROPIC_BASE_URL: { value: 'https://talkie-ali-virginia-prod-internal.xaminim.com/llm/debug/claude', masked: false },
  ANTHROPIC_CUSTOM_HEADERS: { value: 'X-Biz-Id: claude-code', masked: false },
};

export class ClaudeSetup {
  private _installing = false;

  /**
   * Comprehensive check: binary exists + settings configured + env vars set.
   * Returns installed=false if any critical piece is missing — install flow will fix it.
   */
  check(): ClaudeSetupStatus {
    // 1. Check MLB-dedicated binary
    if (!existsSync(MLB_CLAUDE_PATH)) {
      return { installed: false };
    }

    // 2. Check settings.json exists and has env config
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    if (!existsSync(settingsPath)) {
      return { installed: false, path: MLB_CLAUDE_PATH, missing: 'settings' };
    }

    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const env = settings.env || {};
      if (!env.ANTHROPIC_BASE_URL) {
        return { installed: false, path: MLB_CLAUDE_PATH, missing: 'env_config' };
      }
    } catch {
      return { installed: false, path: MLB_CLAUDE_PATH, missing: 'settings_parse' };
    }

    return { installed: true, version: this.getVersion(MLB_CLAUDE_PATH), path: MLB_CLAUDE_PATH };
  }

  async install(onProgress: (progress: InstallStepProgress) => void): Promise<ClaudeSetupStatus> {
    if (this._installing) throw new Error('Installation already in progress');
    this._installing = true;

    const emit = (step: number, id: string, status: InstallStepProgress['status'], extra?: Partial<InstallStepProgress>) => {
      onProgress({ step, totalSteps: TOTAL_STEPS, status, id, label: `claude.setup.step.${id}`, ...extra });
    };

    try {
      // Step 1: Detect environment
      emit(1, 'env', 'running');
      const os = platform();
      const cpu = arch();
      const shell = process.env.SHELL || '/bin/zsh';
      const shellName = shell.split('/').pop() || 'zsh';
      await this.sleep(500);
      emit(1, 'env', 'done', {
        config: [
          { key: 'OS', value: `${os} ${cpu}` },
          { key: 'Shell', value: shellName },
          { key: 'Home', value: homedir() },
        ],
      });

      // Step 2: Check existing installation
      emit(2, 'check', 'running');
      const existing = this.check();
      if (existing.installed) {
        // Fully installed + configured — skip everything
        emit(2, 'check', 'done', {
          detail: `v${existing.version} — fully configured`,
          config: [
            { key: 'Path', value: existing.path! },
            { key: 'Version', value: existing.version || 'unknown' },
          ],
        });
        for (let i = 3; i <= TOTAL_STEPS; i++) {
          const ids = ['download', 'install_path', 'config_dir', 'config_endpoint', 'config_env', 'verify'];
          emit(i, ids[i - 3] || `step${i}`, 'done', { detail: 'skipped' });
        }
        return existing;
      } else if (existing.path) {
        // Binary found but config missing — skip download
        emit(2, 'check', 'done', {
          detail: `found — config incomplete (${existing.missing})`,
          config: [
            { key: 'Path', value: MLB_CLAUDE_PATH },
            { key: 'Missing', value: existing.missing || 'config' },
          ],
        });
        emit(3, 'download', 'done', { detail: 'skipped — binary exists' });
        emit(4, 'install_path', 'done', { detail: 'skipped' });
      } else {
        emit(2, 'check', 'done', { detail: 'not found' });

        // Step 3: Download via official install script → ~/.local/bin/claude
        emit(3, 'download', 'running', { detail: 'downloading install script...' });
        await this.runShellWithProgress(
          'curl -fsSL https://claude.ai/install.sh | bash',
          0,
          (line) => emit(3, 'download', 'running', { detail: line.slice(0, 80) }),
        );
        emit(3, 'download', 'done', {
          config: [{ key: 'Source', value: 'https://claude.ai/install.sh' }],
        });

        // Step 4: Copy to MLB-dedicated path ~/.mlb/bin/claude
        emit(4, 'install_path', 'running');
        if (!existsSync(MLB_BIN_DIR)) mkdirSync(MLB_BIN_DIR, { recursive: true });
        // Find the downloaded binary (install.sh puts it in ~/.local/bin/)
        const downloadedPath = join(homedir(), '.local/bin/claude');
        if (existsSync(downloadedPath)) {
          copyFileSync(downloadedPath, MLB_CLAUDE_PATH);
          chmodSync(MLB_CLAUDE_PATH, 0o755);
        } else {
          // Fallback: try which claude via login shell
          try {
            const shell = process.env.SHELL || '/bin/zsh';
            const found = execSync(`${shell} -l -c "which claude"`, { encoding: 'utf-8', timeout: 5000 }).trim();
            if (found) { copyFileSync(found, MLB_CLAUDE_PATH); chmodSync(MLB_CLAUDE_PATH, 0o755); }
          } catch {
            throw new Error('Could not find claude binary after install');
          }
        }
        emit(4, 'install_path', 'done', {
          config: [
            { key: 'From', value: downloadedPath },
            { key: 'To', value: MLB_CLAUDE_PATH },
          ],
        });
      }

      // Step 5: Create config directory
      emit(5, 'config_dir', 'running');
      const claudeDir = join(homedir(), '.claude');
      const settingsPath = join(claudeDir, 'settings.json');
      if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
      emit(5, 'config_dir', 'done', {
        config: [
          { key: 'Directory', value: claudeDir },
          { key: 'Settings', value: settingsPath },
        ],
      });

      // Step 6: Configure API endpoint
      emit(6, 'config_endpoint', 'running');
      await this.sleep(300);
      emit(6, 'config_endpoint', 'done', {
        config: [
          { key: 'ANTHROPIC_BASE_URL', value: ENV_CONFIG.ANTHROPIC_BASE_URL.value },
          { key: 'ANTHROPIC_AUTH_TOKEN', value: 'none (proxy auth)' },
        ],
      });

      // Step 7: Configure environment variables
      emit(7, 'config_env', 'running');
      this.configureSettings();
      await this.sleep(300);
      emit(7, 'config_env', 'done', {
        config: [
          { key: 'ANTHROPIC_CUSTOM_HEADERS', value: ENV_CONFIG.ANTHROPIC_CUSTOM_HEADERS.value },
          { key: 'File', value: settingsPath },
          { key: 'Status', value: 'written' },
        ],
      });

      // Step 8: Verify installation + first-run initialization
      emit(8, 'verify', 'running', { detail: 'verifying...' });
      const result = this.check();
      if (!result.installed) throw new Error('claude not found after installation');

      // Run `claude -p "hello"` to complete first-run setup (accept ToS, etc.)
      // -p mode skips workspace trust dialog and handles first-run non-interactively
      emit(8, 'verify', 'running', { detail: 'completing first-run setup...' });
      try {
        await this.runShellWithProgress(
          `"${result.path}" -p "hello" 2>&1 || true`,
          0, // no timeout
          (line) => emit(8, 'verify', 'running', { detail: line.slice(0, 80) }),
        );
      } catch {
        // First-run may fail if API is unreachable — that's OK, binary is still installed
        console.warn('[claude-setup] first-run test failed, continuing anyway');
      }

      emit(8, 'verify', 'done', {
        detail: `v${result.version}`,
        config: [
          { key: 'Binary', value: result.path! },
          { key: 'Version', value: result.version || 'unknown' },
          { key: 'Status', value: 'ready' },
        ],
      });

      return result;
    } catch (err) {
      const msg = (err as Error).message;
      // Mark current step as error
      onProgress({ step: 0, totalSteps: TOTAL_STEPS, status: 'error', id: 'error', label: 'error', error: msg });
      throw err;
    } finally {
      this._installing = false;
    }
  }

  /**
   * Uninstall Claude Code: remove binary + config directory.
   */
  async uninstall(): Promise<{ success: boolean; removed: string[] }> {
    const removed: string[] = [];

    // Only remove MLB-dedicated binary (never touch user's global CC)
    if (existsSync(MLB_CLAUDE_PATH)) {
      try { rmSync(MLB_CLAUDE_PATH, { force: true }); removed.push(MLB_CLAUDE_PATH); } catch {}
    }

    // Remove MLB env config from ~/.claude/settings.json (but keep the file)
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        if (settings.env) {
          delete settings.env.ANTHROPIC_BASE_URL;
          delete settings.env.ANTHROPIC_AUTH_TOKEN;
          delete settings.env.ANTHROPIC_CUSTOM_HEADERS;
          if (Object.keys(settings.env).length === 0) delete settings.env;
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          removed.push('settings.json env config');
        }
      } catch {}
    }

    console.log(`[claude-setup] uninstalled, removed: ${removed.join(', ')}`);
    return { success: true, removed };
  }

  private getVersion(claudePath: string): string | undefined {
    try {
      const out = execSync(`"${claudePath}" --version`, { encoding: 'utf-8', timeout: 10000 }).trim();
      const match = out.match(/(\d+\.\d+\.\d+)/);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  /** Run a command in a login shell with streaming progress callback */
  private runShellWithProgress(cmd: string, timeout: number, onLine?: (line: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const shell = process.env.SHELL || '/bin/zsh';
      // Use login shell (-l) so PATH includes homebrew, .local/bin, etc.
      const child = spawn(shell, ['-l', '-c', cmd], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      const timer = timeout > 0
        ? setTimeout(() => { child.kill(); reject(new Error(`timeout after ${timeout}ms`)); }, timeout)
        : null;

      const processLine = (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        if (onLine) {
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) onLine(trimmed);
          }
        }
      };

      child.stdout?.on('data', processLine);
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        // Also forward stderr lines as progress (install scripts often write to stderr)
        if (onLine) {
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) onLine(trimmed);
          }
        }
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (code !== 0) reject(new Error(`exit code ${code}: ${stderr.slice(-200)}`));
        else resolve(stdout);
      });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  private configureSettings(): void {
    const claudeDir = join(homedir(), '.claude');
    const settingsPath = join(claudeDir, 'settings.json');

    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { /* overwrite */ }
    }

    if (!existing.env) {
      existing.env = Object.fromEntries(
        Object.entries(ENV_CONFIG).map(([k, v]) => [k, v.value]),
      );
    }

    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
