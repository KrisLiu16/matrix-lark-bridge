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

const TOTAL_STEPS = 5;

/** MLB-dedicated install path — isolated from user's global CC */
const MLB_BIN_DIR = join(homedir(), '.mlb', 'bin');
const MLB_CLAUDE_PATH = join(MLB_BIN_DIR, 'claude');

export class ClaudeSetup {
  private _installing = false;

  /**
   * Check if MLB-dedicated CC binary exists.
   * Config is injected per-process via env vars — no global settings check needed.
   */
  check(): ClaudeSetupStatus {
    if (!existsSync(MLB_CLAUDE_PATH)) {
      return { installed: false };
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
          const ids = ['download', 'install_path', 'verify'];
          emit(i, ids[i - 3] || `step${i}`, 'done', { detail: 'skipped' });
        }
        return existing;
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

      // Step 5: Verify installation + first-run initialization
      emit(5, 'verify', 'running', { detail: 'verifying...' });
      const result = this.check();
      if (!result.installed) throw new Error('claude not found after installation');

      // Run `claude -p "hello"` to complete first-run setup (accept ToS, etc.)
      // -p mode skips workspace trust dialog and handles first-run non-interactively
      emit(5, 'verify', 'running', { detail: 'completing first-run setup...' });
      try {
        await this.runShellWithProgress(
          `"${result.path}" -p "hello" 2>&1 || true`,
          0, // no timeout
          (line) => emit(5, 'verify', 'running', { detail: line.slice(0, 80) }),
        );
      } catch {
        // First-run may fail if API is unreachable — that's OK, binary is still installed
        console.warn('[claude-setup] first-run test failed, continuing anyway');
      }

      emit(5, 'verify', 'done', {
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

    // Only remove MLB-dedicated binary — never touch user's global CC or ~/.claude/
    if (existsSync(MLB_CLAUDE_PATH)) {
      try { rmSync(MLB_CLAUDE_PATH, { force: true }); removed.push(MLB_CLAUDE_PATH); } catch {}
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



  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
