// Bridge-internal types (not shared with Manager)

import type { StepInfo, SessionState } from '@mlb/shared';

// Re-export shared types used by bridge modules
export type { StepInfo, SessionState };

// --- Agent event types ---

export type EventType =
  | 'text'
  | 'tool_use'
  | 'result'
  | 'error'
  | 'permission_request'
  | 'permission_cancel'
  | 'thinking';

export interface AgentEvent {
  type: EventType;
  content?: string;
  toolName?: string;
  toolInput?: string;
  toolInputRaw?: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
  isError?: boolean;
  /** Token usage from result event */
  usage?: TokenUsage;
  totalCostUsd?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

// --- Permission ---

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

// --- Image attachment ---

export interface ImageAttachment {
  mimeType: string;
  data: Buffer;
  fileName?: string;
}

// --- Sender info (from Feishu message event) ---

export interface SenderInfo {
  openId: string;
  name?: string;
  chatType: 'p2p' | 'group';
}

// --- MCP Server config ---

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
