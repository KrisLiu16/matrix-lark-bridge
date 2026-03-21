/**
 * DeepForge — Agent Runner
 *
 * Wraps a Claude Code child process with stream-json protocol.
 * Each task = one fresh CC session (stateless worker pattern).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunResult, CostSummary } from '../types.js';
import { zeroCost } from '../types.js';

export interface RunAgentOpts {
  claudePath: string;
  workDir: string;
  model: string;
  effort?: string;
  systemPrompt: string;
  userPrompt: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Run a single Claude Code session with a prompt and return the result.
 * The CC process is created, used, and destroyed — fully stateless.
 */
export async function runAgent(opts: RunAgentOpts): Promise<AgentRunResult> {
  const startTime = Date.now();

  const args = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--model', opts.model,
  ];

  if (opts.effort) {
    args.push('--effort', opts.effort);
  }

  if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt);
  }

  const claudePath = opts.claudePath;
  const shell = process.env.SHELL || '/bin/sh';
  const cmdLine = `"${claudePath}" ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;

  return new Promise<AgentRunResult>((resolve) => {
    let output = '';
    let cost: CostSummary = zeroCost();
    let sessionId: string | undefined;
    let done = false;
    let proc: ChildProcess | null = null;

    const finish = (success: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc?.stdin?.end();
        proc?.kill('SIGTERM');
      } catch { /* ignore */ }
      resolve({
        output,
        cost,
        sessionId,
        success,
        error,
        durationMs: Date.now() - startTime,
      });
    };

    // Timeout protection
    const timer = setTimeout(() => {
      finish(false, `Timeout after ${opts.timeoutMs || 30 * 60_000}ms`);
    }, opts.timeoutMs || 30 * 60_000);

    try {
      proc = spawn(shell, ['-l', '-c', cmdLine], {
        cwd: opts.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(opts.env || {}),
        },
      });
    } catch (err) {
      finish(false, `Failed to spawn CC: ${(err as Error).message}`);
      return;
    }

    proc.on('error', (err) => {
      finish(false, `Process error: ${err.message}`);
    });

    proc.on('exit', (code) => {
      if (!done) {
        finish(code === 0, code !== 0 ? `Process exited with code ${code}` : undefined);
      }
    });

    // Parse stderr for debug info
    if (proc.stderr) {
      const stderrRl = createInterface({ input: proc.stderr });
      stderrRl.on('line', (line) => {
        // Silently consume stderr (CC debug logs)
      });
    }

    // Parse stdout for stream-json events
    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let data: any;
        try {
          data = JSON.parse(line);
        } catch {
          return;
        }

        const type = data.type as string;

        switch (type) {
          case 'system': {
            if (data.session_id) {
              sessionId = data.session_id;
            }
            break;
          }

          case 'assistant': {
            const msg = data.message;
            if (msg?.content && Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === 'text') {
                  output += block.text;
                }
              }
            }
            break;
          }

          case 'result': {
            const text = data.result || '';
            if (typeof text === 'string' && text) {
              // Result text replaces accumulated output if present
              if (text.length > output.length) {
                output = text;
              }
            }

            // Extract cost
            const usage = data.usage;
            if (usage) {
              cost = {
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
                cacheReadTokens: usage.cache_read_input_tokens || 0,
                cacheCreateTokens: usage.cache_creation_input_tokens || 0,
                totalCostUsd: 0,
              };
            }
            if (typeof data.total_cost_usd === 'number') {
              cost.totalCostUsd = data.total_cost_usd;
            }

            sessionId = data.session_id || sessionId;

            const isError = data.is_error === true || data.subtype === 'error_during_execution';
            finish(!isError, isError ? output : undefined);
            break;
          }

          case 'error': {
            finish(false, data.content || 'Unknown error');
            break;
          }

          // Auto-approve all permission requests (bypassPermissions mode shouldn't need this,
          // but just in case)
          case 'control_request': {
            const reqId = data.request_id;
            const input = data.request?.input || {};
            if (proc?.stdin) {
              const response = JSON.stringify({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: reqId,
                  response: { behavior: 'allow', updatedInput: input },
                },
              });
              proc.stdin.write(response + '\n');
            }
            break;
          }
        }
      });
    }

    // Send the user prompt
    if (proc?.stdin) {
      const message = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: opts.userPrompt },
      });
      proc.stdin.write(message + '\n');
    }
  });
}
