/**
 * wechat-types — GUI 与后端共享的微信通道类型定义
 *
 * 单一真相来源，所有 GUI 文件从此处 import。
 * 每个类型均标注对应的后端定义位置，确保双端一致。
 *
 * 后端类型参考：
 *   - packages/bridge/src/wechat/types.ts    → WechatChannelState, WechatConfig
 *   - packages/wechat-sdk/src/ilink-types.ts → MessageItemType, StatusResponse
 */

// ---------------------------------------------------------------------------
// Connection status
// Maps to: bridge/src/wechat/types.ts → WechatChannelState
//          + SDK StatusResponse.status ('scaned' → 'scanned')
// ---------------------------------------------------------------------------

/**
 * GUI connection status — superset of backend WechatChannelState.
 *
 * Mapping:
 *   GUI 'disconnected'  ↔ backend 'disconnected'
 *   GUI 'scanning'      ↔ backend 'scanning'
 *   GUI 'scanned'       ↔ SDK StatusResponse.status === 'scaned' (intermediate UI state)
 *   GUI 'connected'     ↔ backend 'connected'
 *   GUI 'reconnecting'  ↔ backend 'reconnecting'
 *   GUI 'expired'       ↔ backend 'expired' (session expired, needs re-scan)
 */
export type ConnectionStatus =
  | 'disconnected'
  | 'scanning'
  | 'scanned'       // SDK 中间态: 用户已扫码但未确认
  | 'connected'
  | 'reconnecting'
  | 'expired';       // 对应 backend WechatChannelState.'expired'

// ---------------------------------------------------------------------------
// Bot info
// Maps to: bridge/src/wechat/types.ts → WechatConfig.ilink_bot_id
//          SDK StatusResponse → ilink_bot_id, ilink_user_id
// ---------------------------------------------------------------------------

export interface BotInfo {
  /** iLink Bot ID. 对应 backend WechatConfig.ilink_bot_id */
  ilinkBotId: string;
  /** iLink User ID. 对应 SDK StatusResponse.ilink_user_id */
  userId?: string;
  /** 微信号（wxid），扫码用户的微信 ID */
  wxid?: string;
  /** 用户昵称（从消息元数据获取） */
  nickname?: string;
}

// ---------------------------------------------------------------------------
// Message item types
// Maps to: sdk/src/ilink-types.ts → MessageItemType
// ---------------------------------------------------------------------------

/** 消息类型枚举，与 SDK MessageItemType 保持一致 */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export type MessageItemTypeValue = (typeof MessageItemType)[keyof typeof MessageItemType];

/** 消息类型中文标签 */
export const MSG_TYPE_LABELS: Record<number, string> = {
  [MessageItemType.TEXT]: '文本',
  [MessageItemType.IMAGE]: '图片',
  [MessageItemType.VOICE]: '语音',
  [MessageItemType.FILE]: '文件',
  [MessageItemType.VIDEO]: '视频',
};

// ---------------------------------------------------------------------------
// Activity entry
// Maps to: wechat-ipc.ts → ActivityEntry (IPC main→renderer)
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  id: string;
  time: number;
  direction: 'inbound' | 'outbound';
  senderName: string;
  /** MessageItemType value: 1=text,2=image,3=voice,4=file,5=video */
  msgType: number;
  preview: string;
  error?: boolean;
}

// ---------------------------------------------------------------------------
// Message stats
// ---------------------------------------------------------------------------

export interface MessageStats {
  received: number;
  sent: number;
}

// ---------------------------------------------------------------------------
// Status payload (IPC: main→renderer)
// ---------------------------------------------------------------------------

export interface StatusPayload {
  status: ConnectionStatus;
  bot?: BotInfo;
  error?: string;
  qrcodeUrl?: string;
  /** QR 刷新次数 (0-based) */
  refreshCount?: number;
  /** Epoch ms: 最近成功心跳 */
  lastHeartbeat?: number;
  /** Epoch ms: 连接建立时间 */
  connectedSince?: number;
  /** 今日消息统计 */
  stats?: MessageStats;
  /** 最近活动条目（最多 20 条） */
  activity?: ActivityEntry[];
}

// ---------------------------------------------------------------------------
// Log entry (renderer-only UI state)
// ---------------------------------------------------------------------------

export interface LogEntry {
  time: string;
  text: string;
  level: 'info' | 'warn' | 'error';
}
