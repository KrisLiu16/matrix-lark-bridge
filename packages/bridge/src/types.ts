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

// --- MCP Server config ---

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
