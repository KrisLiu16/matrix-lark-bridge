import type { FeishuClient } from './feishu.js';
import { buildMarkdownCard } from './card.js';

export class StreamPreview {
  private config: { interval_ms: number; min_delta_chars: number; max_chars: number };
  private feishu: FeishuClient;
  private chatId: string;

  private buffer = '';
  private lastSentLength = 0;
  private previewMessageId: string | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;

  constructor(
    config: { interval_ms: number; min_delta_chars: number; max_chars: number },
    feishu: FeishuClient,
    chatId: string,
  ) {
    this.config = config;
    this.feishu = feishu;
    this.chatId = chatId;
  }

  appendText(text: string): void {
    if (this.finished) return;
    this.buffer += text;
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.timer || this.finished) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(console.error);
    }, this.config.interval_ms);
  }

  private async flush(): Promise<void> {
    if (this.finished) return;

    const delta = this.buffer.length - this.lastSentLength;
    if (delta < this.config.min_delta_chars) return;

    const content = this.buffer.length > this.config.max_chars
      ? this.buffer.substring(0, this.config.max_chars) + '\n...'
      : this.buffer;

    const card = buildMarkdownCard(content + '\n\n⏳ _generating..._');

    try {
      if (!this.previewMessageId) {
        this.previewMessageId = await this.feishu.sendCard(this.chatId, card);
      } else {
        await this.feishu.updateCard(this.previewMessageId, card);
      }
      this.lastSentLength = this.buffer.length;
    } catch (err) {
      console.warn('[streaming] update error:', err);
    }
  }

  async finish(finalCard: object): Promise<void> {
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.previewMessageId) {
      await this.feishu.updateCard(this.previewMessageId, finalCard);
    } else {
      await this.feishu.sendCard(this.chatId, finalCard);
    }
  }

  cancel(): void {
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Delete the preview message to avoid leaving a stale "generating..." card
    if (this.previewMessageId) {
      const msgId = this.previewMessageId;
      this.previewMessageId = undefined;
      this.feishu.deleteMessage(msgId).catch(() => { /* best effort */ });
    }
  }

  getPreviewMessageId(): string | undefined {
    return this.previewMessageId;
  }
}
