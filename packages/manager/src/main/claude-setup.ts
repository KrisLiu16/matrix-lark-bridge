import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

const TOTAL_STEPS = 4;

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
      const shell = process.env.SHELL || '/bin/sh';
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
          const ids = ['download', 'verify'];
          emit(i, ids[i - 3] || `step${i}`, 'done', { detail: 'skipped' });
        }
        return existing;
      } else {
        emit(2, 'check', 'done', { detail: 'not found' });

        // Step 3: Download CC binary directly to ~/.mlb/bin/claude
        // Uses the same GCS source as the official install script, but installs to our own path
        emit(3, 'download', 'running', { detail: 'fetching latest version...' });
        if (!existsSync(MLB_BIN_DIR)) mkdirSync(MLB_BIN_DIR, { recursive: true });

        const dlOs = platform() === 'darwin' ? 'darwin' : 'linux';
        const dlCpu = arch() === 'arm64' ? 'arm64' : 'x64';
        const plat = `${dlOs}-${dlCpu}`;
        const downloadScript = [
          'set -e',
          'GCS="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases"',
          'VERSION=$(curl -fsSL "$GCS/latest")',
          'echo "latest version: $VERSION"',
          `echo "downloading claude $VERSION for ${plat}..."`,
          `curl -fSL "$GCS/$VERSION/${plat}/claude" -o "${MLB_CLAUDE_PATH}"`,
          `chmod +x "${MLB_CLAUDE_PATH}"`,
          `echo "installed to ${MLB_CLAUDE_PATH}"`,
        ].join('\n');

        await this.runShellWithProgress(
          downloadScript,
          0,
          (line) => emit(3, 'download', 'running', { detail: line.slice(0, 80) }),
        );
        emit(3, 'download', 'done', {
          config: [
            { key: 'Source', value: 'Google Cloud Storage (official)' },
            { key: 'Target', value: MLB_CLAUDE_PATH },
          ],
        });
      }

      // Step 4: Verify installation + first-run initialization
      emit(4, 'verify', 'running', { detail: 'verifying...' });
      const result = this.check();
      if (!result.installed) throw new Error('claude not found after installation');

      // Run `claude -p "hello"` to complete first-run setup (accept ToS, etc.)
      // -p mode skips workspace trust dialog and handles first-run non-interactively
      emit(4, 'verify', 'running', { detail: 'completing first-run setup...' });
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

      emit(4, 'verify', 'done', {
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
      const shell = process.env.SHELL || '/bin/sh';
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
