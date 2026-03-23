// Bridge-internal types for WeChat channel (parallel to feishu types in bridge-source/types.ts)

import type {
  WeixinMessage,
  MessageItem,
  StatusResponse,
} from '@mlb/wechat-sdk';

// Re-export SDK types used by bridge modules
export type { WeixinMessage, MessageItem };

// Re-export shared types — single source of truth (no local duplicates)
export type { WechatChannelState, WechatConfig } from '@mlb/shared';

// ---------------------------------------------------------------------------
// Sender info (from WeChat message event — parallel to SenderInfo in types.ts)
// ---------------------------------------------------------------------------

/** WeChat sender info, analogous to Feishu SenderInfo. */
export interface WechatSenderInfo {
  /** iLink user ID of the message sender. */
  userId: string;
  /** Sender nickname (if available from message metadata). */
  nickname?: string;
  /** Chat type — iLink currently only supports direct (p2p). */
  chatType: 'direct';
}

// ---------------------------------------------------------------------------
// Channel message (bridge-internal, parallel to Feishu message handling)
// ---------------------------------------------------------------------------

/** Bridge-internal WeChat message, normalized from iLink WeixinMessage. */
export interface WechatChannelMessage {
  /** Unique message ID from iLink (WeixinMessage.message_id). */
  messageId: number;
  /** Sender info extracted from the message. */
  sender: WechatSenderInfo;
  /** Text content (extracted from TEXT item). */
  text?: string;
  /** Image attachments (downloaded and decrypted from CDN). */
  images?: WechatImageAttachment[];
  /** Context token — MUST be echoed back in replies. */
  contextToken: string;
  /** Original iLink session ID. */
  sessionId?: string;
  /** Message creation timestamp (ms). */
  createTimeMs?: number;
  /** Raw iLink message for pass-through if needed. */
  raw: WeixinMessage;
}

/** Decrypted image from WeChat CDN, analogous to ImageAttachment in types.ts. */
export interface WechatImageAttachment {
  /** MIME type (e.g., "image/jpeg"). */
  mimeType: string;
  /** Decrypted image data. */
  data: Buffer;
  /** Original filename if available. */
  fileName?: string;
}

// ---------------------------------------------------------------------------
// Auth binding (WeChat userId ↔ Feishu open_id)
// ---------------------------------------------------------------------------

/** Binding between WeChat user and Feishu identity for /auth command. */
export interface WechatFeishuBinding {
  /** WeChat iLink user ID. */
  wechatUserId: string;
  /** Feishu open_id after OAuth authorization. */
  feishuOpenId: string;
  /** Feishu user access token (for API calls on behalf of user). */
  feishuUserToken?: string;
  /** Feishu refresh token (for renewing expired access tokens). */
  refreshToken?: string;
  /** Token expiry (ISO-8601). */
  tokenExpiry?: string;
  /** When the binding was created (ISO-8601). */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Session mapping (WeChat userId → CC session)
// ---------------------------------------------------------------------------

/** Maps a WeChat user to their Claude Code session, parallel to Feishu chat-based sessions. */
export interface WechatSessionMapping {
  /** WeChat iLink user ID (key). */
  wechatUserId: string;
  /** Claude Code agent session ID. */
  agentSessionId?: string;
  /** Associated Feishu chat ID if /auth binding exists. */
  feishuChatId?: string;
  /** Last activity timestamp (ISO-8601). */
  lastActivity: string;
}
