/**
 * MCP Structured Errors — typed error classes for clean error handling.
 *
 * These errors are caught by MCP server and serialized as structured tool results,
 * enabling the gateway layer to detect and auto-handle authorization issues.
 */

/** Base class for all MLB MCP errors. */
export abstract class MlbMcpError extends Error {
  abstract readonly errorType: string;

  /** Serialize to a structured JSON object for tool result. */
  toToolResult(): Record<string, unknown> {
    return {
      error_type: this.errorType,
      message: this.message,
    };
  }
}

/**
 * User has not authorized or token does not exist.
 * Gateway should trigger OAuth flow.
 */
export class UserAuthRequiredError extends MlbMcpError {
  readonly errorType = 'user_auth_required';
  readonly toolAction: string;
  readonly requiredScopes: string[];

  constructor(toolAction: string, requiredScopes: string[] = []) {
    super(`用户未授权或授权已过期。需要执行 /auth 完成飞书 OAuth 授权。`);
    this.name = 'UserAuthRequiredError';
    this.toolAction = toolAction;
    this.requiredScopes = requiredScopes;
  }

  toToolResult() {
    return {
      ...super.toToolResult(),
      tool_action: this.toolAction,
      required_scopes: this.requiredScopes,
    };
  }
}

/**
 * User token exists but scope is insufficient for the requested API.
 * Gateway should trigger incremental OAuth with missing scopes.
 */
export class UserScopeInsufficientError extends MlbMcpError {
  readonly errorType = 'user_scope_insufficient';
  readonly toolAction: string;
  readonly missingScopes: string[];

  constructor(toolAction: string, missingScopes: string[]) {
    super(`用户授权的权限不足，缺少: ${missingScopes.join(', ')}`);
    this.name = 'UserScopeInsufficientError';
    this.toolAction = toolAction;
    this.missingScopes = missingScopes;
  }

  toToolResult() {
    return {
      ...super.toToolResult(),
      tool_action: this.toolAction,
      missing_scopes: this.missingScopes,
    };
  }
}

/**
 * The Feishu application has not been granted the required scope by the admin.
 * Cannot be resolved by user OAuth — admin must enable the scope on open.feishu.cn.
 */
export class AppScopeMissingError extends MlbMcpError {
  readonly errorType = 'app_scope_missing';
  readonly missingScopes: string[];
  readonly appId: string;

  constructor(missingScopes: string[], appId: string) {
    super(`应用未开通所需权限: ${missingScopes.join(', ')}。请管理员在飞书开放平台开通。`);
    this.name = 'AppScopeMissingError';
    this.missingScopes = missingScopes;
    this.appId = appId;
  }

  toToolResult() {
    return {
      ...super.toToolResult(),
      missing_scopes: this.missingScopes,
      permission_url: `https://open.feishu.cn/app/${this.appId}/auth`,
    };
  }
}
