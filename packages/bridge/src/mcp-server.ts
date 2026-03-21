import { createInterface } from 'node:readline';
import * as lark from '@larksuiteoapi/node-sdk';
import { ALL_TOOLS, OAPI_TOOL_NAMES, MCP_DOC_TOOL_NAMES, resolveTokenMode, type TokenMode } from './mcp-tools.js';
import { executeOapiTool } from './mcp-tool-handlers.js';
import { MlbMcpError, UserAuthRequiredError, UserScopeInsufficientError, AppScopeMissingError } from './mcp-errors.js';
import { getRequiredScopes } from './mcp-tool-scopes.js';
import { findApiAuthPolicy } from './api-auth-policies.js';

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TOOL_DEFINITION = {
  name: 'lark_api',
  description: `Call any Feishu/Lark Open API. The app's tenant_access_token is automatically added.

Usage: For APIs not covered by dedicated tools (lark_calendar_event, lark_task, etc.), use this generic tool.

Common APIs:
- GET /open-apis/im/v1/messages — List messages
- POST /open-apis/im/v1/messages — Send message
- GET /open-apis/contact/v3/users/:user_id — Get user info

Refer to Feishu Open API documentation for full API list.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      method: {
        type: 'string',
        description: 'HTTP method: GET, POST, PUT, DELETE, PATCH',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      },
      path: {
        type: 'string',
        description: 'API path, e.g. /open-apis/calendar/v4/calendars',
      },
      body: {
        type: 'string',
        description: 'JSON body for POST requests (optional)',
      },
      params: {
        type: 'object',
        description: 'URL query parameters (optional)',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['method', 'path'],
  },
};

interface UserContext {
  openId: string;
  name: string;
  chatId: string;
  chatType: string;
}

export class LarkMcpServer {
  /** Maximum retries for transient failures */
  private static readonly MAX_RETRIES = 3;
  /** Default retry delay (ms) — overridden by x-ogw-ratelimit-reset header */
  private static readonly DEFAULT_RETRY_DELAY_MS = 1000;

  private appId: string;
  private appSecret: string;
  private apiBaseUrl: string;
  private sdkClient: lark.Client;
  private userContext: UserContext;

  constructor(appId: string, appSecret: string, apiBaseUrl = 'https://open.feishu.cn') {
    this.appId = appId;
    this.appSecret = appSecret;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');

    // SDK Client — automatically manages tenant_access_token
    this.sdkClient = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
      domain: this.apiBaseUrl as any,
    });

    // Read user context from environment (set by gateway at session startup)
    this.userContext = {
      openId: process.env.MLB_SENDER_OPEN_ID || '',
      name: process.env.MLB_SENDER_NAME || '',
      chatId: process.env.MLB_CHAT_ID || '',
      chatType: process.env.MLB_CHAT_TYPE || '',
    };
  }

  async run(): Promise<void> {
    const rl = createInterface({ input: process.stdin });

    rl.on('line', async (line) => {
      if (!line.trim()) return;

      let req: McpRequest;
      try {
        req = JSON.parse(line);
      } catch {
        return;
      }

      // Notifications (no id) — ignore
      if (req.id === undefined || req.id === null) return;

      const result = await this.handleRequest(req);
      const response = { jsonrpc: '2.0', id: req.id, ...result };
      process.stdout.write(JSON.stringify(response) + '\n');
    });

    rl.on('close', () => process.exit(0));
  }

  private async handleRequest(req: McpRequest): Promise<Record<string, unknown>> {
    switch (req.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'lark', version: '2.0.0' },
          },
        };

      case 'notifications/initialized':
        return { result: {} };

      case 'tools/list':
        return {
          result: {
            tools: [
              TOOL_DEFINITION,
              ...ALL_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
            ],
          },
        };

      case 'tools/call':
        return this.handleToolCall(req.params as Record<string, unknown>);

      default:
        return { error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  }

  private async handleToolCall(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const toolName = params?.name as string;
    const args = (params?.arguments || {}) as Record<string, unknown>;

    if (toolName === 'lark_api') {
      return this.handleLarkApi(args);
    }

    if (MCP_DOC_TOOL_NAMES.has(toolName)) {
      return this.handleMcpDoc(toolName, args);
    }

    if (OAPI_TOOL_NAMES.has(toolName)) {
      return this.handleOapiTool(toolName, args);
    }

    return { error: { code: -32602, message: `Unknown tool: ${toolName}` } };
  }

  // --- lark_api: generic SDK request ---

  private async handleLarkApi(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const method = (args.method as string || 'GET').toUpperCase();
    const path = args.path as string;
    const body = typeof args.body === 'string' ? JSON.parse(args.body) : args.body as Record<string, unknown> | undefined;
    const queryParams = args.params as Record<string, string> | undefined;

    if (!path) {
      return { result: { content: [{ type: 'text', text: 'Error: path is required' }], isError: true } };
    }

    // Policy-based token mode detection for lark_api
    const policy = findApiAuthPolicy(path, method);
    let tokenMode: TokenMode = 'auto'; // default when no policy matches
    if (policy) {
      if (policy.preferred === 'tenant') {
        tokenMode = policy.fallback ? 'auto' : 'tenant';
      } else {
        // preferred === 'user'
        tokenMode = policy.fallback ? 'auto' : 'user';
      }
    }

    console.error(`[lark-mcp] API call: ${method} ${path} tokenMode=${tokenMode} policy=${policy?.description ?? 'none'}${body ? ' (with body)' : ''}`);

    try {
      // Scope pre-check for user-mode lark_api calls
      if (policy && policy.scopes.length > 0 && (tokenMode === 'user' || tokenMode === 'auto')) {
        const userScopes = await this.getUserGrantedScopes();
        if (userScopes !== null) {
          const missing = policy.scopes.filter(s => !userScopes.has(s));
          if (missing.length > 0 && tokenMode === 'user') {
            // Strict user mode: no scope = error
            throw new UserScopeInsufficientError(`lark_api:${path}`, missing);
          }
          // In auto mode: if scopes missing, prefer tenant fallback (skip UAT)
          if (missing.length > 0 && tokenMode === 'auto') {
            tokenMode = 'tenant';
            console.error(`[lark-mcp] lark_api scope insufficient for UAT, falling back to TAT: missing=${missing.join(',')}`);
          }
        }
      }

      const result = await this.withRetry(
        async () => {
          const opts = await this.resolveRequestOptionsForMode(tokenMode);
          return this.sdkClient.request({
            method: method as any,
            url: path,
            data: body,
            params: queryParams,
          }, opts);
        },
        `lark_api ${method} ${path}`,
      );
      return { result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
    } catch (err) {
      if (err instanceof MlbMcpError) {
        return { result: { content: [{ type: 'text', text: JSON.stringify(err.toToolResult(), null, 2) }], isError: true } };
      }
      const structured = this.detectAuthError(err, 'lark_api');
      if (structured && policy?.scopes?.length) {
        // Enrich structured error with policy scope info
        (structured as any).suggested_scopes = policy.scopes;
        (structured as any).api_path = path;
      }
      if (structured) {
        return { result: { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], isError: true } };
      }
      return { result: { content: [{ type: 'text', text: this.enrichErrorMessage(err) }], isError: true } };
    }
  }

  // --- OAPI dedicated tools: SDK typed methods ---

  private async handleOapiTool(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = args.action as string | undefined;
    const tokenMode = resolveTokenMode(toolName, action);
    console.error(`[lark-mcp] OAPI tool: ${toolName} action=${action ?? 'N/A'} tokenMode=${tokenMode}`);

    try {
      // Scope pre-check for user/auto mode
      if (tokenMode === 'user' || tokenMode === 'auto') {
        const requiredScopes = getRequiredScopes(toolName, action);
        if (requiredScopes.length > 0) {
          const userScopes = await this.getUserGrantedScopes();
          if (userScopes !== null) { // null = no token, will be caught by resolveRequestOptionsForMode
            const missing = requiredScopes.filter(s => !userScopes.has(s));
            if (missing.length > 0) {
              throw new UserScopeInsufficientError(`${toolName}.${action ?? 'default'}`, missing);
            }
          }
        }
      }

      const result = await this.withRetry(
        async () => {
          const opts = await this.resolveRequestOptionsForMode(tokenMode);
          return executeOapiTool(this.sdkClient, toolName, args, opts);
        },
        `${toolName}.${action ?? 'default'}`,
      );
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      };
    } catch (err) {
      // Check for structured MCP errors
      if (err instanceof MlbMcpError) {
        return { result: { content: [{ type: 'text', text: JSON.stringify(err.toToolResult(), null, 2) }], isError: true } };
      }
      // Check for runtime auth error codes
      const structured = this.detectAuthError(err, toolName, action);
      if (structured) {
        return { result: { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], isError: true } };
      }
      return {
        result: {
          content: [{ type: 'text', text: this.enrichErrorMessage(err) }],
          isError: true,
        },
      };
    }
  }

  // --- MCP Doc relay tools: HTTP to mcp.feishu.cn ---

  private async handleMcpDoc(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const uat = await this.resolveUatForMcpDoc();
    if (!uat) {
      return {
        result: {
          content: [{ type: 'text', text: 'MCP Doc 工具需要用户授权。请先执行 /auth 完成飞书 OAuth 授权。' }],
          isError: true,
        },
      };
    }

    // Map tool name to MCP tool name: lark_fetch_doc -> fetch-doc, lark_create_doc -> create-doc, lark_update_doc -> update-doc
    const mcpToolName = toolName.replace(/^lark_/, '').replace(/_/g, '-');
    const endpoint = process.env.FEISHU_MCP_ENDPOINT?.trim() || 'https://mcp.feishu.cn/mcp';

    const body = {
      jsonrpc: '2.0',
      id: `mlb-${Date.now()}`,
      method: 'tools/call',
      params: {
        name: mcpToolName,
        arguments: args,
      },
    };

    console.error(`[lark-mcp] MCP Doc: ${mcpToolName} → ${endpoint}`);

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Lark-MCP-UAT': uat,
          'X-Lark-MCP-Allowed-Tools': mcpToolName,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000), // 2 min timeout for large docs
      });

      const text = await resp.text();
      if (!resp.ok) {
        return {
          result: {
            content: [{ type: 'text', text: `MCP HTTP ${resp.status}: ${text.slice(0, 4000)}` }],
            isError: true,
          },
        };
      }

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        return {
          result: {
            content: [{ type: 'text', text: `MCP returned non-JSON: ${text.slice(0, 4000)}` }],
            isError: true,
          },
        };
      }

      // Unwrap JSON-RPC result
      const unwrapped = this.unwrapJsonRpc(data);
      if (unwrapped.error) {
        return {
          result: {
            content: [{ type: 'text', text: `MCP error: ${unwrapped.error}` }],
            isError: true,
          },
        };
      }

      // Forward MCP content directly if available
      if (unwrapped.result?.content && Array.isArray(unwrapped.result.content)) {
        return { result: { content: unwrapped.result.content } };
      }

      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(unwrapped.result, null, 2) }],
        },
      };
    } catch (err) {
      return {
        result: {
          content: [{ type: 'text', text: `MCP Doc error: ${(err as Error).message}` }],
          isError: true,
        },
      };
    }
  }

  /** Unwrap nested JSON-RPC envelopes (same as feishu-openclaw shared.js) */
  private unwrapJsonRpc(data: any): { result?: any; error?: string } {
    if (typeof data !== 'object' || data === null) return { result: data };

    if (data.error) {
      const msg = typeof data.error === 'object' ? data.error.message : String(data.error);
      return { error: `${data.error.code ?? ''}: ${msg}` };
    }

    if (data.result !== undefined) {
      // Recursive unwrap
      if (typeof data.result === 'object' && data.result?.jsonrpc) {
        return this.unwrapJsonRpc(data.result);
      }
      return { result: data.result };
    }

    return { result: data };
  }

  // --- Token management ---

  /** Per-user refresh lock: only one refresh at a time */
  private refreshPromise: Promise<string | null> | null = null;

  /**
   * Shared UAT resolution: load -> validate -> refresh -> return string or null.
   * Includes per-user refresh lock to prevent concurrent refresh_token consumption.
   */
  private async resolveUat(): Promise<string | null> {
    const workspace = process.env.MLB_WORKSPACE;
    if (!workspace) {
      console.error('[lark-mcp] MLB_WORKSPACE not set, cannot resolve UAT');
      return null;
    }

    try {
      const { loadTokens, isTokenValid } = await import('./auth/token-store.js');
      const tokens = loadTokens(workspace);

      if (!tokens) {
        console.error('[lark-mcp] no tokens found on disk, user needs /auth');
        return null;
      }

      if (isTokenValid(tokens)) {
        return tokens.user_access_token;
      }

      console.error('[lark-mcp] UAT expired, attempting refresh');

      if (!tokens.refresh_token) {
        console.error('[lark-mcp] no refresh_token available, user needs /auth');
        return null;
      }

      // Per-user refresh lock: all concurrent callers await the same promise.
      // .finally() on the promise itself ensures null-out happens after the promise
      // settles, not after the first awaiter resumes — preventing double-refresh
      // when multiple callers race on the same expired token.
      if (!this.refreshPromise) {
        this.refreshPromise = this.doRefreshToken(workspace, tokens.refresh_token)
          .finally(() => { this.refreshPromise = null; });
      }
      return await this.refreshPromise;
    } catch (err) {
      console.error('[lark-mcp] resolveUat error:', (err as Error).message);
      return null;
    }
  }

  private async doRefreshToken(workspace: string, refreshToken: string): Promise<string | null> {
    try {
      const { refreshUserToken } = await import('./auth/oauth.js');
      const { saveTokens } = await import('./auth/token-store.js');
      const newTokens = await refreshUserToken(
        this.appId, this.appSecret, refreshToken, this.apiBaseUrl
      );
      saveTokens(workspace, newTokens);
      console.error('[lark-mcp] refreshed user_access_token');
      return newTokens.user_access_token;
    } catch (err) {
      const msg = (err as Error).message;
      console.error('[lark-mcp] token refresh failed:', msg);
      // If refresh_token is invalid/consumed, clear stale tokens to stop futile retries
      if (msg.includes('invalid_grant') || msg.includes('20005') || msg.includes('20004') || msg.includes('20038') || msg.includes('20064')) {
        try {
          const { clearTokens } = await import('./auth/token-store.js');
          clearTokens(workspace);
          console.error('[lark-mcp] cleared stale tokens, user needs to re-auth via /auth');
        } catch { /* ignore */ }
      }
      return null;
    }
  }

  /** Force UAT refresh: clear cached promise so next resolveUat() re-reads and refreshes */
  private async forceRefreshUat(): Promise<void> {
    this.refreshPromise = null;
    const workspace = process.env.MLB_WORKSPACE;
    if (!workspace) return;
    try {
      const { loadTokens } = await import('./auth/token-store.js');
      const tokens = loadTokens(workspace);
      if (tokens?.refresh_token) {
        await this.doRefreshToken(workspace, tokens.refresh_token);
      }
    } catch (err) {
      console.error('[lark-mcp] forceRefreshUat failed:', (err as Error).message);
    }
  }

  /**
   * Resolve request options based on token mode.
   *
   * - 'user':   Must use UAT. If not available, throw UserAuthRequiredError.
   * - 'tenant': Use SDK default TAT (return undefined).
   * - 'auto':   Use UAT if available, otherwise TAT.
   */
  private async resolveRequestOptionsForMode(mode: TokenMode): Promise<ReturnType<typeof lark.withUserAccessToken> | undefined> {
    if (mode === 'tenant') {
      return undefined; // SDK default = TAT
    }

    const uat = await this.resolveUat();

    if (mode === 'user' && !uat) {
      throw new UserAuthRequiredError('(per-tool UAT required)');
    }

    return uat ? lark.withUserAccessToken(uat) : undefined;
  }

  /**
   * Returns raw UAT string for MCP Doc relay (needs HTTP header, not SDK opts).
   */
  private async resolveUatForMcpDoc(): Promise<string | null> {
    return this.resolveUat();
  }

  /**
   * Get user's granted scopes from stored token data.
   * Returns null if no token is available (scope check should be skipped).
   */
  private async getUserGrantedScopes(): Promise<Set<string> | null> {
    const workspace = process.env.MLB_WORKSPACE;
    if (!workspace) return null;

    try {
      const { loadTokens } = await import('./auth/token-store.js');
      const tokens = loadTokens(workspace);
      if (!tokens?.scope) return null;
      return new Set(tokens.scope.split(/\s+/).filter(Boolean));
    } catch {
      return null;
    }
  }

  /**
   * Execute a function with automatic retry on transient Feishu errors.
   *
   * Handles:
   * - 429 / 99991400: Rate limit → wait x-ogw-ratelimit-reset seconds, then retry
   * - 99991663: Token expired → refresh token, then retry once
   * - 1500/2200/5000: Server error → exponential backoff retry
   */
  private async withRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= LarkMcpServer.MAX_RETRIES; attempt++) {
      try {
        const result = await fn();
        // SDK typed methods return error responses as resolved values (HTTP 200 + body {code: N})
        // Convert to thrown errors so the retry/error handling below can process them
        if (result && typeof result === 'object' && 'code' in (result as any)) {
          const rc = (result as any).code;
          if (rc !== undefined && rc !== null && rc !== 0) {
            const err = new Error((result as any).msg || `Feishu API error code=${rc}`);
            (err as any).code = rc;
            (err as any).apiResponse = result; // preserve original response for enrichErrorMessage
            throw err;
          }
        }
        return result;
      } catch (err) {
        lastError = err;
        const code = (err as any)?.code ?? (err as any)?.response?.data?.code;
        const status = (err as any)?.response?.status ?? (err as any)?.httpCode;

        // ── Rate limit (429 / 99991400) ──
        if (status === 429 || code === 99991400) {
          if (attempt >= LarkMcpServer.MAX_RETRIES) break;
          const resetHeader = (err as any)?.response?.headers?.['x-ogw-ratelimit-reset'];
          const waitSec = resetHeader ? parseInt(resetHeader, 10) : Math.pow(2, attempt);
          const waitMs = Math.min(waitSec * 1000, 30_000); // cap at 30s
          console.error(`[lark-mcp] rate limited (${context}), retry in ${waitMs}ms (attempt ${attempt + 1}/${LarkMcpServer.MAX_RETRIES})`);
          await this.sleep(waitMs);
          continue;
        }

        // ── Token expired (99991663) — force refresh, then retry once ──
        if (code === 99991663 && attempt === 0) {
          console.error(`[lark-mcp] token expired (${context}), forcing refresh before retry`);
          // Invalidate cached UAT so resolveUat() will re-read and refresh from disk
          await this.forceRefreshUat();
          await this.sleep(300);
          continue; // fn() re-calls resolveRequestOptionsForMode → gets fresh token
        }

        // ── Server errors (1500/2200/5000) — exponential backoff ──
        if (code === 1500 || code === 2200 || code === 5000) {
          if (attempt >= LarkMcpServer.MAX_RETRIES) break;
          const delayMs = LarkMcpServer.DEFAULT_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.error(`[lark-mcp] server error code=${code} (${context}), retry in ${delayMs}ms (attempt ${attempt + 1}/${LarkMcpServer.MAX_RETRIES})`);
          await this.sleep(delayMs);
          continue;
        }

        // ── Non-retriable errors: throw immediately ──
        throw err;
      }
    }

    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Detect Feishu auth error codes and convert to structured errors.
   */
  private detectAuthError(err: unknown, toolName: string, action?: string): Record<string, unknown> | null {
    const code = (err as any)?.code ?? (err as any)?.response?.data?.code;

    if (code === 99991672) {
      // App scope missing — admin must enable on open.feishu.cn
      return new AppScopeMissingError([], this.appId).toToolResult();
    }

    if (code === 99991679) {
      // User scope insufficient — need incremental OAuth
      const requiredScopes = getRequiredScopes(toolName, action);
      return new UserScopeInsufficientError(`${toolName}.${action ?? 'default'}`, requiredScopes).toToolResult();
    }

    if (code === 99991663 || code === 99991668 || code === 99991669 || code === 99991671) {
      // Token expired/invalid/revoked — withRetry attempts refresh for 99991663,
      // but if we reach here, retries were exhausted. Guide user to re-auth.
      return new UserAuthRequiredError(`${toolName}.${action ?? 'default'}`).toToolResult();
    }

    return null;
  }

  /**
   * Map common Feishu error codes to human-readable messages with actionable guidance.
   */
  private enrichErrorMessage(err: unknown): string {
    const code = (err as any)?.code ?? (err as any)?.response?.data?.code;
    const rawMsg = (err as any)?.msg ?? (err as any)?.response?.data?.msg ?? (err as Error).message;

    const ERROR_MAP: Record<number, string> = {
      10002: `Bot is not a member of this chat. The bot must be added to the group before it can send messages or read history. Ask the user to add the bot to the group.`,
      10003: `User is not in the chat. The user must join the group to perform this operation.`,
      99991400: `Rate limit exceeded. This request was throttled by the Feishu API. Wait a moment and retry.`,
      99991663: `Access token expired. Run /auth to re-authorize.`,
      99991668: `Invalid access token. Run /auth to re-authorize.`,
      99991669: `Access token type mismatch. The API requires a different token type.`,
      99991671: `Access token has been revoked. Run /auth to re-authorize.`,
      99991672: `App scope not enabled. The admin must enable the required API scope on the Feishu Open Platform (open.feishu.cn).`,
      99991679: `User scope insufficient. Run /auth to grant additional permissions. Missing scopes will be requested automatically.`,
      1500: `Internal server error from Feishu. This is a transient issue — retry in a few seconds.`,
      2200: `Service temporarily unavailable. Retry in a few seconds.`,
      5000: `Internal error on the Feishu side. Retry in a few seconds.`,
    };

    const friendly = (code !== undefined && code !== null) ? ERROR_MAP[Number(code)] : undefined;
    if (friendly) {
      return `Feishu API Error (code ${code}): ${friendly}\n\nOriginal: ${rawMsg}`;
    }
    return `Error: ${rawMsg}`;
  }
}
