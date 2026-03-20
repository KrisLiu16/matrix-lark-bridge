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

      const opts = await this.resolveRequestOptionsForMode(tokenMode);
      const result = await this.sdkClient.request({
        method: method as any,
        url: path,
        data: body,
        params: queryParams,
      }, opts);
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
      return { result: { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true } };
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

      const opts = await this.resolveRequestOptionsForMode(tokenMode);
      const result = await executeOapiTool(this.sdkClient, toolName, args, opts);
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
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
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
    if (!workspace) return null;

    try {
      const { loadTokens, isTokenValid } = await import('./auth/token-store.js');
      const tokens = loadTokens(workspace);
      if (tokens) {
        if (isTokenValid(tokens)) {
          return tokens.user_access_token;
        }
        if (tokens.refresh_token) {
          // Per-user refresh lock: only one refresh at a time
          if (this.refreshPromise) {
            console.error('[lark-mcp] waiting for concurrent refresh to complete');
            return this.refreshPromise;
          }

          this.refreshPromise = this.doRefreshToken(workspace, tokens.refresh_token);
          try {
            return await this.refreshPromise;
          } finally {
            this.refreshPromise = null;
          }
        }
      }
    } catch { /* no user token */ }

    return null;
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
      console.error('[lark-mcp] token refresh failed:', (err as Error).message);
      return null;
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

    if (code === 99991668 || code === 99991669 || code === 99991671) {
      // Token expired/invalid — need re-auth
      return new UserAuthRequiredError(`${toolName}.${action ?? 'default'}`).toToolResult();
    }

    return null;
  }
}
