/**
 * WeChat message adapter — converts between iLink protocol messages and
 * bridge-internal message types.
 *
 * Parallel to how feishu.ts extracts text/images from Feishu messages and
 * constructs reply payloads. Uses the same bridge-internal types
 * (ImageAttachment, SenderInfo pattern) so gateway can treat WeChat and
 * Feishu messages uniformly.
 *
 * Reference:
 * - artifacts/bridge-source/feishu.ts — Feishu message extraction pattern
 * - artifacts/weixin-plugin-reference/src/messaging/inbound.ts — iLink inbound handling
 * - artifacts/sdk/src/ilink-send.ts — outbound message construction
 */

import type {
  WeixinMessage,
  MessageItem,
  SendMessageReq,
} from '@mlb/wechat-sdk';
import {
  MessageType,
  MessageState,
  MessageItemType,
} from '@mlb/wechat-sdk';
import type {
  WechatChannelMessage,
  WechatSenderInfo,
  WechatImageAttachment,
} from './types.js';

// ---------------------------------------------------------------------------
// Context token store (in-process cache: userId → contextToken)
// ---------------------------------------------------------------------------

/**
 * context_token is issued per-message by the iLink getupdates API and must
 * be echoed verbatim in every outbound send. Not persisted — the monitor
 * loop populates this map on each inbound message, and the outbound adapter
 * reads it back when sending a reply.
 *
 * Mirrors weixin-plugin-reference/src/messaging/inbound.ts contextTokenStore.
 */
const contextTokenStore = new Map<string, string>();

/** Store a context token for a user. */
export function setContextToken(userId: string, token: string): void {
  contextTokenStore.set(userId, token);
}

/** Retrieve the cached context token for a user. */
export function getContextToken(userId: string): string | undefined {
  return contextTokenStore.get(userId);
}

// ---------------------------------------------------------------------------
// Stale message detection
// ---------------------------------------------------------------------------

/** Messages older than this are silently dropped (same 10-min threshold as feishu.ts). */
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

/** Returns true if the message is too old to process. */
export function isStaleMessage(msg: WeixinMessage): boolean {
  if (!msg.create_time_ms) return false;
  return Date.now() - msg.create_time_ms > STALE_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// Inbound: WeixinMessage → WechatChannelMessage
// ---------------------------------------------------------------------------

/**
 * Extract text body from iLink message item_list.
 *
 * Priority: TEXT items joined by newline. If a TEXT item has a ref_msg with
 * media, only the text is used (quoted media is handled separately).
 * Voice items with text (voice-to-text) are included as fallback.
 *
 * Mirrors inbound.ts bodyFromItemList logic.
 */
function extractTextFromItems(items?: MessageItem[]): string {
  if (!items?.length) return '';

  const parts: string[] = [];
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) {
        parts.push(text);
        continue;
      }
      // If quoted message is media, just use the current text
      if (ref.message_item && isMediaItem(ref.message_item)) {
        parts.push(text);
        continue;
      }
      // Build quoted context
      const refParts: string[] = [];
      if (ref.title) refParts.push(ref.title);
      if (ref.message_item) {
        const refBody = extractTextFromItems([ref.message_item]);
        if (refBody) refParts.push(refBody);
      }
      if (refParts.length > 0) {
        parts.push(`[引用: ${refParts.join(' | ')}]\n${text}`);
      } else {
        parts.push(text);
      }
    }
    // Voice-to-text fallback
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      parts.push(`[语音转文字] ${item.voice_item.text}`);
    }
  }
  return parts.join('\n');
}

/** Returns true if the item is a media type (image, video, file, voice). */
function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

/**
 * Detect content types present in item_list.
 * Returns a set of MessageItemType values found.
 */
export function detectContentTypes(items?: MessageItem[]): Set<number> {
  const types = new Set<number>();
  if (!items?.length) return types;
  for (const item of items) {
    if (item.type != null) types.add(item.type);
  }
  return types;
}

/**
 * Check if a WeixinMessage is from the bot itself.
 * Bot messages have message_type = BOT (2). User messages have message_type = USER (1).
 */
export function isBotMessage(msg: WeixinMessage): boolean {
  return msg.message_type === MessageType.BOT;
}

/**
 * Convert a WeixinMessage from getupdates to a bridge-internal WechatChannelMessage.
 *
 * This is the inbound adapter — parallel to feishu.ts onMessage() which extracts
 * text content and image buffers from Feishu messages.
 *
 * Note: Image download/decryption is NOT done here — that requires async CDN
 * operations. The caller (wechat-channel.ts) should handle image download
 * separately and attach decrypted images to the returned message.
 * This function only extracts metadata about images present.
 *
 * @param msg - Raw iLink message from getupdates
 * @returns Bridge-internal message, or null if the message should be skipped
 */
export function iLinkMessageToBridgeMessage(
  msg: WeixinMessage,
): WechatChannelMessage | null {
  // Skip bot's own messages
  if (isBotMessage(msg)) return null;

  // Skip stale messages
  if (isStaleMessage(msg)) {
    console.log(
      `[wechat-adapter] dropping stale message: age=${Math.round((Date.now() - (msg.create_time_ms ?? 0)) / 1000)}s`,
    );
    return null;
  }

  // Extract text content
  const text = extractTextFromItems(msg.item_list);

  // Detect image items (metadata only — actual download is done by caller)
  const imageItems = (msg.item_list ?? []).filter(
    (item) => item.type === MessageItemType.IMAGE,
  );

  // Must have content (text or images) to be worth processing
  if (!text.trim() && imageItems.length === 0) return null;

  // Build sender info
  const sender: WechatSenderInfo = {
    userId: msg.from_user_id ?? '',
    chatType: 'direct',
  };

  // Cache context_token for outbound replies
  if (msg.context_token && sender.userId) {
    setContextToken(sender.userId, msg.context_token);
  }

  const result: WechatChannelMessage = {
    messageId: msg.message_id ?? 0,
    sender,
    contextToken: msg.context_token ?? '',
    sessionId: msg.session_id,
    createTimeMs: msg.create_time_ms,
    raw: msg,
  };

  if (text.trim()) {
    result.text = text.trim();
  }

  // Note: images array is left undefined here. The caller must:
  // 1. Check imageItems for IMAGE items
  // 2. Download from CDN using ilink-media.ts
  // 3. Attach decrypted buffers to result.images

  return result;
}

/**
 * Extract image item metadata from a WeixinMessage for CDN download.
 * Returns items with type=IMAGE that have media info for download.
 */
export function extractImageItems(msg: WeixinMessage): MessageItem[] {
  return (msg.item_list ?? []).filter(
    (item) =>
      item.type === MessageItemType.IMAGE &&
      (item.image_item?.media?.encrypt_query_param || item.image_item?.aeskey),
  );
}

/**
 * Extract file item metadata from a WeixinMessage.
 */
export function extractFileItems(msg: WeixinMessage): MessageItem[] {
  return (msg.item_list ?? []).filter(
    (item) => item.type === MessageItemType.FILE && item.file_item?.media,
  );
}

// ---------------------------------------------------------------------------
// Outbound: Bridge reply → iLink SendMessageReq
// ---------------------------------------------------------------------------

/**
 * Build a SendMessageReq with exactly one item in item_list.
 *
 * This is the foundational building block for all outbound message construction.
 * The iLink protocol requires each sendmessage call to carry exactly one item
 * in item_list. Multi-part replies (e.g., text caption + image) must be split
 * into multiple requests, each built by this function.
 *
 * Reference: weixin-plugin-reference/src/messaging/send.ts sendMediaItems()
 * iterates over items and builds a fresh request per item.
 */
function buildSingleItemReq(
  to: string,
  contextToken: string,
  item: MessageItem,
): SendMessageReq {
  return {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: `bridge-wx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [item],
      context_token: contextToken,
    },
  };
}

/**
 * Build a SendMessageReq for a text reply.
 *
 * Enforces protocol invariants (same as ilink-send.ts buildSendReq):
 * - from_user_id = "" (always empty for bot replies)
 * - message_type = BOT (2)
 * - message_state = FINISH (2, but we use the enum which is correct at 1 for GENERATING or 2 for FINISH)
 *
 * @param to - Recipient user ID
 * @param text - Reply text content
 * @param contextToken - MUST be provided from the inbound message
 * @throws If contextToken is missing
 */
export function buildTextReply(
  to: string,
  text: string,
  contextToken: string,
): SendMessageReq {
  if (!contextToken) {
    throw new Error('buildTextReply: contextToken is required');
  }
  return {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: `bridge-wx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text },
        },
      ],
      context_token: contextToken,
    },
  };
}

/**
 * Build SendMessageReq(s) for an image reply with CDN-uploaded media.
 *
 * The caller must first upload the image via ilink-media.ts and provide
 * the CDN metadata (encrypt_query_param, aes_key).
 *
 * Returns an array of requests — one per item — because the iLink protocol
 * requires each item_list to contain exactly one item. If a caption is
 * provided, it is sent as a separate TEXT request before the IMAGE request.
 *
 * Reference: weixin-plugin-reference/src/messaging/send.ts sendMediaItems()
 * and sdk/src/ilink-send.ts sendImageMessage() — both send one item per request.
 *
 * @param to - Recipient user ID
 * @param cdnParams - CDN media reference from upload
 * @param contextToken - MUST be provided from the inbound message
 * @param caption - Optional text caption sent as a separate request
 * @throws If contextToken is missing
 */
export function buildImageReply(
  to: string,
  cdnParams: {
    encryptQueryParam: string;
    aesKeyBase64: string;
    fileSizeCiphertext?: number;
  },
  contextToken: string,
  caption?: string,
): SendMessageReq[] {
  if (!contextToken) {
    throw new Error('buildImageReply: contextToken is required');
  }

  const requests: SendMessageReq[] = [];

  // Caption as a separate TEXT request (one item per request invariant)
  if (caption) {
    requests.push(buildSingleItemReq(to, contextToken, {
      type: MessageItemType.TEXT,
      text_item: { text: caption },
    }));
  }

  // Image as its own request
  requests.push(buildSingleItemReq(to, contextToken, {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: cdnParams.encryptQueryParam,
        aes_key: cdnParams.aesKeyBase64,
        encrypt_type: 1,
      },
      mid_size: cdnParams.fileSizeCiphertext,
    },
  }));

  return requests;
}

/**
 * Convert bridge-internal reply data to an array of SendMessageReq, each
 * containing exactly one item — enforcing the iLink protocol invariant.
 *
 * This is the reverse path: bridge produces text + optional images as reply,
 * and we build one SendMessageReq per item for sequential sending.
 *
 * For text-only replies, returns a single-element array with the TEXT request.
 * For image replies, returns one request per image (caller must upload to CDN first).
 * If both text and images are present, text is sent first, then each image.
 *
 * @param to - Recipient user ID
 * @param contextToken - MUST be provided from the inbound message
 * @param reply - Bridge reply containing text and/or image CDN metadata
 * @throws If contextToken is missing
 */
export function bridgeReplyToSendRequests(
  to: string,
  contextToken: string,
  reply: {
    text?: string;
    imageItems?: Array<{
      encryptQueryParam: string;
      aesKeyBase64: string;
      fileSizeCiphertext?: number;
    }>;
  },
): SendMessageReq[] {
  if (!contextToken) {
    throw new Error('bridgeReplyToSendRequests: contextToken is required');
  }

  const requests: SendMessageReq[] = [];

  if (reply.text) {
    requests.push(buildSingleItemReq(to, contextToken, {
      type: MessageItemType.TEXT,
      text_item: { text: reply.text },
    }));
  }

  if (reply.imageItems) {
    for (const img of reply.imageItems) {
      requests.push(buildSingleItemReq(to, contextToken, {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: img.encryptQueryParam,
            aes_key: img.aesKeyBase64,
            encrypt_type: 1,
          },
          mid_size: img.fileSizeCiphertext,
        },
      }));
    }
  }

  return requests;
}

// ---------------------------------------------------------------------------
// Convenience: format bridge text for WeChat display
// ---------------------------------------------------------------------------

/**
 * Truncate text to a max length suitable for WeChat messages.
 * WeChat has no official text length limit in iLink, but very long messages
 * may cause display issues.
 */
export function truncateForWechat(text: string, maxLen = 4000): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '\n...(已截断)';
}

/**
 * Format a content type label for display (e.g., in "[图片]" placeholders).
 */
export function contentTypeLabel(type: number): string {
  switch (type) {
    case MessageItemType.TEXT: return '文本';
    case MessageItemType.IMAGE: return '图片';
    case MessageItemType.VOICE: return '语音';
    case MessageItemType.FILE: return '文件';
    case MessageItemType.VIDEO: return '视频';
    default: return '未知';
  }
}
