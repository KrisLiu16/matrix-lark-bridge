/**
 * WeChat media bridge — handles inbound media download/decryption and
 * outbound media upload/encryption via the iLink Bot SDK.
 *
 * This module replaces placeholder media handling with real CDN operations:
 *   Inbound:  extract CDN params from WeixinMessage → download → AES decrypt → Buffer
 *   Outbound: Buffer → AES encrypt → CDN upload → UploadedFileInfo for sendMessage
 *
 * Reference:
 * - artifacts/sdk/src/ilink-media.ts — AES-128-ECB primitives, downloadAndDecrypt, uploadMedia
 * - artifacts/sdk/src/ilink-send.ts — sendImageMessage, sendFileMessage (one item per request)
 * - artifacts/weixin-plugin-reference/src/media/media-download.ts — reference download logic
 */

import type { ILinkClient } from '@mlb/wechat-sdk';
import type {
  WeixinMessage,
  MessageItem,
  CDNMedia,
} from '@mlb/wechat-sdk';
import { MessageItemType } from '@mlb/wechat-sdk';
import {
  downloadAndDecrypt,
  downloadPlain,
  uploadImage,
  uploadVideo,
  uploadFile,
  parseAesKey,
} from '@mlb/wechat-sdk';
import type { UploadedFileInfo } from '@mlb/wechat-sdk';
import type { WechatImageAttachment } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default CDN base URL (same as reference implementation). */
const DEFAULT_CDN_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Max media size we're willing to download (100 MB, same as reference). */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Inbound: download + decrypt media from iLink CDN
// ---------------------------------------------------------------------------

/**
 * Resolve the AES key for an image item.
 *
 * Images have two possible key sources (per reference media-download.ts:43-45):
 *   1. image_item.aeskey — hex-encoded raw key (preferred)
 *   2. image_item.media.aes_key — base64-encoded
 *
 * We normalize to base64 for downloadAndDecrypt().
 */
function resolveImageAesKey(
  imageItem: NonNullable<MessageItem['image_item']>,
): string | undefined {
  if (imageItem.aeskey) {
    // hex raw key → convert to base64 for the SDK's parseAesKey
    return Buffer.from(imageItem.aeskey, 'hex').toString('base64');
  }
  return imageItem.media?.aes_key;
}

/**
 * Download and decrypt a single image from an IMAGE MessageItem.
 *
 * Returns the decrypted image buffer, or null if the item lacks CDN params.
 * If aes_key is absent, downloads without decryption (plain CDN).
 */
export async function downloadImageFromItem(
  item: MessageItem,
  cdnBaseUrl: string = DEFAULT_CDN_BASE_URL,
): Promise<Buffer | null> {
  if (item.type !== MessageItemType.IMAGE) return null;

  const img = item.image_item;
  if (!img?.media?.encrypt_query_param) return null;

  const aesKeyBase64 = resolveImageAesKey(img);
  const encryptQueryParam = img.media.encrypt_query_param;

  if (aesKeyBase64) {
    return downloadAndDecrypt(encryptQueryParam, aesKeyBase64, cdnBaseUrl);
  }
  // No AES key — download plain (unencrypted)
  return downloadPlain(encryptQueryParam, cdnBaseUrl);
}

/**
 * Download and decrypt a file from a FILE MessageItem.
 *
 * Returns the decrypted buffer and original filename, or null if missing CDN params.
 */
export async function downloadFileFromItem(
  item: MessageItem,
  cdnBaseUrl: string = DEFAULT_CDN_BASE_URL,
): Promise<{ buffer: Buffer; filename: string } | null> {
  if (item.type !== MessageItemType.FILE) return null;

  const fileItem = item.file_item;
  if (!fileItem?.media?.encrypt_query_param || !fileItem.media.aes_key) {
    return null;
  }

  const buffer = await downloadAndDecrypt(
    fileItem.media.encrypt_query_param,
    fileItem.media.aes_key,
    cdnBaseUrl,
  );

  return {
    buffer,
    filename: fileItem.file_name ?? 'file.bin',
  };
}

/**
 * Download and decrypt a video from a VIDEO MessageItem.
 *
 * Returns the decrypted buffer, or null if missing CDN params.
 */
export async function downloadVideoFromItem(
  item: MessageItem,
  cdnBaseUrl: string = DEFAULT_CDN_BASE_URL,
): Promise<Buffer | null> {
  if (item.type !== MessageItemType.VIDEO) return null;

  const videoItem = item.video_item;
  if (!videoItem?.media?.encrypt_query_param || !videoItem.media.aes_key) {
    return null;
  }

  return downloadAndDecrypt(
    videoItem.media.encrypt_query_param,
    videoItem.media.aes_key,
    cdnBaseUrl,
  );
}

/**
 * Download and decrypt a voice message from a VOICE MessageItem.
 *
 * Returns the decrypted buffer (typically SILK format), or null if missing CDN params.
 */
export async function downloadVoiceFromItem(
  item: MessageItem,
  cdnBaseUrl: string = DEFAULT_CDN_BASE_URL,
): Promise<Buffer | null> {
  if (item.type !== MessageItemType.VOICE) return null;

  const voiceItem = item.voice_item;
  if (!voiceItem?.media?.encrypt_query_param || !voiceItem.media.aes_key) {
    return null;
  }

  return downloadAndDecrypt(
    voiceItem.media.encrypt_query_param,
    voiceItem.media.aes_key,
    cdnBaseUrl,
  );
}

// ---------------------------------------------------------------------------
// High-level inbound handlers (operate on full WeixinMessage)
// ---------------------------------------------------------------------------

/**
 * Extract and download all images from a WeixinMessage.
 *
 * Iterates over item_list, downloads each IMAGE item from CDN,
 * and returns WechatImageAttachment[] ready for bridge consumption.
 *
 * Errors on individual images are logged and skipped (partial success).
 */
export async function handleInboundImages(
  msg: WeixinMessage,
  cdnBaseUrl: string = DEFAULT_CDN_BASE_URL,
): Promise<WechatImageAttachment[]> {
  const items = msg.item_list ?? [];
  const imageItems = items.filter(
    (item) => item.type === MessageItemType.IMAGE,
  );

  if (imageItems.length === 0) return [];

  const results: WechatImageAttachment[] = [];

  for (const item of imageItems) {
    try {
      const buffer = await downloadImageFromItem(item, cdnBaseUrl);
      if (buffer) {
        if (buffer.length > MAX_MEDIA_BYTES) {
          console.warn(
            `[media-bridge] image exceeds max size: ${buffer.length} bytes, skipping`,
          );
          continue;
        }
        results.push({
          mimeType: 'image/jpeg', // iLink images are typically JPEG
          data: buffer,
        });
      }
    } catch (err) {
      console.error(
        `[media-bridge] failed to download image: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return results;
}

/**
 * Extract and download all files from a WeixinMessage.
 *
 * Returns an array of { buffer, filename } for each FILE item.
 */
export async function handleInboundFiles(
  msg: WeixinMessage,
  cdnBaseUrl: string = DEFAULT_CDN_BASE_URL,
): Promise<Array<{ buffer: Buffer; filename: string }>> {
  const items = msg.item_list ?? [];
  const fileItems = items.filter(
    (item) => item.type === MessageItemType.FILE,
  );

  if (fileItems.length === 0) return [];

  const results: Array<{ buffer: Buffer; filename: string }> = [];

  for (const item of fileItems) {
    try {
      const result = await downloadFileFromItem(item, cdnBaseUrl);
      if (result) {
        if (result.buffer.length > MAX_MEDIA_BYTES) {
          console.warn(
            `[media-bridge] file exceeds max size: ${result.buffer.length} bytes, skipping ${result.filename}`,
          );
          continue;
        }
        results.push(result);
      }
    } catch (err) {
      console.error(
        `[media-bridge] failed to download file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Outbound: encrypt + upload media to iLink CDN
// ---------------------------------------------------------------------------

/**
 * Upload an image buffer to CDN for sending via iLink.
 *
 * Uses the SDK's uploadImage which handles:
 *   1. Generate filekey + AES key
 *   2. Compute sizes/MD5
 *   3. Call getUploadUrl API
 *   4. AES-128-ECB encrypt + upload to CDN
 *   5. Return UploadedFileInfo with downloadEncryptedQueryParam
 */
export async function uploadImageForSend(params: {
  client: ILinkClient;
  data: Buffer;
  toUserId: string;
  cdnBaseUrl?: string;
}): Promise<UploadedFileInfo> {
  return uploadImage({
    client: params.client,
    buf: params.data,
    toUserId: params.toUserId,
    cdnBaseUrl: params.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
  });
}

/**
 * Upload a video buffer to CDN for sending via iLink.
 */
export async function uploadVideoForSend(params: {
  client: ILinkClient;
  data: Buffer;
  toUserId: string;
  cdnBaseUrl?: string;
}): Promise<UploadedFileInfo> {
  return uploadVideo({
    client: params.client,
    buf: params.data,
    toUserId: params.toUserId,
    cdnBaseUrl: params.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
  });
}

/**
 * Upload a file buffer to CDN for sending via iLink.
 */
export async function uploadFileForSend(params: {
  client: ILinkClient;
  data: Buffer;
  toUserId: string;
  cdnBaseUrl?: string;
}): Promise<UploadedFileInfo> {
  return uploadFile({
    client: params.client,
    buf: params.data,
    toUserId: params.toUserId,
    cdnBaseUrl: params.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
  });
}

// Re-export UploadedFileInfo for convenience
export type { UploadedFileInfo };
