/**
 * @mlb/wechat-sdk — Standalone WeChat iLink Bot SDK.
 *
 * Independent of OpenClaw framework. Uses iLink Bot API directly.
 */

// Types
export type {
  BaseInfo,
  WeixinMessage,
  MessageItem,
  TextItem,
  ImageItem,
  VoiceItem,
  FileItem,
  VideoItem,
  CDNMedia,
  RefMessage,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendMessageResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  SendTypingReq,
  SendTypingResp,
  GetConfigResp,
  QRCodeResponse,
  StatusResponse,
  UploadMediaTypeValue,
} from "./ilink-types.js";

export {
  UploadMediaType,
  MessageType,
  MessageItemType,
  MessageState,
  TypingStatus,
} from "./ilink-types.js";

// Client
export { ILinkClient } from "./ilink-client.js";
export type { ILinkClientOptions } from "./ilink-client.js";

// Auth
export { ILinkAuth } from "./ilink-auth.js";
export type { QrLoginResult, QrStatusCallback } from "./ilink-auth.js";

// Media
export {
  encryptAesEcb,
  decryptAesEcb,
  aesEcbPaddedSize,
  parseAesKey,
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  downloadAndDecrypt,
  downloadPlain,
  uploadMedia,
  uploadImage,
  uploadVideo,
  uploadFile,
} from "./ilink-media.js";
export type { UploadedFileInfo } from "./ilink-media.js";

// Monitor
export { ILinkMonitor } from "./ilink-monitor.js";
export type { MonitorEvents, MonitorStatus, MonitorOptions } from "./ilink-monitor.js";

// Send helpers
export {
  sendTextMessage,
  sendImageMessage,
  sendVideoMessage,
  sendFileMessage,
  sendMediaFile,
} from "./ilink-send.js";
export type {
  SendParams,
  SendMediaParams,
  SendFileParams,
  SendMediaFileParams,
} from "./ilink-send.js";
