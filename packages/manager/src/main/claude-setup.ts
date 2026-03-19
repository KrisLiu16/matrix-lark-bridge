import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';

export interface ClaudeSetupStatus {
  installed: boolean;
  version?: string;
  path?: string;
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

const CLAUDE_PATHS = [
  join(homedir(), '.local/bin/claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  '/opt/homebrew/Caskroom/claude-code/current/claude',
];

const ENV_CONFIG = {
  ANTHROPIC_AUTH_TOKEN: { value: 'none', masked: false },
  ANTHROPIC_BASE_URL: { value: 'https://talkie-ali-virginia-prod-internal.xaminim.com/llm/debug/claude', masked: false },
  ANTHROPIC_CUSTOM_HEADERS: { value: 'X-Biz-Id: claude-code', masked: false },
};

export class ClaudeSetup {
  private _installing = false;

  check(): ClaudeSetupStatus {
    try {
      // Use login shell to get full PATH (GUI apps don't load shell profile)
      const shell = process.env.SHELL || '/bin/zsh';
      const p = execSync(`${shell} -l -c "which claude"`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (p) return { installed: true, version: this.getVersion(p), path: p };
    } catch { /* not in PATH */ }

    for (const p of CLAUDE_PATHS) {
      if (existsSync(p)) return { installed: true, version: this.getVersion(p), path: p };
    }

    return { installed: false };
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
        emit(2, 'check', 'done', {
          detail: `v${existing.version}`,
          config: [
            { key: 'Path', value: existing.path! },
            { key: 'Version', value: existing.version || 'unknown' },
          ],
        });
        // Skip remaining steps
        for (let i = 3; i <= TOTAL_STEPS; i++) {
          const ids = ['download', 'install_path', 'config_dir', 'config_endpoint', 'config_env', 'verify'];
          emit(i, ids[i - 3] || `step${i}`, 'done', { detail: 'skipped' });
        }
        return existing;
      }
      emit(2, 'check', 'done', { detail: 'not found' });

      // Step 3: Download & install (with streaming progress)
      emit(3, 'download', 'running', { detail: 'downloading install script...' });
      const localBin = join(homedir(), '.local/bin');
      await this.runShellWithProgress(
        'curl -fsSL https://claude.ai/install.sh | bash',
        120_000,
        (line) => emit(3, 'download', 'running', { detail: line.slice(0, 80) }),
      );
      emit(3, 'download', 'done', {
        config: [
          { key: 'Source', value: 'https://claude.ai/install.sh' },
          { key: 'Target', value: join(localBin, 'claude') },
        ],
      });

      // Step 4: Configure PATH
      emit(4, 'install_path', 'running');
      const profileInfo = this.configurePath();
      emit(4, 'install_path', 'done', {
        config: [
          { key: 'Profile', value: profileInfo.profile },
          { key: 'PATH', value: `$HOME/.local/bin:$PATH` },
          { key: 'Status', value: profileInfo.alreadySet ? 'already configured' : 'added' },
        ],
      });

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
      await this.sleep(300); // brief pause for visual effect
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

      // Step 8: Verify installation
      emit(8, 'verify', 'running');
      if (!process.env.PATH?.includes(localBin)) {
        process.env.PATH = `${localBin}:${process.env.PATH}`;
      }
      const result = this.check();
      if (!result.installed) throw new Error('claude not found after installation');
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
      const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout after ${timeout}ms`)); }, timeout);

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
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`exit code ${code}: ${stderr.slice(-200)}`));
        else resolve(stdout);
      });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  private configurePath(): { profile: string; alreadySet: boolean } {
    const localBin = join(homedir(), '.local/bin');
    const pathLine = `export PATH="$HOME/.local/bin:$PATH"`;
    const shell = process.env.SHELL || '/bin/zsh';
    const profileName = shell.includes('zsh') ? '.zprofile' : '.bash_profile';
    const profilePath = join(homedir(), profileName);

    let alreadySet = false;
    try {
      const content = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '';
      if (content.includes('.local/bin')) {
        alreadySet = true;
      } else {
        writeFileSync(profilePath, content + (content.endsWith('\n') ? '' : '\n') + pathLine + '\n');
      }
    } catch { /* ignore */ }

    if (!process.env.PATH?.includes(localBin)) {
      process.env.PATH = `${localBin}:${process.env.PATH}`;
    }

    return { profile: profilePath, alreadySet };
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
