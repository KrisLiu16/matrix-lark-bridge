import * as lark from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ImageAttachment, SenderInfo } from './types.js';

const execFileAsync = promisify(execFile);

export class FeishuClient {
  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private appId: string;
  private appSecret: string;
  private apiBaseUrl: string;
  private cachedTenantToken = '';
  private tenantTokenExpiry = 0;

  constructor(appId: string, appSecret: string, apiBaseUrl = 'https://open.feishu.cn') {
    this.appId = appId;
    this.appSecret = appSecret;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    this.client = new lark.Client({ appId, appSecret, domain: apiBaseUrl });
  }

  // --- WebSocket connection ---

  async start(
    onMessage: (content: string, images: ImageAttachment[], chatId: string, messageId: string, senderInfo: SenderInfo, cardMsgId?: string) => void,
    onCardAction: (action: string, chatId: string, userId: string, actionValue?: Record<string, unknown>) => any,
  ): Promise<void> {
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        this.onMessage(data, onMessage).catch(err => {
          console.error('[feishu] onMessage error:', err);
        });
        return {};
      },
      'card.action.trigger': (data: any) => {
        return this.onCardAction(data, onCardAction);
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher } as any);
    console.log('[feishu] WebSocket connected');
  }

  private async onMessage(
    data: any,
    handler: (content: string, images: ImageAttachment[], chatId: string, messageId: string, senderInfo: SenderInfo, cardMsgId?: string) => void,
  ): Promise<void> {
    const sender = data.sender;
    const message = data.message;
    const messageType = message.message_type;

    // ── 过期消息过滤 ──
    // 飞书可能重试之前未确认的消息。超过 10 分钟的消息静默丢弃。
    const STALE_THRESHOLD_MS = 10 * 60 * 1000;
    let createTimeMs = parseInt(message.create_time, 10);
    if (createTimeMs && createTimeMs < 1e12) createTimeMs *= 1000; // 兼容秒级时间戳
    if (createTimeMs && (Date.now() - createTimeMs) > STALE_THRESHOLD_MS) {
      console.log(`[feishu] dropping stale message: age=${Math.round((Date.now() - createTimeMs) / 1000)}s, message_id=${message.message_id}`);
      return;
    }

    console.log(`[feishu] received message_type=${messageType}`);

    // Only handle text, image, post (rich text), and audio messages
    if (messageType !== 'text' && messageType !== 'image' && messageType !== 'post' && messageType !== 'audio') {
      console.log(`[feishu] ignoring message type: ${messageType}`);
      return;
    }

    let content = '';
    const images: ImageAttachment[] = [];

    // Construct senderInfo once (used by all message type branches)
    const senderInfo: SenderInfo = {
      openId: sender?.sender_id?.open_id || '',
      name: sender?.sender_id?.name || undefined,
      chatType: (message.chat_type as 'p2p' | 'group') || 'group',
    };

    try {
      const parsed = JSON.parse(message.content);

      if (messageType === 'text') {
        content = parsed.text || '';
      } else if (messageType === 'image') {
        const imageKey = parsed.image_key;
        if (imageKey) {
          const buf = await this.downloadImage(message.message_id, imageKey);
          images.push({ mimeType: 'image/png', data: buf });
          content = '[图片]';
          console.log(`[feishu] downloaded image: ${imageKey} (${buf.length} bytes)`);
        }
      } else if (messageType === 'post') {
        // Rich text: content may be wrapped in language key (zh_cn) or at top level
        const postBody = parsed.zh_cn || parsed.en_us || (parsed.content ? parsed : null);
        if (postBody?.content) {
          const textParts: string[] = [];
          for (const line of postBody.content) {
            for (const node of line) {
              if (node.tag === 'text') {
                textParts.push(node.text || '');
              } else if (node.tag === 'img' && node.image_key) {
                try {
                  const buf = await this.downloadImage(message.message_id, node.image_key);
                  images.push({ mimeType: 'image/png', data: buf });
                  console.log(`[feishu] downloaded image: ${node.image_key} (${buf.length} bytes)`);
                } catch (err) {
                  console.warn(`[feishu] download image failed: ${node.image_key}`, err);
                }
              }
            }
          }
          content = textParts.join('\n') || (images.length > 0 ? '[图片]' : '');
        }
      } else if (messageType === 'audio') {
        const fileKey = parsed.file_key;
        const duration = (parsed.duration as number) || 0;

        if (!fileKey) {
          console.warn('[feishu] audio message missing file_key');
        } else if (duration > 60_000) {
          // ASR API限制 60 秒
          content = '[语音消息超过 60 秒，无法识别]';
          console.log(`[feishu] audio too long: ${duration}ms`);
        } else {
          // Send "listening" card immediately for UX feedback
          const chatId = message.chat_id;
          const listeningCard = {
            schema: '2.0',
            config: { wide_screen_mode: true },
            header: {
              title: { tag: 'plain_text', content: '语音识别' },
              template: 'blue',
              icon: { tag: 'standard_icon', token: 'loading_outlined' },
              text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: '听语音中…' }, color: 'blue' }],
            },
            body: {
              elements: [{
                tag: 'div',
                icon: { tag: 'standard_icon', token: 'microphone_outlined', color: 'blue' },
                text: { tag: 'plain_text', content: `语音时长 ${(duration / 1000).toFixed(1)}s，正在识别…` },
              }],
            },
          };
          const listeningMsgId = await this.sendCard(chatId, listeningCard);

          try {
            // 1. Download audio file
            const audioBuffer = await this.downloadFile(message.message_id, fileKey);
            console.log(`[feishu] downloaded audio: ${fileKey} (${audioBuffer.length} bytes, ${duration}ms)`);

            // Guard against oversized audio files (20MB)
            const MAX_AUDIO_SIZE = 20 * 1024 * 1024;
            if (audioBuffer.length > MAX_AUDIO_SIZE) {
              throw new Error(`Audio file too large: ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_AUDIO_SIZE / 1024 / 1024}MB limit`);
            }

            // 2. Convert to PCM
            const pcmBuffer = await this.convertAudioToPcm(audioBuffer);
            console.log(`[feishu] converted to PCM: ${pcmBuffer.length} bytes`);

            // 3. Call ASR
            const recognizedText = await this.recognizeSpeech(pcmBuffer);
            if (recognizedText) {
              content = `[语音转文字] ${recognizedText}`;
              console.log(`[feishu] ASR result: "${recognizedText.substring(0, 100)}"`);
            } else {
              content = '[语音消息识别为空]';
              console.log('[feishu] ASR returned empty text');
            }
          } catch (err) {
            content = '[语音识别失败]';
            console.error('[feishu] audio recognition error:', err);
          }

          // Pass listeningMsgId so gateway can reuse the card
          handler(content.trim(), images, chatId, message.message_id, senderInfo, listeningMsgId || undefined);
          return; // Early return — already called handler with cardMsgId
        }
      }
    } catch (err) {
      content = message.content || '';
      console.warn('[feishu] parse content error:', err);
    }

    // Strip @bot mentions
    if (message.mentions?.length) {
      for (const mention of message.mentions) {
        content = content.replace(`@_user_${mention.id?.open_id}`, '').trim();
        content = content.replaceAll(`@${mention.name}`, '').trim();
      }
    }

    if (!content.trim() && images.length === 0) return;

    const chatId = message.chat_id;
    handler(content.trim(), images, chatId, message.message_id, senderInfo);
  }

  private onCardAction(
    data: any,
    handler: (action: string, chatId: string, userId: string, actionValue?: Record<string, unknown>) => any,
  ): any {
    const event = data?.event || data;
    const action = event?.action;
    if (!action?.value) return {};

    const actionStr = action.value.action as string;
    const openId = event.operator?.open_id || '';
    const chatId = event.context?.open_chat_id || event.context?.chat_id || '';

    console.log(`[feishu] card action: ${actionStr} from user=${openId} chat=${chatId}`);

    return handler(actionStr, chatId, openId, action.value);
  }

  // --- Image download ---

  private async downloadImage(messageId: string, fileKey: string): Promise<Buffer> {
    const resp = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: 'image' },
    });
    const stream = resp.getReadableStream() as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // --- File download (audio/file resources) ---

  private async downloadFile(messageId: string, fileKey: string): Promise<Buffer> {
    const resp = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: 'file' },
    });
    const stream = resp.getReadableStream() as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // --- Audio processing (ASR) ---

  private async convertAudioToPcm(audioBuffer: Buffer): Promise<Buffer> {
    const tmpIn = join(tmpdir(), `mlb-audio-${randomBytes(4).toString('hex')}.ogg`);
    const tmpOut = join(tmpdir(), `mlb-audio-${randomBytes(4).toString('hex')}.pcm`);

    try {
      writeFileSync(tmpIn, audioBuffer);

      await execFileAsync('ffmpeg', [
        '-i', tmpIn,
        '-f', 's16le',        // PCM signed 16-bit little-endian
        '-acodec', 'pcm_s16le',
        '-ar', '16000',        // 16kHz (matches engine_type: 16k_auto)
        '-ac', '1',            // mono
        '-y',                  // overwrite
        tmpOut,
      ], { timeout: 30_000 });

      return readFileSync(tmpOut);
    } finally {
      try { unlinkSync(tmpIn); } catch { /* ignore */ }
      try { unlinkSync(tmpOut); } catch { /* ignore */ }
    }
  }

  private async recognizeSpeech(pcmBuffer: Buffer): Promise<string> {
    const fileId = randomBytes(8).toString('hex');
    const token = await this.getTenantToken();

    const resp = await fetch(
      `${this.apiBaseUrl}/open-apis/speech_to_text/v1/speech/file_recognize`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          speech: { speech: pcmBuffer.toString('base64') },
          config: {
            file_id: fileId,
            format: 'pcm',
            engine_type: '16k_auto',
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    const data = (await resp.json()) as { code?: number; msg?: string; data?: { recognition_text?: string } };
    if (data.code !== 0) {
      throw new Error(`ASR failed: code=${data.code} msg=${data.msg}`);
    }
    return data.data?.recognition_text || '';
  }

  // --- Messaging ---

  async sendCard(chatId: string, card: object): Promise<string | undefined> {
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });
      return res?.data?.message_id;
    } catch (err) {
      console.error('[feishu] sendCard error:', err);
      return undefined;
    }
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    } catch (err) {
      console.error('[feishu] updateCard error:', err);
    }
  }

  async deleteMessage(messageId: string): Promise<void> {
    try {
      await this.client.im.message.delete({
        path: { message_id: messageId },
      });
    } catch (err) {
      console.warn('[feishu] deleteMessage error:', err);
    }
  }

  async uploadImage(image: Buffer): Promise<string> {
    const resp = await this.client.im.image.create({
      data: { image_type: 'message', image },
    });
    // SDK unwraps the `data` layer — resp is { image_key } directly, not { data: { image_key } }
    const r = resp as any;
    const key = r?.image_key ?? r?.data?.image_key;
    if (!key) {
      const code = r?.code ?? r?.data?.code ?? 'unknown';
      const msg = r?.msg ?? r?.data?.msg ?? JSON.stringify(r?.data ?? r);
      throw new Error(`Failed to upload image: code=${code}, msg=${msg}`);
    }
    return key;
  }

  async sendImage(chatId: string, image: Buffer): Promise<string | undefined> {
    const imageKey = await this.uploadImage(image);
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: 'image',
      },
    });
    return res?.data?.message_id;
  }

  async replyImage(messageId: string, image: Buffer): Promise<string | undefined> {
    const imageKey = await this.uploadImage(image);
    const res = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: 'image',
      },
    });
    return res?.data?.message_id;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    });
  }

  async replyText(messageId: string, text: string): Promise<void> {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    });
  }

  /** Add a reaction emoji to a message (fire-and-forget) */
  addReaction(messageId: string, emoji: string): void {
    this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    }).catch(() => { /* best effort */ });
  }

  // --- Typing indicator (reaction emoji) ---

  startTyping(messageId: string, emoji = 'OnIt'): () => void {
    let reactionId: string | undefined;
    let stopped = false;

    this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    }).then((res) => {
      if (!stopped) reactionId = res?.data?.reaction_id;
    }).catch((err) => {
      console.warn('[feishu] add reaction error:', err);
    });

    return () => {
      stopped = true;
      if (reactionId) {
        this.client.im.messageReaction.delete({
          path: { message_id: messageId, reaction_id: reactionId },
        }).catch(() => { /* ignore */ });
      }
    };
  }

  // --- Bot info ---

  async getBotName(): Promise<string | null> {
    try {
      const resp = await fetch(`${this.apiBaseUrl}/open-apis/bot/v3/info/`, {
        headers: { Authorization: `Bearer ${await this.getTenantToken()}` },
        signal: AbortSignal.timeout(3000),
      });
      const data = (await resp.json()) as { bot?: { app_name?: string } };
      return data.bot?.app_name || null;
    } catch {
      return null;
    }
  }

  private async getTenantToken(): Promise<string> {
    // Return cached token if still valid
    if (this.cachedTenantToken && Date.now() < this.tenantTokenExpiry) {
      return this.cachedTenantToken;
    }

    const resp = await fetch(
      `${this.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        signal: AbortSignal.timeout(3000),
      },
    );
    const data = (await resp.json()) as { tenant_access_token?: string; expire?: number };
    const token = data.tenant_access_token || '';
    if (token) {
      this.cachedTenantToken = token;
      // Expire 100s before actual expiry (default 2h = 7200s)
      this.tenantTokenExpiry = Date.now() + ((data.expire || 7200) - 100) * 1000;
    }
    return token;
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      await this.wsClient.close();
      this.wsClient = null;
    }
    console.log('[feishu] stopped');
  }
}
