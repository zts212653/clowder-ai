/**
 * Feishu (飞书/Lark) Bot Adapter
 * Inbound: Parse webhook event → extract private text message
 * Outbound: Send reply via Lark API
 *
 * Uses @larksuiteoapi/node-sdk for API calls.
 * MVP: DM-only (p2p), text-only, single-owner.
 *
 * F088 Multi-Platform Chat Gateway
 */

import { createReadStream } from 'node:fs';
import type { RichBlock } from '@cat-cafe/shared';
import * as lark from '@larksuiteoapi/node-sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { MessageEnvelope } from '../ConnectorMessageFormatter.js';
import type { IStreamableOutboundAdapter } from '../OutboundDeliveryHook.js';
import type { FeishuTokenManager } from './FeishuTokenManager.js';
import { formatFeishuCard } from './feishu-card-formatter.js';

export interface FeishuAttachment {
  type: 'image' | 'file' | 'audio';
  feishuKey: string;
  fileName?: string;
  duration?: number;
}

export interface FeishuInboundMessage {
  chatId: string;
  text: string;
  messageId: string;
  senderId: string;
  attachments?: FeishuAttachment[];
}

export interface FeishuCardAction {
  chatId: string;
  senderId: string;
  actionValue: Record<string, unknown>;
}

export interface FeishuMediaPayload {
  type: 'image' | 'file' | 'audio';
  imageKey?: string;
  fileKey?: string;
  /** Fallback URL when platform key is not available (outbound from Clowder AI) */
  url?: string;
  /** Absolute filesystem path for upload (from mediaPathResolver) */
  absPath?: string;
}

export interface FeishuAdapterOptions {
  /** Feishu Verification Token for webhook event authentication. If not set, token verification is skipped. */
  verificationToken?: string | undefined;
}

export class FeishuAdapter implements IStreamableOutboundAdapter {
  readonly connectorId = 'feishu';
  private readonly client: lark.Client;
  private readonly log: FastifyBaseLogger;
  private readonly verificationToken: string | null;
  private tokenManager: FeishuTokenManager | null = null;
  private uploadFetchFn: typeof fetch = globalThis.fetch;
  private sendMessageFn: ((params: { chatId: string; content: string; msgType: string }) => Promise<unknown>) | null =
    null;
  private editMessageFn: ((params: { messageId: string; content: string }) => Promise<unknown>) | null = null;
  private deleteMessageFn: ((params: { messageId: string }) => Promise<unknown>) | null = null;

  constructor(appId: string, appSecret: string, log: FastifyBaseLogger, options?: FeishuAdapterOptions) {
    this.client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
    });
    this.log = log;
    this.verificationToken = options?.verificationToken ?? null;
  }

  /**
   * Check if the request body is a Feishu URL verification challenge.
   * Returns the challenge token if so, null otherwise.
   */
  isVerificationChallenge(body: unknown): { challenge: string } | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if (b.type === 'url_verification' && typeof b.challenge === 'string') {
      return { challenge: b.challenge };
    }
    return null;
  }

  /**
   * Verify event callback token.
   * Checks that the event body's header.token matches the configured verificationToken.
   * If no verificationToken is configured, verification is skipped (returns true).
   */
  verifyEventToken(body: unknown): boolean {
    if (!this.verificationToken) return true;
    if (!body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    const header = b.header as Record<string, unknown> | undefined;
    if (!header) return false;
    return header.token === this.verificationToken;
  }

  /**
   * Parse a Feishu event callback into an inbound message.
   * Supports text, image, file, and audio message types.
   * Returns null for group or unsupported events.
   */
  parseEvent(eventBody: unknown): FeishuInboundMessage | null {
    if (!eventBody || typeof eventBody !== 'object') return null;

    const body = eventBody as Record<string, unknown>;
    const header = body.header as Record<string, unknown> | undefined;
    if (!header || header.event_type !== 'im.message.receive_v1') return null;

    const event = body.event as Record<string, unknown> | undefined;
    if (!event) return null;

    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return null;

    const msgType = message.message_type as string;

    // MVP: DM only (p2p)
    if (message.chat_type !== 'p2p') return null;

    // Extract sender
    const sender = event.sender as Record<string, unknown> | undefined;
    const senderId = (sender?.sender_id as Record<string, unknown> | undefined)?.open_id;

    const base = {
      chatId: message.chat_id as string,
      messageId: message.message_id as string,
      senderId: String(senderId ?? 'unknown'),
    };

    // Parse content JSON
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(message.content as string);
    } catch {
      return null;
    }

    switch (msgType) {
      case 'text': {
        const text = content.text;
        if (typeof text !== 'string') return null;
        return { ...base, text };
      }
      case 'image': {
        const imageKey = content.image_key as string;
        if (!imageKey) return null;
        return { ...base, text: '[图片]', attachments: [{ type: 'image', feishuKey: imageKey }] };
      }
      case 'file': {
        const fileKey = content.file_key as string;
        const fileName = content.file_name as string | undefined;
        if (!fileKey) return null;
        return {
          ...base,
          text: fileName ? `[文件] ${fileName}` : '[文件]',
          attachments: [{ type: 'file', feishuKey: fileKey, ...(fileName ? { fileName } : {}) }],
        };
      }
      case 'audio': {
        const audioKey = content.file_key as string;
        const duration = content.duration as number | undefined;
        if (!audioKey) return null;
        return {
          ...base,
          text: '[语音]',
          attachments: [{ type: 'audio', feishuKey: audioKey, ...(duration != null ? { duration } : {}) }],
        };
      }
      default:
        return null;
    }
  }

  /**
   * AC-14: Parse a Feishu card action callback (button click, etc.).
   * Returns null for non-card-action events.
   */
  parseCardAction(eventBody: unknown): FeishuCardAction | null {
    if (!eventBody || typeof eventBody !== 'object') return null;

    const body = eventBody as Record<string, unknown>;
    const header = body.header as Record<string, unknown> | undefined;
    if (!header || header.event_type !== 'card.action.trigger') return null;

    const event = body.event as Record<string, unknown> | undefined;
    if (!event) return null;

    const operator = event.operator as Record<string, unknown> | undefined;
    const action = event.action as Record<string, unknown> | undefined;
    const context = event.context as Record<string, unknown> | undefined;

    if (!operator || !action || !context) return null;

    const actionValue = action.value as Record<string, unknown> | undefined;
    if (!actionValue || typeof actionValue !== 'object') return null;

    return {
      chatId: context.open_chat_id as string,
      senderId: operator.open_id as string,
      actionValue,
    };
  }

  private async sendLarkMessage(externalChatId: string, msgType: string, content: string): Promise<unknown> {
    const params = { chatId: externalChatId, content, msgType };
    if (this.sendMessageFn) return this.sendMessageFn(params);

    const result = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: externalChatId, msg_type: msgType, content },
    });

    const code = (result as { code?: number })?.code;
    if (code !== undefined && code !== 0) {
      const msg = (result as { msg?: string })?.msg ?? 'unknown';
      throw new Error(`Feishu API error ${code}: ${msg}`);
    }
    return result;
  }

  /**
   * Phase 5: Send a media message (image, file, or audio) to a Feishu chat.
   * Priority: platform key > upload via absPath > text link fallback.
   */
  async sendMedia(externalChatId: string, payload: FeishuMediaPayload): Promise<void> {
    this.log.info(
      {
        type: payload.type,
        hasKey: !!(payload.imageKey || payload.fileKey),
        absPath: payload.absPath,
        url: payload.url,
        hasTokenMgr: !!this.tokenManager,
      },
      '[FeishuAdapter] sendMedia entry',
    );
    if (payload.imageKey || payload.fileKey) {
      await this.sendWithPlatformKey(externalChatId, payload);
      return;
    }
    if (payload.absPath && this.tokenManager) {
      const uploaded = await this.uploadToFeishu(payload.absPath, payload.type);
      if (uploaded) {
        await this.sendWithPlatformKey(externalChatId, { ...payload, ...uploaded });
        return;
      }
      this.log.warn(
        { absPath: payload.absPath, type: payload.type },
        '[FeishuAdapter] sendMedia: uploadToFeishu returned null, falling through to text fallback',
      );
    }
    if (payload.url) {
      this.log.warn({ url: payload.url, type: payload.type }, '[FeishuAdapter] sendMedia: Path 3 text fallback');
      const label = payload.type === 'image' ? '🖼️' : payload.type === 'audio' ? '🔊' : '📎';
      await this.sendReply(externalChatId, `${label} ${payload.url}`);
    }
  }

  private async sendWithPlatformKey(externalChatId: string, payload: FeishuMediaPayload): Promise<void> {
    const typeMap = {
      image: () => ({ msgType: 'image', content: JSON.stringify({ image_key: payload.imageKey }) }),
      file: () => ({ msgType: 'file', content: JSON.stringify({ file_key: payload.fileKey }) }),
      audio: () => ({ msgType: 'audio', content: JSON.stringify({ file_key: payload.fileKey }) }),
    } as const;
    const entry = typeMap[payload.type];
    if (!entry) return;
    const { msgType, content } = entry();
    await this.sendLarkMessage(externalChatId, msgType, content);
  }

  /**
   * Upload a local file to Feishu and return the platform key.
   * Images → /im/v1/images, files/audio → /im/v1/files.
   */
  private async uploadToFeishu(
    absPath: string,
    type: 'image' | 'file' | 'audio',
  ): Promise<{ imageKey?: string; fileKey?: string } | null> {
    const token = await this.tokenManager?.getTenantAccessToken();
    if (!token) {
      this.log.warn({ absPath, type }, '[FeishuAdapter] uploadToFeishu: no tenant access token');
      return null;
    }
    const fileStream = createReadStream(absPath);
    const form = new FormData();

    if (type === 'image') {
      form.append('image_type', 'message');
      form.append('image', new Blob([await streamToBuffer(fileStream)]));
      const res = await this.uploadFetchFn('https://open.feishu.cn/open-apis/im/v1/images', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '(unreadable)');
        this.log.warn({ status: res.status, body, absPath }, '[FeishuAdapter] uploadToFeishu image upload failed');
        return null;
      }
      const data = (await res.json()) as { data?: { image_key?: string } };
      const imageKey = data.data?.image_key;
      return imageKey ? { imageKey } : null;
    }

    const fileName = absPath.split('/').pop() ?? 'file';
    let fileType: string;
    if (type === 'audio') {
      const ext = fileName.split('.').pop()?.toLowerCase();
      fileType = ext === 'mp3' ? 'mp3' : ext === 'ogg' ? 'ogg' : ext === 'wav' ? 'wav' : 'opus';
    } else {
      fileType = 'stream';
    }
    form.append('file_type', fileType);
    form.append('file_name', fileName);
    form.append('file', new Blob([await streamToBuffer(fileStream)]));
    const res = await this.uploadFetchFn('https://open.feishu.cn/open-apis/im/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      this.log.warn(
        { status: res.status, body, absPath, fileType },
        '[FeishuAdapter] uploadToFeishu file upload failed',
      );
      return null;
    }
    const data = (await res.json()) as { data?: { file_key?: string } };
    const fileKey = data.data?.file_key;
    return fileKey ? { fileKey } : null;
  }

  async sendReply(externalChatId: string, content: string): Promise<void> {
    await this.sendLarkMessage(externalChatId, 'text', JSON.stringify({ text: content }));
  }

  async sendRichMessage(
    externalChatId: string,
    textContent: string,
    blocks: RichBlock[],
    catDisplayName: string,
  ): Promise<void> {
    const card = formatFeishuCard(blocks, catDisplayName, textContent);
    await this.sendLarkMessage(externalChatId, 'interactive', JSON.stringify(card));
  }

  async sendFormattedReply(externalChatId: string, envelope: MessageEnvelope): Promise<void> {
    const elements: Array<{ tag: string; content?: string }> = [];
    if (envelope.subtitle) {
      elements.push({ tag: 'markdown', content: `**${envelope.subtitle}**` });
    }
    elements.push({ tag: 'markdown', content: envelope.body });
    if (envelope.footer) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'markdown', content: envelope.footer });
    }
    const card = {
      header: {
        title: { tag: 'plain_text' as const, content: envelope.header },
        template: 'blue' as const,
      },
      elements,
    };
    await this.sendLarkMessage(externalChatId, 'interactive', JSON.stringify(card));
  }

  async sendPlaceholder(externalChatId: string, text: string): Promise<string> {
    const card = {
      config: { update_multi: true },
      header: { title: { tag: 'plain_text' as const, content: text }, template: 'grey' as const },
      elements: [{ tag: 'markdown', content: '...' }],
    };
    const result = await this.sendLarkMessage(externalChatId, 'interactive', JSON.stringify(card));
    const data = result as { data?: { message_id?: string }; message_id?: string } | undefined;
    return data?.data?.message_id ?? data?.message_id ?? '';
  }

  /**
   * Edit an already-sent message card in place.
   * Uses Lark im.message.patch API — only supports interactive (card) messages.
   * The text is rendered as markdown inside the card body.
   */
  async editMessage(_externalChatId: string, platformMessageId: string, text: string): Promise<void> {
    if (this.editMessageFn) {
      await this.editMessageFn({ messageId: platformMessageId, content: text });
      return;
    }

    const card = {
      config: { update_multi: true },
      header: { title: { tag: 'plain_text' as const, content: '🐱 回复中...' }, template: 'blue' as const },
      elements: [{ tag: 'markdown', content: text }],
    };
    await this.client.im.message.patch({
      path: { message_id: platformMessageId },
      data: {
        content: JSON.stringify(card),
      },
    });
  }

  /**
   * Delete a message by its platform message ID.
   * Used to clean up streaming placeholder cards after final outbound delivery.
   */
  async deleteMessage(platformMessageId: string): Promise<void> {
    if (this.deleteMessageFn) {
      await this.deleteMessageFn({ messageId: platformMessageId });
      return;
    }

    await this.client.im.message.delete({
      path: { message_id: platformMessageId },
    });
  }

  /**
   * Test helper: inject a mock send function.
   * @internal
   */
  _injectSendMessage(fn: (params: { chatId: string; content: string; msgType: string }) => Promise<unknown>): void {
    this.sendMessageFn = fn;
  }

  /**
   * Test helper: inject a mock edit function.
   * @internal
   */
  _injectEditMessage(fn: (params: { messageId: string; content: string }) => Promise<unknown>): void {
    this.editMessageFn = fn;
  }

  /**
   * Test helper: inject a mock delete function.
   * @internal
   */
  _injectDeleteMessage(fn: (params: { messageId: string }) => Promise<unknown>): void {
    this.deleteMessageFn = fn;
  }

  /**
   * Test helper: inject a FeishuTokenManager.
   * @internal
   */
  _injectTokenManager(tm: FeishuTokenManager): void {
    this.tokenManager = tm;
  }

  /**
   * Test helper: inject a mock fetch for upload APIs.
   * @internal
   */
  _injectUploadFetch(fn: typeof fetch): void {
    this.uploadFetchFn = fn;
  }
}

/** Read a Node.js ReadStream into a Buffer. */
async function streamToBuffer(stream: import('node:fs').ReadStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
