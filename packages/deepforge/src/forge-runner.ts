/**
 * Forge Runner — Spawn a Claude Code process, send prompt, collect result.
 * Standalone — no dependency on bridge's ClaudeSession.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CC_PATH = join(homedir(), '.local', 'bin', 'claude');

export interface ForgeRunOpts {
  workDir: string;
  model: string;
  effort: string;
  systemPrompt: string;
  userPrompt: string;
  claudePath?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  taskId?: string;       // For per-task log file
}

export interface ForgeRunResult {
  output: string;
  costUsd: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export async function forgeRun(opts: ForgeRunOpts): Promise<ForgeRunResult> {
  const start = Date.now();
  const claudePath = opts.claudePath || DEFAULT_CC_PATH;

  // Per-task live log
  let taskLogPath: string | null = null;
  if (opts.taskId) {
    const logsDir = join(opts.workDir, 'task-logs');
    mkdirSync(logsDir, { recursive: true });
    taskLogPath = join(logsDir, `${opts.taskId}.log`);
    appendFileSync(taskLogPath, `[${new Date().toISOString()}] Task started: ${opts.taskId}\n`);
  }
  const taskLog = (msg: string) => {
    if (taskLogPath) appendFileSync(taskLogPath, msg + '\n');
  };

  const args = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--model', opts.model,
  ];

  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);

  const shell = process.env.SHELL || '/bin/sh';
  const cmdLine = `"${claudePath}" ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;

  return new Promise<ForgeRunResult>((resolve) => {
    let output = '';
    let costUsd = 0;
    let done = false;
    let proc: ReturnType<typeof spawn> | null = null;

    const finish = (success: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Kill entire process group (shell + CC child) via negative PID
      const pid = proc?.pid;
      try { proc?.stdin?.end(); } catch { /* ignore */ }
      if (pid) {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
        // SIGKILL fallback: force-kill entire group if still alive after 5s
        setTimeout(() => {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
        }, 5000);
      }
      resolve({ output, costUsd, durationMs: Date.now() - start, success, error });
    };

    const timer = setTimeout(() => {
      finish(false, `Timeout after ${(opts.timeoutMs || 3600000) / 1000}s`);
    }, opts.timeoutMs || 3600000);

    try {
      // Remove ELECTRON_RUN_AS_NODE from child env — CC is not Electron
      const childEnv = { ...process.env, ...(opts.env || {}) };
      delete childEnv.ELECTRON_RUN_AS_NODE;
      proc = spawn(shell, ['-l', '-c', cmdLine], {
        cwd: opts.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
        detached: true, // Create new process group so we can kill the entire tree
      });
    } catch (err) {
      finish(false, `Failed to spawn CC: ${(err as Error).message}`);
      return;
    }

    let stderrTail = '';
    proc.on('error', (err) => finish(false, `Process error: ${err.message}`));
    proc.on('exit', (code) => {
      if (!done) finish(code === 0, code !== 0 ? `CC exited with code ${code}${stderrTail ? ': ' + stderrTail : ''}` : undefined);
    });

    if (proc.stderr) {
      createInterface({ input: proc.stderr }).on('line', (line) => {
        // Keep last 500 chars of stderr for error reporting
        stderrTail = (stderrTail + '\n' + line).slice(-500).trim();
      });
    }

    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let data: any;
        try { data = JSON.parse(line); } catch { return; }

        switch (data.type) {
          case 'assistant': {
            const msg = data.message;
            if (msg?.content && Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === 'text') {
                  output += block.text;
                  taskLog(`[text] ${block.text.substring(0, 200)}`);
                }
                if (block.type === 'tool_use') {
                  taskLog(`[tool] ${block.name}: ${JSON.stringify(block.input).substring(0, 150)}`);
                }
              }
            }
            break;
          }
          case 'result': {
            if (typeof data.total_cost_usd === 'number') costUsd = data.total_cost_usd;
            const isError = data.is_error === true || data.subtype === 'error_during_execution';
            finish(!isError, isError ? output : undefined);
            break;
          }
          case 'error':
            finish(false, data.content);
            break;
          case 'control_request': {
            if (proc?.stdin) {
              proc.stdin.write(JSON.stringify({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: data.request_id,
                  response: { behavior: 'allow', updatedInput: data.request?.input || {} },
                },
              }) + '\n');
            }
            break;
          }
        }
      });
    }

    if (proc?.stdin) {
      proc.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: opts.userPrompt },
      }) + '\n');
    }
  });
}
