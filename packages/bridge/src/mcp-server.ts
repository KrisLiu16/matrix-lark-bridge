import { createInterface } from 'node:readline';

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TOOL_DEFINITION = {
  name: 'lark_api',
  description: `Call any Feishu/Lark Open API. The app's access token is automatically added.

Common APIs:
- GET /open-apis/docx/v1/documents/:id/raw_content — Read document content
- GET /open-apis/search/v2/app?query=xxx — Search documents
- GET /open-apis/sheets/v2/spreadsheets/:token/values/:range — Read spreadsheet
- GET /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records — Read bitable records
- POST /open-apis/im/v1/messages — Send message

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
        description: 'API path, e.g. /open-apis/docx/v1/documents/:id/raw_content',
      },
      body: {
        type: 'object',
        description: 'JSON body for POST/PUT/PATCH requests (optional)',
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

export class LarkMcpServer {
  private appId: string;
  private appSecret: string;
  private apiBaseUrl: string;
  private cachedToken = '';
  private tokenExpiry = 0;

  constructor(appId: string, appSecret: string, apiBaseUrl = 'https://open.feishu.cn') {
    this.appId = appId;
    this.appSecret = appSecret;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
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
            serverInfo: { name: 'lark', version: '1.0.0' },
          },
        };

      case 'notifications/initialized':
        return { result: {} };

      case 'tools/list':
        return { result: { tools: [TOOL_DEFINITION] } };

      case 'tools/call':
        return this.handleToolCall(req.params as Record<string, unknown>);

      default:
        return { error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  }

  private async handleToolCall(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const toolName = params?.name as string;
    if (toolName !== 'lark_api') {
      return { error: { code: -32602, message: `Unknown tool: ${toolName}` } };
    }

    const args = (params?.arguments || {}) as Record<string, unknown>;
    const method = (args.method as string || 'GET').toUpperCase();
    const path = args.path as string;
    const body = args.body as Record<string, unknown> | undefined;
    const queryParams = args.params as Record<string, string> | undefined;

    if (!path) {
      return {
        result: {
          content: [{ type: 'text', text: 'Error: path is required' }],
          isError: true,
        },
      };
    }

    // Audit log: record every API call for security visibility
    console.error(`[lark-mcp] API call: ${method} ${path}${body ? ' (with body)' : ''}`);

    try {
      const token = await this.resolveToken();
      const url = new URL(`${this.apiBaseUrl}${path}`);
      if (queryParams) {
        for (const [k, v] of Object.entries(queryParams)) {
          url.searchParams.set(k, v);
        }
      }

      const fetchOpts: RequestInit = {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
      };

      if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        fetchOpts.body = JSON.stringify(body);
      }

      const resp = await fetch(url.toString(), fetchOpts);
      const text = await resp.text();

      // Check for token expiration and retry
      let resultText = text;
      try {
        const json = JSON.parse(text);
        const code = json?.code;
        if ([99991663, 99991664, 99991668, 99991677].includes(code) || resp.status === 401) {
          console.error(`[lark-mcp] token rejected (code=${code}), retrying with fresh token`);
          this.cachedToken = '';
          this.tokenExpiry = 0;
          const freshToken = await this.resolveToken();
          const retryOpts = {
            ...fetchOpts,
            headers: { ...fetchOpts.headers as Record<string, string>, 'Authorization': `Bearer ${freshToken}` },
          };
          const retryResp = await fetch(url.toString(), retryOpts);
          resultText = await retryResp.text();
        }
      } catch { /* not JSON, use as-is */ }

      return {
        result: {
          content: [{ type: 'text', text: resultText }],
        },
      };
    } catch (err) {
      return {
        result: {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        },
      };
    }
  }

  private async resolveToken(): Promise<string> {
    // Return cached token if still valid
    if (this.cachedToken && Date.now() < this.tokenExpiry) {
      return this.cachedToken;
    }

    // Fetch new tenant token
    try {
      const resp = await fetch(
        `${this.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
          signal: AbortSignal.timeout(5000),
        },
      );
      const data = (await resp.json()) as { tenant_access_token?: string; expire?: number };
      const token = data.tenant_access_token;
      if (!token) {
        throw new Error('Failed to get tenant_access_token');
      }

      this.cachedToken = token;
      // Expire 100s before actual expiry (default 2h = 7200s)
      this.tokenExpiry = Date.now() + ((data.expire || 7200) - 100) * 1000;
      return token;
    } catch (err) {
      console.error(`[lark-mcp] resolveToken failed:`, (err as Error).message);
      throw new Error(`Token fetch failed: ${(err as Error).message}`);
    }
  }
}
