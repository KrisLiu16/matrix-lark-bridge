/**
 * Forge Runner — Execute a single agent task using ClaudeSession.
 * Thin wrapper: spawn CC → send prompt → collect result → close.
 */
import { ClaudeSession } from '../claude-session.js';
import type { McpServerConfig } from '../types.js';

export interface ForgeRunOpts {
  workDir: string;
  model: string;
  effort: string;
  systemPrompt: string;
  userPrompt: string;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
  timeoutMs?: number;
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

  const session = new ClaudeSession({
    workDir: opts.workDir,
    mode: 'bypassPermissions',
    model: opts.model,
    effort: opts.effort as any,
    systemPrompt: opts.systemPrompt,
    mcpServers: opts.mcpServers,
    env: opts.env,
  }, { onEvent: () => {} });

  await session.start();

  return new Promise<ForgeRunResult>((resolve) => {
    let output = '';
    let costUsd = 0;
    let done = false;

    const finish = (success: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      session.close().catch(() => {});
      resolve({ output, costUsd, durationMs: Date.now() - start, success, error });
    };

    const timer = setTimeout(() => {
      finish(false, `Timeout after ${(opts.timeoutMs || 1800000) / 1000}s`);
    }, opts.timeoutMs || 1800000);

    session.setCallbacks({
      onEvent(evt) {
        switch (evt.type) {
          case 'text':
            output += evt.content ?? '';
            break;
          case 'result':
            if (evt.totalCostUsd) costUsd = evt.totalCostUsd;
            finish(!evt.isError, evt.isError ? output : undefined);
            break;
          case 'error':
            finish(false, evt.content);
            break;
        }
      }
    });

    session.send(opts.userPrompt);
  });
}
