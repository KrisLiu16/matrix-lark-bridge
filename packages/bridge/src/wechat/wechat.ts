/**
 * WeChat Channel — iLink Bot integration for matrix-lark-bridge.
 *
 * Parallel to FeishuClient in bridge-source/feishu.ts.
 * Manages the full lifecycle: QR login → long-poll → message routing → reply.
 */
import type { ILinkClient } from '@mlb/wechat-sdk';
import type { ILinkAuth, QrLoginResult, QrStatusCallback } from '@mlb/wechat-sdk';
import type { ILinkMonitor, MonitorStatus } from '@mlb/wechat-sdk';
import type { WeixinMessage } from '@mlb/wechat-sdk';
import { MessageItemType } from '@mlb/wechat-sdk';
import type {
  WechatConfig,
  WechatChannelState,
  WechatChannelMessage,
} from './types.js';
import { iLinkMessageToBridgeMessage, detectContentTypes } from './message-adapter.js';
import {
  handleInboundImages,
  handleInboundFiles,
  downloadVideoFromItem,
  downloadVoiceFromItem,
  uploadImageForSend,
  uploadFileForSend,
} from './media-bridge.js';

// ---------------------------------------------------------------------------
// Callback interfaces
// ---------------------------------------------------------------------------

/** Callbacks from WechatChannel to the gateway layer. */
export interface WechatChannelCallbacks {
  /** Called when a user message is received (after filtering & normalization). */
  onMessage(msg: WechatChannelMessage): void;
  /** Called when channel state changes (for GUI status display). */
  onStateChange(state: WechatChannelState): void;
  /** Called on errors (for logging / alerting). */
  onError(err: Error): void;
}

// ---------------------------------------------------------------------------
// WechatChannel
// ---------------------------------------------------------------------------

export class WechatChannel {
  private client: ILinkClient;
  private auth: ILinkAuth;
  private monitor: ILinkMonitor | null = null;
  private config: WechatConfig;
  private callbacks: WechatChannelCallbacks;
  private state: WechatChannelState = 'disconnected';

  constructor(
    client: ILinkClient,
    auth: ILinkAuth,
    config: WechatConfig,
    callbacks: WechatChannelCallbacks,
  ) {
    this.client = client;
    this.auth = auth;
    this.config = config;
    this.callbacks = callbacks;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the channel.
   * - If bot_token exists → start long-polling immediately.
   * - Otherwise → initiate QR scan flow.
   */
  async start(): Promise<void> {
    if (this.config.bot_token) {
      this.client.setToken(this.config.bot_token);
      await this.startMonitor();
    } else {
      await this.startQrLogin();
    }
  }

  /** Stop the monitor and disconnect. */
  async stop(): Promise<void> {
    if (this.monitor) {
      this.monitor.stop();
      this.monitor = null;
    }
    this.setState('disconnected');
    console.log('[wechat] stopped');
  }

  /** Current channel state. */
  getState(): WechatChannelState {
    return this.state;
  }

  /** Current config (for persistence). */
  getConfig(): WechatConfig {
    return { ...this.config, state: this.state };
  }

  // -------------------------------------------------------------------------
  // QR Login
  // -------------------------------------------------------------------------

  /**
   * Start QR scan login flow.
   * On success, sets bot_token on client and starts monitor.
   */
  async startQrLogin(
    onQrCode?: (qrcodeUrl: string) => void,
    onStatus?: QrStatusCallback,
  ): Promise<QrLoginResult> {
    this.setState('scanning');

    try {
      const result = await this.auth.login({
        onQrCode: (url) => {
          this.config.qrcode_url = url;
          onQrCode?.(url);
        },
        onStatus,
      });

      // Update config with credentials
      this.config.bot_token = result.botToken;
      this.config.ilink_bot_id = result.ilinkBotId;
      this.config.qrcode_url = undefined;

      // Configure client with new token
      this.client.setToken(result.botToken);

      // Start monitoring
      await this.startMonitor();

      return result;
    } catch (err) {
      this.setState('disconnected');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Monitor (long-polling)
  // -------------------------------------------------------------------------

  /** Start the message monitor with event wiring. */
  private async startMonitor(): Promise<void> {
    // Dynamic import to avoid circular dependency issues
    const { ILinkMonitor: MonitorClass } = await import('@mlb/wechat-sdk');

    this.monitor = new MonitorClass({
      client: this.client,
      botId: this.config.ilink_bot_id,
      onSessionExpired: () => {
        console.log('[wechat] session expired, will retry after pause');
        this.setState('expired');
        return this.config.auto_reconnect !== false;
      },
    });

    // Wire monitor events
    this.monitor.on('message', (msg: WeixinMessage) => {
      this.handleMessage(msg);
    });

    this.monitor.on('error', (err: Error) => {
      console.error('[wechat] monitor error:', err.message);
      this.callbacks.onError(err);
    });

    this.monitor.on('status', (status: MonitorStatus) => {
      switch (status) {
        case 'polling':
          this.setState('connected');
          break;
        case 'reconnecting':
          this.setState('reconnecting');
          break;
        case 'session_expired':
          this.setState('expired');
          break;
        case 'stopped':
          this.setState('disconnected');
          break;
      }
    });

    this.monitor.on('connected', () => {
      console.log('[wechat] monitor connected');
    });

    this.monitor.on('disconnected', (reason: string) => {
      console.log(`[wechat] monitor disconnected: ${reason}`);
    });

    // Start the polling loop (non-blocking — runs in background)
    this.monitor.start().catch((err) => {
      console.error('[wechat] monitor start failed:', err);
      this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    });

    this.setState('connected');
    console.log('[wechat] monitor started');
  }

  // -------------------------------------------------------------------------
  // Inbound message handling
  // -------------------------------------------------------------------------

  /**
   * Handle raw iLink message — filter, normalize, download media, and forward.
   *
   * Delegates to message-adapter.ts for filtering/normalization, then uses
   * media-bridge.ts to download and decrypt any image/file/video/voice attachments
   * from the iLink CDN before forwarding to the gateway layer.
   */
  private async handleMessage(msg: WeixinMessage): Promise<void> {
    const channelMsg = iLinkMessageToBridgeMessage(msg);
    if (!channelMsg) return;

    // Detect media types present in the raw message
    const contentTypes = detectContentTypes(msg.item_list);

    // Download and decrypt images from CDN
    if (contentTypes.has(MessageItemType.IMAGE)) {
      try {
        const images = await handleInboundImages(msg);
        if (images.length > 0) {
          channelMsg.images = images;
          console.log(`[wechat] downloaded ${images.length} image(s)`);
        }
      } catch (err) {
        console.error('[wechat] image download failed:', (err as Error).message);
      }
    }

    // Download files and append description to text (CC can't process raw file buffers)
    if (contentTypes.has(MessageItemType.FILE)) {
      try {
        const files = await handleInboundFiles(msg);
        if (files.length > 0) {
          const fileDescs = files.map(f => `[文件: ${f.filename}, ${(f.buffer.length / 1024).toFixed(1)}KB]`);
          channelMsg.text = (channelMsg.text || '') + '\n' + fileDescs.join('\n');
          console.log(`[wechat] downloaded ${files.length} file(s)`);
        }
      } catch (err) {
        console.error('[wechat] file download failed:', (err as Error).message);
      }
    }

    // Download videos and append description to text
    if (contentTypes.has(MessageItemType.VIDEO)) {
      try {
        const items = (msg.item_list ?? []).filter(i => i.type === MessageItemType.VIDEO);
        let downloaded = 0;
        for (const item of items) {
          const buf = await downloadVideoFromItem(item);
          if (buf) {
            downloaded++;
            channelMsg.text = (channelMsg.text || '') + `\n[视频: ${(buf.length / 1024).toFixed(1)}KB]`;
          }
        }
        if (downloaded > 0) console.log(`[wechat] downloaded ${downloaded} video(s)`);
      } catch (err) {
        console.error('[wechat] video download failed:', (err as Error).message);
      }
    }

    // Download voice and append transcription hint
    if (contentTypes.has(MessageItemType.VOICE)) {
      try {
        const items = (msg.item_list ?? []).filter(i => i.type === MessageItemType.VOICE);
        for (const item of items) {
          const buf = await downloadVoiceFromItem(item);
          if (buf) {
            console.log(`[wechat] downloaded voice: ${(buf.length / 1024).toFixed(1)}KB`);
          }
        }
      } catch (err) {
        console.error('[wechat] voice download failed:', (err as Error).message);
      }
    }

    console.log(
      `[wechat] message from=${channelMsg.sender.userId} text="${(channelMsg.text || '').substring(0, 50)}" images=${channelMsg.images?.length ?? 0}`,
    );

    this.callbacks.onMessage(channelMsg);
  }

  // -------------------------------------------------------------------------
  // Outbound: send reply
  // -------------------------------------------------------------------------

  /**
   * Send a text reply to a WeChat user.
   * Uses SDK sendTextMessage helper.
   */
  async sendTextReply(userId: string, contextToken: string, text: string): Promise<void> {
    const { sendTextMessage } = await import('@mlb/wechat-sdk');
    await sendTextMessage(this.client, {
      to: userId,
      contextToken,
      text,
    });
    console.log(`[wechat] sent text reply to=${userId} len=${text.length}`);
  }

  /**
   * Send an image reply to a WeChat user.
   * Encrypts and uploads to CDN, then sends via iLink sendImageMessage.
   */
  async sendImageReply(userId: string, contextToken: string, imageData: Buffer): Promise<void> {
    const uploaded = await uploadImageForSend({
      client: this.client,
      data: imageData,
      toUserId: userId,
    });
    const { sendImageMessage } = await import('@mlb/wechat-sdk');
    await sendImageMessage(this.client, {
      to: userId,
      contextToken,
      uploaded,
    });
    console.log(`[wechat] sent image reply to=${userId} size=${imageData.length}`);
  }

  /**
   * Send a file reply to a WeChat user.
   * Encrypts and uploads to CDN, then sends via iLink sendFileMessage.
   */
  async sendFileReply(userId: string, contextToken: string, fileData: Buffer, fileName: string): Promise<void> {
    const uploaded = await uploadFileForSend({
      client: this.client,
      data: fileData,
      toUserId: userId,
    });
    const { sendFileMessage } = await import('@mlb/wechat-sdk');
    await sendFileMessage(this.client, {
      to: userId,
      contextToken,
      uploaded,
      fileName,
    });
    console.log(`[wechat] sent file reply to=${userId} file=${fileName} size=${fileData.length}`);
  }

  /**
   * Get the underlying ILinkClient (for media operations in gateway layer).
   */
  getClient(): ILinkClient {
    return this.client;
  }

  /**
   * Send a typing indicator to a WeChat user.
   */
  async sendTyping(userId: string, contextToken: string): Promise<void> {
    try {
      // Get typing ticket first
      const configResp = await this.client.getConfig(userId, contextToken);
      if (configResp.typing_ticket) {
        await this.client.sendTyping({
          ilink_user_id: userId,
          typing_ticket: configResp.typing_ticket,
          status: 1, // TYPING
        });
      }
    } catch (err) {
      // Non-fatal — typing indicator is best-effort
      console.warn('[wechat] sendTyping error:', (err as Error).message);
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private setState(state: WechatChannelState): void {
    if (this.state === state) return;
    this.state = state;
    this.config.state = state;
    if (state === 'connected') {
      this.config.last_active = new Date().toISOString();
    }
    this.callbacks.onStateChange(state);
  }
}
