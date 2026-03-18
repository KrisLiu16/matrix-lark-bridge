import * as lark from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';
import type { ImageAttachment } from './types.js';

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
    onMessage: (content: string, images: ImageAttachment[], chatId: string, messageId: string) => void,
    onCardAction: (action: string, chatId: string, userId: string) => any,
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
    handler: (content: string, images: ImageAttachment[], chatId: string, messageId: string) => void,
  ): Promise<void> {
    const sender = data.sender;
    const message = data.message;
    const messageType = message.message_type;

    console.log(`[feishu] received message_type=${messageType}`);

    // Only handle text, image, and post (rich text) messages
    if (messageType !== 'text' && messageType !== 'image' && messageType !== 'post') {
      console.log(`[feishu] ignoring message type: ${messageType}`);
      return;
    }

    let content = '';
    const images: ImageAttachment[] = [];

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
      }
    } catch (err) {
      content = message.content || '';
      console.warn('[feishu] parse content error:', err);
    }

    // Strip @bot mentions
    if (message.mentions?.length) {
      for (const mention of message.mentions) {
        content = content.replace(`@_user_${mention.id?.open_id}`, '').trim();
        content = content.replace(new RegExp(`@${mention.name}`, 'g'), '').trim();
      }
    }

    if (!content.trim() && images.length === 0) return;

    const chatId = message.chat_id;
    handler(content.trim(), images, chatId, message.message_id);
  }

  private onCardAction(
    data: any,
    handler: (action: string, chatId: string, userId: string) => any,
  ): any {
    const event = data?.event || data;
    const action = event?.action;
    if (!action?.value) return {};

    const actionValue = action.value.action as string;
    const openId = event.operator?.open_id || '';
    const chatId = event.context?.open_chat_id || event.context?.chat_id || '';

    console.log(`[feishu] card action: ${actionValue} from user=${openId} chat=${chatId}`);

    return handler(actionValue, chatId, openId);
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
