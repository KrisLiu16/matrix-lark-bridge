/**
 * WeChat Gateway Integration — routes WeChat messages to/from Claude Code sessions.
 *
 * Parallel to bridge-source/gateway.ts (Feishu gateway). Bridges the gap between
 * WechatChannel (iLink message I/O) and ClaudeSession (CC process I/O).
 *
 * Architecture:
 *   WechatChannel.onMessage → WechatGateway.handleMessage → ClaudeSession.send
 *   ClaudeSession.onEvent   → WechatGateway.processEvents → WechatChannel.sendTextReply
 *
 * Shares ClaudeSession/SessionStore infrastructure with Feishu gateway.
 *
 * K5: /auth command routed to auth-handler.ts
 * K7: Permission whitelist (no blanket auto-allow)
 * K8: AskUserQuestion answer collection via pendingQuestion map
 */

import type {
  WechatChannelMessage,
  WechatSessionMapping,
  WechatFeishuBinding,
} from './types.js';
import {
  iLinkMessageToBridgeMessage,
  getContextToken,
  truncateForWechat,
} from './message-adapter.js';
import {
  isAuthCommand,
  handleAuthCommand,
  loadBindingsFromDisk,
  refreshFeishuToken,
  type AuthHandlerConfig,
} from './auth-handler.js';
import type { ILinkClient } from '@mlb/wechat-sdk';
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Types re-exported from bridge-source (for callers that don't import directly)
// ---------------------------------------------------------------------------

/** Agent event from Claude Code process (mirrors bridge-source/types.ts). */
export interface AgentEvent {
  type: 'text' | 'tool_use' | 'result' | 'error' | 'permission_request' | 'permission_cancel' | 'thinking';
  content?: string;
  toolName?: string;
  toolInput?: string;
  toolInputRaw?: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
  isError?: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheCreate: number };
  totalCostUsd?: number;
}

/** Minimal ClaudeSession interface (duck-typed to avoid hard import). */
export interface IClaudeSession {
  start(): Promise<void>;
  send(prompt: string, images?: Array<{ mimeType: string; data: Buffer }>): Promise<void>;
  respondPermission(requestId: string, result: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }): Promise<void>;
  setCallbacks(cb: { onEvent: (event: AgentEvent) => void }): void;
  currentSessionId(): string | undefined;
  alive(): boolean;
  close(): Promise<void>;
}

/** Minimal SessionStore interface (duck-typed). */
export interface ISessionStore {
  getState(): {
    agentSessionId?: string;
    workDir: string;
    currentMessageId?: string;
    stepCount: number;
    steps: Array<{ tool: string; label: string }>;
    startTime?: number;
  };
  setAgentSessionId(id: string | undefined): void;
  resetTurn(): void;
  addHistory(role: 'user' | 'assistant', content: string): void;
  save(): void;
}

/** Send function provided by WechatChannel. */
export interface WechatSendFunctions {
  sendTextReply(userId: string, contextToken: string, text: string): Promise<void>;
  sendTyping(userId: string, contextToken: string): Promise<void>;
  sendImageReply(userId: string, contextToken: string, imageData: Buffer): Promise<void>;
  sendFileReply(userId: string, contextToken: string, fileData: Buffer, fileName: string): Promise<void>;
}

/** Factory for creating ClaudeSession instances. */
export interface ClaudeSessionFactory {
  create(opts: {
    workDir: string;
    resumeSessionId?: string;
    systemPrompt?: string;
  }): IClaudeSession;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time to wait for processEvents to resolve (ms). */
const PROCESS_EVENTS_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum retries when session dies immediately. */
const MAX_RETRIES = 1;

/** Long text truncation for history storage. */
const HISTORY_TRUNCATE_LEN = 500;

/** AskUserQuestion answer timeout (ms). */
const ASK_QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// NC3: Outbound media security guards
// ---------------------------------------------------------------------------

/** Maximum file size for outbound media (50 MB). */
export const MAX_OUTBOUND_FILE_SIZE = 50 * 1024 * 1024;

/** Path patterns that must never be sent to users. */
export const BLOCKED_PATH_PATTERNS: RegExp[] = [
  /\.env/,
  /\.ssh\//,
  /\.gnupg\//,
  /\/etc\/shadow/,
  /\/etc\/passwd/,
  /credentials/i,
  /secret/i,
  /\.git\//,
];

/**
 * Validate whether a file path is safe to send as outbound media.
 * Checks: file existence, sensitive path patterns, file size limit.
 */
export function validateOutboundFilePath(
  filePath: string,
): { valid: boolean; reason?: string } {
  // Reject empty or whitespace-only paths
  if (!filePath || !filePath.trim()) {
    return { valid: false, reason: '路径为空' };
  }

  // C3: Resolve symlinks to real path before any checks.
  // If the file doesn't exist or can't be resolved, reject immediately.
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch {
    return { valid: false, reason: '文件不存在或无法解析路径' };
  }

  // Check sensitive path patterns against the REAL (resolved) path
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(realPath)) {
      return { valid: false, reason: `路径匹配敏感模式 ${pattern}` };
    }
  }

  // Also check the original path (in case the pattern matches the symlink name itself)
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(filePath)) {
      return { valid: false, reason: `路径匹配敏感模式 ${pattern}` };
    }
  }

  // Check file size (use realPath for accurate stat)
  try {
    const size = statSync(realPath).size;
    if (size > MAX_OUTBOUND_FILE_SIZE) {
      const sizeMB = (size / (1024 * 1024)).toFixed(1);
      return { valid: false, reason: `文件过大 (${sizeMB} MB, 上限 50 MB)` };
    }
  } catch {
    return { valid: false, reason: '无法读取文件大小' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Command splitting — split compound commands for per-segment checking
// ---------------------------------------------------------------------------

/**
 * Split a shell command string into segments by |, &&, ||, ;
 * Respects single/double quotes (content inside quotes is not split).
 *
 * Examples:
 *   "echo foo | sh"       → ["echo foo ", " sh"]
 *   "ls ; rm -rf /"       → ["ls ", " rm -rf /"]
 *   "echo 'a|b' && ls"    → ["echo 'a|b' ", " ls"]
 *   "true && bash -c 'x'" → ["true ", " bash -c 'x'"]
 */
export function splitCommandSegments(cmd: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i];

    // Toggle quote state (no escaping for simplicity — matches shell behavior for splitting)
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    // Inside quotes — no splitting
    if (inSingle || inDouble) {
      current += ch;
      i++;
      continue;
    }

    // Check for || (must check before single |)
    if (ch === '|' && cmd[i + 1] === '|') {
      segments.push(current);
      current = '';
      i += 2;
      continue;
    }
    // Pipe |
    if (ch === '|') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    // &&
    if (ch === '&' && cmd[i + 1] === '&') {
      segments.push(current);
      current = '';
      i += 2;
      continue;
    }
    // Semicolon ;
    if (ch === ';') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

// ---------------------------------------------------------------------------
// K7: Permission safety whitelist
// ---------------------------------------------------------------------------

/** Tools that are always safe to auto-approve (read-only or standard CC tools). */
const SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'LSP',
  'Edit',
  'Write',
  'NotebookEdit',
  'TodoWrite',
  'AskUserQuestion',
]);

/**
 * Bash commands considered safe (read-only).
 * Only the first word of the command is checked.
 */
const SAFE_BASH_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'echo', 'pwd', 'whoami', 'date',
  'wc', 'sort', 'uniq', 'diff', 'file', 'which', 'type',
  'printenv', 'uname', 'hostname', 'id', 'df', 'du', 'free',
  'uptime', 'ps', 'top', 'node', 'npm', 'pnpm', 'yarn',
  'tsc', 'tsx', 'git', 'find', 'grep', 'rg', 'ag', 'fd',
  'jq', 'python', 'python3', 'go', 'cargo', 'rustc',
]);

/**
 * Bash subcommands/flags that make an otherwise safe command dangerous.
 */
const DANGEROUS_BASH_PATTERNS = [
  /\brm\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\b/,
  /\bkill\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  // C4: git dangerous subcommands — long AND short flags
  // Covers: push --force / -f (but NOT --force-with-lease), reset --hard, clean -f/-d, stash drop, branch -d/-D, checkout --
  /\bgit\s+(checkout\s+--|reset\s+--hard|clean\s+-[fd]|stash\s+drop|branch\s+-[dD]|push\s+(--force(?!-with-lease)|-f\b))/,
  /\bcurl\s.*-X\s*(POST|PUT|DELETE|PATCH)\b/i,
  /\bcurl\s.*--data\b/,
  /\bwget\b/,
  // NC1: redirect to file path — blocks >, >>, &>, &>> followed by path-like chars
  // Allows safe fd redirects: 2>&1, >&2, 2>/dev/null
  /(?<![0-9])&>{1,2}\s*[\/\.~]/,
  /(?:^|[^0-9&])>{1,2}\s*[\/\.~]/,
  /\bsudo\b/,
  /\bsu\b/,
  /\beval\b/,
  /\bexec\b/,
  // C2: interpreter inline execution — blocks node -e, python -c, ruby -e, perl -e, etc.
  /\b(node|python3?|ruby|perl)\s+(-e|--eval|-c)\b/,
  // NC3: interpreter dangerous flags — --require, -r (node), --import (node ESM)
  /\b(node|python3?)\s+(--require|-r|--import)\b/,
  // C2: npx can download and execute arbitrary packages
  /\bnpx\s+/,
  // C2: deno/bun eval
  /\b(deno|bun)\s+eval\b/,
  // NC5b: wrapper commands that can invoke arbitrary shells
  /\b(env|xargs|nohup)\s+.*(bash|sh|zsh|fish|dash|csh|ksh|python3?|ruby|perl|node)\b/,
];

/**
 * Check if a permission request should be auto-approved in WeChat context.
 *
 * Unlike Feishu (which has card-based interactive approval), WeChat can only
 * send text. So we use a strict whitelist: safe tools pass, unsafe tools are
 * auto-denied with a user notification.
 *
 * Mirrors bridge-source/claude-settings.ts isPermissionAllowed() logic but
 * with a hardcoded whitelist instead of reading ~/.claude/settings.local.json.
 */
function isWechatPermissionAllowed(
  toolName: string,
  toolInput?: Record<string, unknown>,
): boolean {
  // Known safe tools
  if (SAFE_TOOLS.has(toolName)) return true;

  // Bash: check command safety — split by |, &&, ||, ; and check each segment
  if (toolName === 'Bash') {
    const command = String(toolInput?.command || '').trim();
    if (!command) return false;

    // NC2: Pipe-to-bare-interpreter bypass detection
    // Interpreters receiving piped stdin without a script file argument can execute
    // arbitrary code (e.g. "cat payload | python3", "echo evil | node").
    // This checks the raw command before segment splitting to preserve pipe context.
    const PIPE_INTERPRETER_RE =
      /\|\s*(python3?|node|ruby|perl|deno|bun)\s*(?:$|[|;&])/;
    if (PIPE_INTERPRETER_RE.test(command)) return false;

    // Split into segments and check each independently
    const segments = splitCommandSegments(command);
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;

      // Check for dangerous patterns in this segment
      for (const pattern of DANGEROUS_BASH_PATTERNS) {
        if (pattern.test(trimmed)) return false;
      }

      // Check first word of this segment against safe list
      const firstWord = trimmed.split(/\s+/)[0];
      if (!SAFE_BASH_COMMANDS.has(firstWord)) return false;
    }

    return true;
  }

  // MCP tools or unknown tools — deny
  return false;
}

/**
 * Format a human-readable description of a denied permission for the user.
 */
function formatDeniedPermission(toolName: string, toolInput?: string): string {
  const lines = [
    `[权限拒绝] Claude 尝试执行不安全操作:`,
    `工具: ${toolName}`,
  ];
  if (toolInput) {
    const truncated = toolInput.length > 200
      ? toolInput.substring(0, 200) + '...'
      : toolInput;
    lines.push(`参数: ${truncated}`);
  }
  lines.push('', '该操作在微信通道中不可用。如需执行，请通过飞书通道操作。');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Session mapping store (in-memory, WeChat userId → session info)
// ---------------------------------------------------------------------------

const sessionMap = new Map<string, WechatSessionMapping>();

/** Get or create session mapping for a WeChat user. */
function getSessionMapping(userId: string): WechatSessionMapping {
  let mapping = sessionMap.get(userId);
  if (!mapping) {
    mapping = {
      wechatUserId: userId,
      lastActivity: new Date().toISOString(),
    };
    sessionMap.set(userId, mapping);
  }
  return mapping;
}

/** Update session mapping with CC agent session ID. */
function setAgentSession(userId: string, agentSessionId: string | undefined): void {
  const mapping = getSessionMapping(userId);
  mapping.agentSessionId = agentSessionId;
  mapping.lastActivity = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Auth binding store (in-memory, WeChat userId → Feishu binding)
// ---------------------------------------------------------------------------

const authBindings = new Map<string, WechatFeishuBinding>();

/**
 * Initialize auth bindings from disk.
 * Call once at startup to sync in-memory Map with persisted bindings.
 */
export function loadAuthBindingsFromDisk(dataDir: string): void {
  const diskBindings = loadBindingsFromDisk(dataDir);
  for (const [userId, binding] of diskBindings) {
    authBindings.set(userId, binding);
  }
  console.log(`[wechat-gw] loaded ${diskBindings.size} auth bindings from disk`);
}

/**
 * Get auth binding with expiry check and auto-renewal.
 * Returns undefined if no binding, token expired and renewal failed.
 */
export async function getAuthBinding(
  wechatUserId: string,
  authConfig?: AuthHandlerConfig,
): Promise<WechatFeishuBinding | undefined> {
  const binding = authBindings.get(wechatUserId);
  if (!binding?.feishuUserToken || !binding.tokenExpiry) return undefined;

  // Check expiry (5 min buffer)
  const expiryMs = new Date(binding.tokenExpiry).getTime() - 5 * 60 * 1000;
  if (expiryMs > Date.now()) return binding;

  // Token expired — try refresh
  if (authConfig && binding.refreshToken) {
    const refreshed = await refreshFeishuToken(binding, authConfig);
    if (refreshed) {
      authBindings.set(wechatUserId, refreshed);
      return refreshed;
    }
  }

  return undefined;
}

/**
 * Get auth binding synchronously (no auto-renewal, no expiry check).
 */
export function getAuthBindingSync(wechatUserId: string): WechatFeishuBinding | undefined {
  return authBindings.get(wechatUserId);
}

/** Store a Feishu auth binding for a WeChat user. */
export function setAuthBinding(binding: WechatFeishuBinding): void {
  authBindings.set(binding.wechatUserId, binding);
}

/** Remove a Feishu auth binding. */
export function removeAuthBinding(wechatUserId: string): void {
  authBindings.delete(wechatUserId);
}

// ---------------------------------------------------------------------------
// Outbound media: detect file references in Claude's result text
// ---------------------------------------------------------------------------

/** Image extensions that should be sent as image replies. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** File path regex: matches absolute paths or ./relative paths in result text. */
const FILE_PATH_REGEX = /(?:^|\s)((?:\/[\w.@()-]+)+\.\w+|\.\/[\w./@()-]+\.\w+)/gm;

/**
 * Extract file references from Claude's result text.
 * Returns an array of { absolutePath, fileName, isImage }.
 *
 * Only returns files that actually exist on disk.
 */
function extractFileReferences(
  text: string,
  workDir: string,
): Array<{ absolutePath: string; fileName: string; isImage: boolean }> {
  const results: Array<{ absolutePath: string; fileName: string; isImage: boolean }> = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(FILE_PATH_REGEX)) {
    const rawPath = match[1];
    const absolutePath = rawPath.startsWith('/') ? rawPath : resolve(workDir, rawPath);

    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);

    try {
      if (!existsSync(absolutePath)) continue;
    } catch {
      continue;
    }

    const ext = extname(absolutePath).toLowerCase();
    results.push({
      absolutePath,
      fileName: basename(absolutePath),
      isImage: IMAGE_EXTENSIONS.has(ext),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// WechatGateway
// ---------------------------------------------------------------------------

/** GUI notification hooks — called by WechatGateway to update IPC layer stats. */
export interface GatewayGUIHooks {
  /**
   * Record a message activity entry for GUI display.
   * Called on inbound message receipt and outbound reply send.
   */
  recordActivity?(
    direction: 'inbound' | 'outbound',
    senderName: string,
    msgType: number,
    preview: string,
    isError?: boolean,
  ): void;

  /**
   * Update heartbeat timestamp.
   * Called after each successful Claude response cycle.
   */
  touchHeartbeat?(): void;

  /**
   * Notify GUI of connection state change.
   * Called when WechatChannel state changes.
   */
  notifyStateChange?(state: string): void;
}

export interface WechatGatewayConfig {
  /** Claude Code working directory. */
  workDir: string;
  /** Bot display name. */
  botName?: string;
  /** Maximum message queue depth (0 = unlimited). */
  maxQueue?: number;
  /** Custom system prompt appended to built-in prompt. */
  customSystemPrompt?: string;
  /** Auth handler config (required for /auth command). */
  authConfig?: AuthHandlerConfig;
  /** iLink SDK client instance (required for /auth command). */
  ilinkClient?: ILinkClient;
  /** GUI notification hooks for stats/status updates. */
  guiHooks?: GatewayGUIHooks;
}

/**
 * WeChat Gateway — orchestrates message flow between WechatChannel and ClaudeSession.
 *
 * Mirrors gateway.ts logic for Feishu: message queuing, session lifecycle,
 * event processing, permission handling, and /command routing.
 */
export class WechatGateway {
  private session: IClaudeSession | null = null;
  private sessionFactory: ClaudeSessionFactory;
  private store: ISessionStore;
  private sender: WechatSendFunctions;
  private config: WechatGatewayConfig;
  private processing = false;
  private messageQueue: Array<{
    msg: WechatChannelMessage;
    enqueuedAt: number;
  }> = [];
  private maxQueue: number;
  private generation = 0;
  private pendingPermissions = new Map<string, {
    resolve: (result: { behavior: 'allow' | 'deny' }) => void;
  }>();

  // K8: Pending AskUserQuestion answers
  private pendingQuestions = new Map<string, {
    questionId: string;
    resolve: (answer: string) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    sessionFactory: ClaudeSessionFactory,
    store: ISessionStore,
    sender: WechatSendFunctions,
    config: WechatGatewayConfig,
  ) {
    this.sessionFactory = sessionFactory;
    this.store = store;
    this.sender = sender;
    this.config = config;
    this.maxQueue = config.maxQueue ?? 5;

    // Load persisted auth bindings from disk into memory
    if (config.authConfig?.dataDir) {
      loadAuthBindingsFromDisk(config.authConfig.dataDir);
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Handle an inbound WeChat message. Entry point called by WechatChannel.onMessage.
   *
   * Mirrors gateway.ts handleMessage():
   * - Check /auth command (K5)
   * - Check if answering a pending AskUserQuestion (K8)
   * - Check other slash commands
   * - Queue if busy
   * - Process message → Claude → reply
   */
  async handleMessage(msg: WechatChannelMessage): Promise<void> {
    const text = msg.text || '';
    const userId = msg.sender.userId;

    console.log(`[wechat-gw] handleMessage: user=${userId} text="${text.substring(0, 50)}"`);

    // Update session mapping
    getSessionMapping(userId);

    // GUI: record inbound activity
    const msgType = msg.images?.length ? 2 : 1; // IMAGE=2, TEXT=1
    this.config.guiHooks?.recordActivity?.(
      'inbound',
      msg.sender.nickname || msg.sender.userId,
      msgType,
      text.substring(0, 50) || '[媒体]',
    );

    // K5: Check /auth command first — route to auth-handler
    if (text.trim() && isAuthCommand(text)) {
      await this.handleAuthFlow(userId, msg.contextToken, text);
      return;
    }

    // K8: Check if this message is answering a pending AskUserQuestion
    const pending = this.pendingQuestions.get(userId);
    if (pending) {
      console.log(`[wechat-gw] routing answer to pending question for user=${userId}`);
      clearTimeout(pending.timer);
      this.pendingQuestions.delete(userId);
      pending.resolve(text || '');
      return;
    }

    // Check other slash commands
    if (text.startsWith('/')) {
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const handled = await this.handleCommand(cmd, parts.slice(1), msg);
      if (handled) return;
    }

    // Queue if already processing
    if (this.processing) {
      if (this.maxQueue > 0 && this.messageQueue.length >= this.maxQueue) {
        await this.sender.sendTextReply(
          userId,
          msg.contextToken,
          `[队列已满] 当前有 ${this.messageQueue.length} 条消息排队中，请稍后再试。`,
        );
        return;
      }
      this.messageQueue.push({ msg, enqueuedAt: Date.now() });
      const pos = this.messageQueue.length;
      console.log(`[wechat-gw] message queued (position ${pos}/${this.maxQueue})`);
      return;
    }

    await this.processMessage(msg);
  }

  /**
   * Stop the gateway — close Claude session and clear state.
   */
  async stop(): Promise<void> {
    this.generation++;
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
    this.messageQueue = [];
    this.processing = false;
    this.pendingPermissions.clear();
    // Clear pending questions
    for (const [, pending] of this.pendingQuestions) {
      clearTimeout(pending.timer);
      pending.resolve('');
    }
    this.pendingQuestions.clear();
  }

  // -------------------------------------------------------------------------
  // K5: /auth command routing
  // -------------------------------------------------------------------------

  /**
   * Route /auth command to auth-handler.
   * Requires authConfig and ilinkClient to be set in gateway config.
   */
  private async handleAuthFlow(userId: string, contextToken: string, messageText: string): Promise<void> {
    if (!this.config.authConfig || !this.config.ilinkClient) {
      await this.sender.sendTextReply(
        userId,
        contextToken,
        '[错误] /auth 功能未配置。请联系管理员设置飞书 OAuth 参数。',
      );
      return;
    }

    // Parse /auth arguments: "/auth force" triggers forced re-authorization
    const args = messageText.trim().split(/\s+/).slice(1);
    const force = args.some(a => a.toLowerCase() === 'force');

    try {
      await handleAuthCommand(
        userId,
        contextToken,
        this.config.ilinkClient,
        this.config.authConfig,
        {
          force,
          onBindingCreated: (binding) => setAuthBinding(binding),
        },
      );
    } catch (err) {
      console.error(`[wechat-gw] auth command error:`, err);
      await this.sender.sendTextReply(
        userId,
        contextToken,
        `[错误] 授权流程异常: ${(err as Error).message}`,
      ).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Command handling
  // -------------------------------------------------------------------------

  /**
   * Handle slash commands from WeChat users.
   * Returns true if the command was handled (message should not be forwarded to CC).
   */
  private async handleCommand(
    cmd: string,
    _args: string[],
    msg: WechatChannelMessage,
  ): Promise<boolean> {
    const userId = msg.sender.userId;
    const ctx = msg.contextToken;

    switch (cmd) {
      case '/stop': {
        this.generation++;
        if (this.session?.alive()) {
          await this.session.close();
          this.session = null;
        }
        this.messageQueue = [];
        this.processing = false;
        await this.sender.sendTextReply(userId, ctx, '[已停止] 当前任务已终止。');
        return true;
      }

      case '/reset': {
        this.generation++;
        if (this.session?.alive()) {
          await this.session.close();
          this.session = null;
        }
        this.store.setAgentSessionId(undefined);
        setAgentSession(userId, undefined);
        this.messageQueue = [];
        this.processing = false;
        await this.sender.sendTextReply(userId, ctx, '[已重置] 会话已清除，下次消息将启动新会话。');
        return true;
      }

      case '/status': {
        const mapping = getSessionMapping(userId);
        const binding = await getAuthBinding(userId, this.config.authConfig);
        const lines = [
          `[状态]`,
          `会话: ${this.session?.alive() ? '运行中' : '未启动'}`,
          `队列: ${this.messageQueue.length} 条待处理`,
          `CC Session: ${mapping.agentSessionId || '无'}`,
          `飞书绑定: ${binding ? `已绑定 (${binding.feishuOpenId})` : '未绑定'}`,
        ];
        await this.sender.sendTextReply(userId, ctx, lines.join('\n'));
        return true;
      }

      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Message processing
  // -------------------------------------------------------------------------

  /**
   * Process a single message: send to Claude, wait for result, reply to WeChat.
   * Mirrors gateway.ts processMessage().
   */
  private async processMessage(msg: WechatChannelMessage): Promise<void> {
    this.processing = true;
    const userId = msg.sender.userId;
    const contextToken = msg.contextToken;
    const text = msg.text || '[图片]';

    // Send typing indicator (best-effort)
    this.sender.sendTyping(userId, contextToken).catch(() => {});

    try {
      this.store.addHistory('user', text);
      this.store.resetTurn();

      // Ensure Claude session (pass userId for per-user session resume)
      await this.ensureSession(userId);

      // Build context prefix (parallel to gateway.ts buildUserContext)
      const now = new Date();
      const timeStr = now.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
      const binding = await getAuthBinding(userId, this.config.authConfig);
      const contextLines = [
        `[System Context]`,
        `platform: wechat`,
        `user_id: ${userId}`,
        binding ? `feishu_open_id: ${binding.feishuOpenId}` : null,
        `time: ${timeStr}`,
      ].filter(Boolean).join('\n');

      const fullPrompt = `${contextLines}\n\n${text}`;

      // Attach event listener BEFORE send() to avoid losing early events
      const images = msg.images?.map(img => ({
        mimeType: img.mimeType,
        data: img.data,
      }));
      const eventsPromise = this.processEvents(userId, contextToken);
      await this.requireSession().send(fullPrompt, images);

      // Wait for events (blocking until result)
      let retries = 0;
      let needsRetry = await eventsPromise;
      while (needsRetry && retries < MAX_RETRIES) {
        retries++;
        console.log(`[wechat-gw] retrying with fresh session (attempt ${retries}/${MAX_RETRIES})`);
        setAgentSession(userId, undefined);
        this.store.setAgentSessionId(undefined);
        await this.session?.close();
        this.session = null;
        await this.ensureSession(userId);
        const retryEventsPromise = this.processEvents(userId, contextToken);
        await this.requireSession().send(fullPrompt, images);
        needsRetry = await retryEventsPromise;
      }
      if (needsRetry) {
        await this.sender.sendTextReply(
          userId, contextToken,
          '[错误] 会话创建失败，请稍后重试。',
        );
      }
    } catch (err) {
      console.error('[wechat-gw] processMessage error:', err);
      await this.sender.sendTextReply(
        userId, contextToken,
        `[错误] ${(err as Error).message}`,
      ).catch(() => {});
    } finally {
      this.processing = false;
      this.drainQueue();
    }
  }

  /**
   * Process the next message in the queue.
   * Mirrors gateway.ts drainQueue().
   */
  private drainQueue(): void {
    if (this.processing || this.messageQueue.length === 0) return;

    const next = this.messageQueue.shift()!;
    const age = Date.now() - next.enqueuedAt;

    // Drop stale queued messages (>10 minutes)
    if (age > 10 * 60 * 1000) {
      console.log(`[wechat-gw] dropping stale queued message (age=${Math.round(age / 1000)}s)`);
      const userId = next.msg.sender.userId;
      const ctx = next.msg.contextToken;
      this.sender.sendTextReply(userId, ctx, '[消息已过期] 排队时间过长，请重新发送。').catch(() => {});
      this.drainQueue();
      return;
    }

    console.log(`[wechat-gw] processing queued message (${this.messageQueue.length} remaining)`);
    this.processMessage(next.msg).catch((err) => {
      console.error('[wechat-gw] queued message error:', err);
    });
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  private requireSession(): IClaudeSession {
    if (!this.session) {
      throw new Error('Failed to create Claude session');
    }
    return this.session;
  }

  /**
   * Ensure a live Claude session exists. Creates one if needed.
   * Mirrors gateway.ts ensureSession().
   */
  private async ensureSession(userId?: string): Promise<void> {
    if (this.session && this.session.alive()) return;

    const state = this.store.getState();
    // W4 fix: use per-user session mapping for resume ID instead of shared store
    const resumeId = userId
      ? getSessionMapping(userId).agentSessionId
      : state.agentSessionId;
    console.log(`[wechat-gw] starting session, resumeId=${resumeId || 'none'}, workDir=${state.workDir}, userId=${userId || 'unknown'}`);

    const botName = this.config.botName || 'WeChat Bot';
    const systemPrompt = [
      '<system-prompt>',
      '',
      '# Identity',
      `You are ${botName}, a Claude Code instance with WeChat integration.`,
      'You can control the local machine for development and assist with daily work.',
      '',
      '# Context',
      'Messages include `[System Context]` with:',
      '- `platform`: wechat',
      '- `user_id`: sender\'s WeChat iLink user ID',
      '- `feishu_open_id`: sender\'s Feishu ID (if /auth bound)',
      '',
      '# Workspace',
      `Your working directory is \`${state.workDir.replace(/`/g, '')}\`.`,
      '',
      '# Behavior',
      '- Respond in the same language the user uses.',
      '- Solve problems proactively — do not push steps back to the user.',
      '- Keep replies concise — WeChat messages have display constraints.',
      '',
      '</system-prompt>',
      this.config.customSystemPrompt || '',
    ].filter(Boolean).join('\n');

    try {
      this.session = this.sessionFactory.create({
        workDir: state.workDir,
        resumeSessionId: resumeId,
        systemPrompt,
      });
      await this.session.start();
    } catch (err) {
      if (resumeId) {
        console.warn(`[wechat-gw] resume failed: ${(err as Error).message}, starting fresh`);
        this.store.setAgentSessionId(undefined);
        this.session = this.sessionFactory.create({
          workDir: state.workDir,
          systemPrompt,
        });
        await this.session.start();
      } else {
        this.session = null;
        throw err;
      }
    }
  }

  // -------------------------------------------------------------------------
  // K8: AskUserQuestion answer collection
  // -------------------------------------------------------------------------

  /**
   * Register a pending question for a user. When the user's next message
   * arrives, it will be routed as the answer instead of creating a new prompt.
   *
   * Returns a Promise that resolves with the user's answer text,
   * or '' if the question times out (5 minutes).
   */
  private waitForUserAnswer(userId: string, questionId: string): Promise<string> {
    // Cancel any existing pending question for this user
    const existing = this.pendingQuestions.get(userId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve('');
      this.pendingQuestions.delete(userId);
    }

    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        console.log(`[wechat-gw] question timeout for user=${userId}, questionId=${questionId}`);
        this.pendingQuestions.delete(userId);
        resolve('');
      }, ASK_QUESTION_TIMEOUT_MS);

      this.pendingQuestions.set(userId, {
        questionId,
        resolve,
        timer,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Event processing
  // -------------------------------------------------------------------------

  /**
   * Process Claude Code events until a result or error.
   * Returns true if session died immediately and should be retried.
   *
   * K7: Permission requests filtered through whitelist.
   * K8: AskUserQuestion triggers answer collection from WeChat user.
   */
  private processEvents(userId: string, contextToken: string): Promise<boolean> {
    const session = this.session;
    if (!session) return Promise.resolve(true);

    const gen = this.generation;

    return new Promise<boolean>((resolve) => {
      let done = false;
      let hadMeaningfulEvent = false;
      let resolved = false;

      const safeResolve = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve(value);
      };

      const timeoutTimer = setTimeout(() => {
        if (!done) {
          done = true;
          console.error(`[wechat-gw] processEvents timed out after ${PROCESS_EVENTS_TIMEOUT_MS / 1000}s`);
          safeResolve(false);
        }
      }, PROCESS_EVENTS_TIMEOUT_MS);

      // Serialize event handling
      let eventQueue = Promise.resolve();
      const onEvent = (evt: AgentEvent) => {
        eventQueue = eventQueue.then(() => handleEvent(evt)).catch(err => {
          console.error('[wechat-gw] onEvent error:', err);
        });
      };

      const handleEvent = async (evt: AgentEvent) => {
        // Discard events from a stale generation (after /stop)
        if (gen !== this.generation) {
          if (!done) {
            done = true;
            safeResolve(false);
          }
          return;
        }
        if (done) return;

        switch (evt.type) {
          case 'thinking':
          case 'text': {
            if (evt.type === 'text') hadMeaningfulEvent = true;
            break;
          }

          case 'tool_use': {
            hadMeaningfulEvent = true;
            console.log(`[wechat-gw] tool: ${evt.toolName || ''}`);

            // K8: Handle AskUserQuestion — send question and wait for answer
            if (evt.toolName === 'AskUserQuestion' && evt.toolInputRaw) {
              const questions = evt.toolInputRaw.questions as Array<{
                question?: string;
              }> | undefined;
              const questionText = questions?.[0]?.question || '请回答';
              const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

              // Send question to WeChat user
              await this.sender.sendTextReply(userId, contextToken, `[提问] ${questionText}`);

              // Wait for user's answer (blocks event processing until answer or timeout)
              const answer = await this.waitForUserAnswer(userId, questionId);

              if (answer) {
                console.log(`[wechat-gw] got answer for question ${questionId}: "${answer.substring(0, 50)}"`);
                // Feed the answer back to the session as a new message
                try {
                  if (session.alive()) {
                    await session.send(answer);
                  }
                } catch (err) {
                  console.warn(`[wechat-gw] failed to send answer to session:`, (err as Error).message);
                }
              } else {
                console.log(`[wechat-gw] question ${questionId} timed out or empty answer`);
                // Send timeout notification to user
                await this.sender.sendTextReply(
                  userId, contextToken,
                  '[超时] 提问已超时，Claude 将继续执行。',
                ).catch(() => {});
              }
            }
            break;
          }

          case 'permission_cancel': {
            if (evt.requestId) {
              const pending = this.pendingPermissions.get(evt.requestId);
              if (pending) {
                pending.resolve({ behavior: 'deny' });
                this.pendingPermissions.delete(evt.requestId);
              }
            }
            break;
          }

          // K7: Permission whitelist — no blanket auto-allow
          case 'permission_request': {
            if (!evt.requestId) break;

            const toolName = evt.toolName || 'Unknown';

            // Check whitelist
            if (isWechatPermissionAllowed(toolName, evt.toolInputRaw)) {
              console.log(`[wechat-gw] auto-allow (whitelist): ${toolName}`);
              try {
                if (session.alive()) {
                  await session.respondPermission(evt.requestId, { behavior: 'allow' });
                }
              } catch (err) {
                console.warn(`[wechat-gw] respondPermission (allow) failed:`, (err as Error).message);
              }
            } else {
              // Deny and notify user
              console.log(`[wechat-gw] deny (not in whitelist): ${toolName}`);
              const denyMessage = formatDeniedPermission(toolName, evt.toolInput);
              await this.sender.sendTextReply(userId, contextToken, denyMessage).catch(() => {});

              try {
                if (session.alive()) {
                  await session.respondPermission(evt.requestId, {
                    behavior: 'deny',
                    message: `操作被拒绝: ${toolName} 在微信通道中不可用`,
                  });
                }
              } catch (err) {
                console.warn(`[wechat-gw] respondPermission (deny) failed:`, (err as Error).message);
              }
            }
            break;
          }

          case 'result': {
            done = true;

            // If no meaningful event and result is error, signal retry
            if (!hadMeaningfulEvent && evt.isError) {
              console.log('[wechat-gw] session error, will retry fresh');
              safeResolve(true);
              break;
            }

            const resultContent = evt.content?.trim() || '';

            // Send result text as WeChat reply
            if (resultContent) {
              const replyText = truncateForWechat(resultContent);
              await this.sender.sendTextReply(userId, contextToken, replyText);
              this.store.addHistory('assistant', resultContent.substring(0, HISTORY_TRUNCATE_LEN));

              // GUI: record outbound activity + heartbeat
              this.config.guiHooks?.recordActivity?.(
                'outbound',
                this.config.botName || 'Bot',
                1, // TEXT
                resultContent.substring(0, 50),
              );
              this.config.guiHooks?.touchHeartbeat?.();
            }

            // Outbound media: detect file paths in result text and send as image/file replies
            if (resultContent) {
              const workDir = this.config.workDir;
              const fileRefs = extractFileReferences(resultContent, workDir);

              for (const ref of fileRefs) {
                // NC3: Validate file path before reading
                const validation = validateOutboundFilePath(ref.absolutePath);
                if (!validation.valid) {
                  console.warn(`[wechat-gw] outbound media blocked: ${ref.fileName} — ${validation.reason}`);
                  await this.sender.sendTextReply(
                    userId, contextToken,
                    `[文件无法发送] ${ref.fileName}: ${validation.reason}`,
                  ).catch(() => {});
                  continue;
                }

                try {
                  const data = readFileSync(ref.absolutePath);
                  if (ref.isImage) {
                    console.log(`[wechat-gw] sending image: ${ref.fileName} (${data.length} bytes)`);
                    await this.sender.sendImageReply(userId, contextToken, data);
                    // GUI: record outbound image
                    this.config.guiHooks?.recordActivity?.(
                      'outbound',
                      this.config.botName || 'Bot',
                      2, // IMAGE
                      ref.fileName,
                    );
                  } else {
                    console.log(`[wechat-gw] sending file: ${ref.fileName} (${data.length} bytes)`);
                    await this.sender.sendFileReply(userId, contextToken, data, ref.fileName);
                    // GUI: record outbound file
                    this.config.guiHooks?.recordActivity?.(
                      'outbound',
                      this.config.botName || 'Bot',
                      4, // FILE
                      ref.fileName,
                    );
                  }
                } catch (err) {
                  console.warn(`[wechat-gw] failed to send outbound media ${ref.fileName}:`, (err as Error).message);
                }
              }
            }

            // Save agent session ID for resume
            if (evt.sessionId) {
              this.store.setAgentSessionId(evt.sessionId);
              setAgentSession(userId, evt.sessionId);
            }

            safeResolve(false);
            break;
          }

          case 'error': {
            done = true;

            if (!hadMeaningfulEvent) {
              safeResolve(true);
              break;
            }

            this.store.setAgentSessionId(undefined);
            setAgentSession(userId, undefined);
            this.session = null;
            const errMsg = evt.content || 'Unknown error';
            await this.sender.sendTextReply(
              userId, contextToken,
              `[错误] ${errMsg}`,
            );
            // GUI: record error activity
            this.config.guiHooks?.recordActivity?.(
              'outbound',
              this.config.botName || 'Bot',
              1, // TEXT
              errMsg.substring(0, 50),
              true, // isError
            );
            safeResolve(false);
            break;
          }
        }
      };

      // Attach callback (flushes buffered events)
      session.setCallbacks({ onEvent });
    });
  }
}
