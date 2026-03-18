import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentEvent, PermissionResult, ImageAttachment, McpServerConfig } from './types.js';

function findExecutable(name: string): string {
  // Check CLAUDE_PATH env first
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  // Common locations
  const candidates = [
    join(homedir(), '.local', 'bin', name),
    join(homedir(), '.npm-global', 'bin', name),
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Try `which` as fallback
  try {
    return execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
  } catch {
    return name; // Hope it's in PATH
  }
}

// --- Callback interface (replaces EventEmitter) ---

export interface ClaudeSessionCallbacks {
  onEvent(event: AgentEvent): void;
}

export interface ClaudeSessionOptions {
  workDir: string;
  mode: 'default' | 'acceptEdits' | 'bypassPermissions';
  model?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  resumeSessionId?: string;
  mcpServers?: Record<string, McpServerConfig>;
}

export class ClaudeSession {
  private proc: ChildProcess | null = null;
  private sessionId: string | undefined;
  private _alive = false;
  private opts: ClaudeSessionOptions;
  private callbacks: ClaudeSessionCallbacks;
  private pendingInputs = new Map<string, Record<string, unknown>>(); // requestId → original tool input
  private eventBuffer: AgentEvent[] = [];
  private buffering = true;

  constructor(opts: ClaudeSessionOptions, callbacks: ClaudeSessionCallbacks) {
    this.opts = opts;
    this.callbacks = callbacks;
  }

  /**
   * Replace the event callback and flush any buffered events.
   * Call this BEFORE processing events to avoid losing early events (e.g., session_id).
   */
  setCallbacks(cb: ClaudeSessionCallbacks): void {
    this.callbacks = cb;
    // Flush buffered events
    this.buffering = false;
    const buffered = this.eventBuffer;
    this.eventBuffer = [];
    for (const evt of buffered) {
      this.callbacks.onEvent(evt);
    }
  }

  async start(): Promise<void> {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
    ];

    // Only pass --permission-mode for non-default modes
    if (this.opts.mode && this.opts.mode !== 'default') {
      args.push('--permission-mode', this.opts.mode);
    }

    if (this.opts.resumeSessionId) {
      args.push('--resume', this.opts.resumeSessionId);
    }

    if (this.opts.model) {
      args.push('--model', this.opts.model);
    }

    if (this.opts.allowedTools?.length) {
      args.push('--allowedTools', this.opts.allowedTools.join(','));
    }

    if (this.opts.systemPrompt) {
      args.push('--append-system-prompt', this.opts.systemPrompt);
    }

    if (this.opts.mcpServers && Object.keys(this.opts.mcpServers).length > 0) {
      try {
        const mcpConfig = JSON.stringify({ mcpServers: this.opts.mcpServers });
        args.push('--mcp-config', mcpConfig);
      } catch (err) {
        console.warn(`[claudecode] failed to serialize MCP config, skipping --mcp-config:`, (err as Error).message);
      }
    }

    console.log(`[claudecode] spawning: claude ${args.join(' ')}`);

    const claudePath = findExecutable('claude');
    console.log(`[claudecode] using binary: ${claudePath}`);

    this.proc = spawn(claudePath, args, {
      cwd: this.opts.workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this._alive = true;

    this.proc.on('exit', (code) => {
      console.log(`[claudecode] process exited with code ${code}`);
      const wasAlive = this._alive;
      this._alive = false;
      // Only emit error if the process died unexpectedly (not via close())
      if (wasAlive) {
        this.emitEvent({ type: 'error', content: `Process exited with code ${code}` });
      }
    });

    this.proc.on('error', (err) => {
      console.error(`[claudecode] process error:`, err);
      this._alive = false;
      this.emitEvent({ type: 'error', content: err.message });
    });

    // Read stderr for debug logs
    if (this.proc.stderr) {
      const stderrRl = createInterface({ input: this.proc.stderr });
      stderrRl.on('line', (line) => {
        console.log(`[claudecode:stderr] ${line}`);
      });
    }

    // Read stdout for stream-json events
    if (this.proc.stdout) {
      const rl = createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        this.parseLine(line);
      });
    }
  }

  private emitEvent(event: AgentEvent): void {
    if (this.buffering) {
      this.eventBuffer.push(event);
    } else {
      this.callbacks.onEvent(event);
    }
  }

  private parseLine(line: string): void {
    if (!line.trim()) return;

    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      console.warn(`[claudecode] non-JSON line: ${line.substring(0, 200)}`);
      return;
    }

    const type = data.type as string;
    const subtype = data.subtype as string | undefined;

    console.log(`[claudecode:event] type=${type} subtype=${subtype || '-'} keys=${Object.keys(data).join(',')}`);

    switch (type) {
      case 'system': {
        // Extract session ID from system message
        if (data.session_id) {
          this.sessionId = data.session_id;
          console.log(`[claudecode] session_id: ${this.sessionId}`);
        }
        // System messages may contain initial text
        if (data.message) {
          this.emitEvent({ type: 'text', content: String(data.message) });
        }
        break;
      }

      case 'assistant': {
        const msg = data.message;
        if (!msg) break;

        // Handle different content types within assistant message
        if (msg.content && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'thinking') {
              const thinkText = block.thinking || block.text || '';
              if (thinkText) {
                this.emitEvent({ type: 'thinking', content: thinkText });
              }
            } else if (block.type === 'text') {
              this.emitEvent({ type: 'text', content: block.text });
            } else if (block.type === 'tool_use') {
              this.emitEvent({
                type: 'tool_use',
                toolName: block.name,
                toolInput: JSON.stringify(block.input),
                toolInputRaw: block.input,
              });
            }
          }
        } else if (typeof msg === 'string') {
          this.emitEvent({ type: 'text', content: msg });
        }
        break;
      }

      case 'result': {
        const text = data.result || data.text || '';
        this.emitEvent({
          type: 'result',
          content: typeof text === 'string' ? text : JSON.stringify(text),
          sessionId: data.session_id || this.sessionId,
          isError: data.is_error === true || data.subtype === 'error_during_execution',
        });
        break;
      }

      case 'control_request': {
        // Permission request from Claude Code
        const req = data.request || {};
        const reqId = data.request_id;
        // Save original input so we can pass it back in allow response
        if (reqId && req.input) {
          this.pendingInputs.set(reqId, req.input);
        }
        this.emitEvent({
          type: 'permission_request',
          requestId: reqId,
          toolName: req.tool_name || data.tool?.name || data.tool,
          toolInput: req.input ? JSON.stringify(req.input) : undefined,
          toolInputRaw: req.input,
          content: req.decision_reason || `${req.tool_name || 'Tool'} wants permission`,
        });
        break;
      }

      case 'control_cancel_request': {
        // Permission cancelled
        console.log(`[claudecode] permission cancelled: ${data.request_id}`);
        break;
      }

      case 'user': {
        // Log tool_use_result for debugging
        if (data.tool_use_result) {
          console.log(`[claudecode:tool_result] ${JSON.stringify(data.tool_use_result).substring(0, 1000)}`);
        }
        if (data.message?.content) {
          const msg = data.message.content;
          const preview = typeof msg === 'string' ? msg.substring(0, 500) : JSON.stringify(msg).substring(0, 500);
          console.log(`[claudecode:user_content] ${preview}`);
        }
        break;
      }

      default: {
        console.log(`[claudecode] unhandled event type: ${type}`);
        break;
      }
    }
  }

  async send(prompt: string, images?: ImageAttachment[]): Promise<void> {
    if (!this.proc?.stdin || !this._alive) {
      throw new Error('Claude Code process is not running');
    }

    const message: any = {
      type: 'user',
      message: {
        role: 'user',
        content: prompt,
      },
    };

    // Attach images if provided
    if (images?.length) {
      message.message.content = [
        { type: 'text', text: prompt },
        ...images.map(img => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType,
            data: img.data.toString('base64'),
          },
        })),
      ];
    }

    const json = JSON.stringify(message);
    this.proc.stdin.write(json + '\n');
  }

  async respondPermission(requestId: string, result: PermissionResult): Promise<void> {
    if (!this.proc?.stdin || !this._alive) {
      throw new Error('Claude Code process is not running');
    }

    // Use provided updatedInput, or fall back to the original tool input from the request
    const originalInput = this.pendingInputs.get(requestId) || {};
    this.pendingInputs.delete(requestId);

    const permResponse: any = result.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: result.updatedInput || originalInput }
      : { behavior: 'deny', message: result.message || 'Denied by user' };

    const response: any = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: permResponse,
      },
    };

    const json = JSON.stringify(response);
    console.log(`[claudecode] permission response: ${json}`);
    this.proc.stdin.write(json + '\n');
  }

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  alive(): boolean {
    return this._alive;
  }

  async close(): Promise<void> {
    // Capture proc locally and nullify immediately to prevent concurrent close() races
    const proc = this.proc;
    this.proc = null;
    this._alive = false;

    console.log(`[claudecode] closing session, proc=${!!proc}`);

    if (!proc) return;

    try {
      // Remove event listeners to prevent spurious events during shutdown
      proc.removeAllListeners('exit');
      proc.removeAllListeners('error');
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.stdin?.end();
      proc.kill('SIGTERM');
    } catch { /* ignore */ }

    await new Promise<void>((resolve) => {
      // If process already exited, resolve immediately
      if (proc.exitCode !== null) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 3000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    console.log(`[claudecode] session closed`);
  }
}
