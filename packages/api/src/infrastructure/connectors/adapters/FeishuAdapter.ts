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

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RichBlock } from '@cat-cafe/shared';

const execFileAsync = promisify(execFile);

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
  /** F134: Display name resolved via Contact API (group chat) */
  senderName?: string;
  /** F134: 'p2p' for DM, 'group' for group chat */
  chatType?: 'p2p' | 'group';
  /** F134: Group chat name resolved via Chat API */
  chatName?: string;
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
  /** Display name — used as file_name in Feishu upload and for file_type inference */
  fileName?: string;
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
  private botOpenId: string | null = null;
  private static CACHE_TTL_MS = 30 * 60 * 1000;
  private senderNameCache = new Map<string, { name: string; expiresAt: number }>();
  private chatNameCache = new Map<string, { name: string; expiresAt: number }>();

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
   * Supports text, image, file, audio, and post message types.
   * For group chats, only processes messages that @mention the bot.
   * Returns null for unsupported events or group messages not mentioning bot.
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
    const chatType = message.chat_type as string;

    if (chatType !== 'p2p' && chatType !== 'group') return null;

    const mentions = (message.mentions as Array<Record<string, unknown>> | undefined) ?? [];
    if (chatType === 'group') {
      if (!this.botOpenId) return null;
      const botMentioned = mentions.some((m) => {
        if (m.key === '@_all') return false;
        const mentionId = m.id as Record<string, unknown> | undefined;
        return mentionId?.open_id === this.botOpenId;
      });
      if (!botMentioned) return null;
    }

    // Extract sender
    const sender = event.sender as Record<string, unknown> | undefined;
    const senderId = (sender?.sender_id as Record<string, unknown> | undefined)?.open_id;

    const base = {
      chatId: message.chat_id as string,
      messageId: message.message_id as string,
      senderId: String(senderId ?? 'unknown'),
      chatType: chatType as 'p2p' | 'group',
    };

    // Parse content JSON
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(message.content as string);
    } catch {
      return null;
    }

    // Strip @bot placeholder from text in group chat (Feishu uses @_user_N tokens)
    const stripBotMention = (text: string): string => {
      if (chatType !== 'group') return text;
      for (const m of mentions) {
        const mentionId = m.id as Record<string, unknown> | undefined;
        if (mentionId?.open_id === this.botOpenId && typeof m.key === 'string') {
          text = text.replace(new RegExp(m.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
        }
      }
      return text.trim();
    };

    switch (msgType) {
      case 'text': {
        const text = content.text;
        if (typeof text !== 'string') return null;
        return { ...base, text: stripBotMention(text) };
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
      case 'post': {
        // Feishu sends post content in two formats:
        // 1. Locale-wrapped: { zh_cn: { title, content }, en_us: ... }
        // 2. Direct (no locale wrapper): { title, content: [[...]] }
        const c = content as Record<string, unknown>;
        const locale = c.zh_cn ?? c.en_us ?? c.ja_jp;
        const resolved =
          locale && typeof locale === 'object'
            ? locale
            : Array.isArray(c.content) // direct format — content is array of paragraphs
              ? c
              : null;
        if (!resolved || typeof resolved !== 'object') return null;
        const loc = resolved as { title?: string; content?: unknown[][] };
        const textParts: string[] = [];
        const attachments: FeishuAttachment[] = [];
        if (loc.title) textParts.push(loc.title);
        if (Array.isArray(loc.content)) {
          for (const paragraph of loc.content) {
            if (!Array.isArray(paragraph)) continue;
            const paraTexts: string[] = [];
            for (const node of paragraph) {
              const n = node as Record<string, unknown>;
              if (n.tag === 'text' || n.tag === 'a') {
                if (typeof n.text === 'string') paraTexts.push(n.text);
              } else if (n.tag === 'img' && typeof n.image_key === 'string') {
                attachments.push({
                  type: 'image' as const,
                  feishuKey: n.image_key as string,
                });
              }
            }
            if (paraTexts.length > 0) textParts.push(paraTexts.join(''));
          }
        }
        const text = textParts.join('\n') || '[富文本]';
        return {
          ...base,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
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
   * Priority: platform key > upload via absPath > download external URL + upload > text link fallback.
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
      const uploaded = await this.uploadToFeishu(payload.absPath, payload.type, payload.fileName);
      if (uploaded) {
        await this.sendWithPlatformKey(externalChatId, { ...payload, ...uploaded });
        return;
      }
      this.log.warn(
        { absPath: payload.absPath, type: payload.type },
        '[FeishuAdapter] sendMedia: uploadToFeishu returned null, falling through to text fallback',
      );
    }
    if (!payload.absPath && payload.url?.startsWith('https://') && this.tokenManager) {
      const tempPath = await this.downloadToTempFile(payload.url);
      if (tempPath) {
        try {
          const uploaded = await this.uploadToFeishu(tempPath, payload.type, payload.fileName);
          if (uploaded) {
            await this.sendWithPlatformKey(externalChatId, { ...payload, ...uploaded });
            return;
          }
        } finally {
          await unlink(tempPath).catch(() => {});
        }
      }
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
   *
   * Audio files: Feishu requires OPUS format for `msg_type: audio`.
   * Non-opus audio (wav/mp3) is automatically converted via ffmpeg before upload.
   */
  private async uploadToFeishu(
    absPath: string,
    type: 'image' | 'file' | 'audio',
    displayFileName?: string,
  ): Promise<{ imageKey?: string; fileKey?: string } | null> {
    const token = await this.tokenManager?.getTenantAccessToken();
    if (!token) {
      this.log.warn({ absPath, type }, '[FeishuAdapter] uploadToFeishu: no tenant access token');
      return null;
    }

    // For audio: convert to OPUS if needed (Feishu only accepts opus for audio messages)
    let uploadPath = absPath;
    let tempOpusPath: string | null = null;
    if (type === 'audio') {
      const ext = absPath.split('.').pop()?.toLowerCase();
      if (ext && ext !== 'opus') {
        const converted = await this.convertToOpus(absPath);
        if (converted) {
          tempOpusPath = converted;
          uploadPath = converted;
        } else {
          this.log.warn(
            { absPath, ext },
            '[FeishuAdapter] uploadToFeishu: opus conversion failed, aborting audio upload',
          );
          return null;
        }
      }
    }

    const originalFileName = displayFileName ?? absPath.split('/').pop() ?? 'file';

    try {
      return await this.uploadToFeishuInner(uploadPath, type, token, originalFileName);
    } finally {
      if (tempOpusPath) {
        await unlink(tempOpusPath).catch(() => {});
      }
    }
  }

  private async uploadToFeishuInner(
    absPath: string,
    type: 'image' | 'file' | 'audio',
    token: string,
    originalFileName?: string,
  ): Promise<{ imageKey?: string; fileKey?: string } | null> {
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

    const fileName = originalFileName ?? absPath.split('/').pop() ?? 'file';
    const fileType = type === 'audio' ? 'opus' : inferFeishuFileType(fileName);
    const uploadFileName = type === 'audio' ? fileName.replace(/\.\w+$/, '.opus') : fileName;
    form.append('file_type', fileType);
    form.append('file_name', uploadFileName);
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

  /**
   * Convert an audio file to Opus format (mono, 16kHz) using ffmpeg.
   * Returns the path to the temporary .opus file, or null if conversion fails.
   * Feishu requires opus for msg_type: audio — wav/mp3/ogg are rejected.
   */
  private async convertToOpus(absPath: string): Promise<string | null> {
    const baseName =
      absPath
        .split('/')
        .pop()
        ?.replace(/\.\w+$/, '') ?? 'audio';
    const opusPath = join(tmpdir(), `cat-cafe-feishu-${baseName}-${Date.now()}.opus`);
    try {
      await execFileAsync('ffmpeg', ['-i', absPath, '-acodec', 'libopus', '-ac', '1', '-ar', '16000', '-y', opusPath], {
        timeout: 30_000,
      });
      this.log.info({ absPath, opusPath }, '[FeishuAdapter] convertToOpus: success');
      return opusPath;
    } catch (err) {
      this.log.warn({ err, absPath }, '[FeishuAdapter] convertToOpus: ffmpeg failed');
      return null;
    }
  }

  /**
   * Reject URLs that could lead to SSRF — only allow https:// to public hosts.
   */
  private static isSafeExternalUrl(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    // Block localhost / loopback
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return false;
    // Block private IPv4 ranges and metadata endpoints
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
    // Block bare IPv4 (safeguard against other internal ranges)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    // Block IPv6 literals — private/link-local (fd, fe80, fc, ::1) and all bracketed forms
    if (host.includes(':') || host.startsWith('[')) return false;
    return true;
  }

  private async downloadToTempFile(url: string): Promise<string | null> {
    if (!FeishuAdapter.isSafeExternalUrl(url)) {
      this.log.warn({ url }, '[FeishuAdapter] downloadToTempFile: rejected unsafe URL');
      return null;
    }
    try {
      const res = await (this.uploadFetchFn ?? globalThis.fetch)(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        this.log.warn({ url, status: res.status }, '[FeishuAdapter] downloadToTempFile: fetch failed');
        return null;
      }
      const contentType = res.headers.get('content-type') ?? '';
      const ext = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg';
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) return null;
      const filePath = join(tmpdir(), `cat-cafe-feishu-dl-${Date.now()}.${ext}`);
      await writeFile(filePath, buffer);
      this.log.info({ url, filePath, bytes: buffer.length }, '[FeishuAdapter] downloadToTempFile: success');
      return filePath;
    } catch (err) {
      this.log.warn({ err, url }, '[FeishuAdapter] downloadToTempFile: failed');
      return null;
    }
  }

  setBotOpenId(openId: string): void {
    this.botOpenId = openId;
  }

  getBotOpenId(): string | null {
    return this.botOpenId;
  }

  async resolveSenderName(openId: string): Promise<string | undefined> {
    const cached = this.senderNameCache.get(openId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;

    const token = await this.tokenManager?.getTenantAccessToken();
    if (!token) return undefined;
    try {
      const res = await (this.uploadFetchFn ?? globalThis.fetch)(
        `https://open.feishu.cn/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return undefined;
      const data = (await res.json()) as { data?: { user?: { name?: string } } };
      const name = data?.data?.user?.name;
      if (name) {
        this.senderNameCache.set(openId, { name, expiresAt: Date.now() + FeishuAdapter.CACHE_TTL_MS });
      }
      return name;
    } catch {
      return undefined;
    }
  }

  async resolveChatName(chatId: string): Promise<string | undefined> {
    const cached = this.chatNameCache.get(chatId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;

    const token = await this.tokenManager?.getTenantAccessToken();
    if (!token) return undefined;
    try {
      const res = await (this.uploadFetchFn ?? globalThis.fetch)(
        `https://open.feishu.cn/open-apis/im/v1/chats/${chatId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return undefined;
      const data = (await res.json()) as { data?: { name?: string } };
      const name = data?.data?.name;
      if (name) {
        this.chatNameCache.set(chatId, { name, expiresAt: Date.now() + FeishuAdapter.CACHE_TTL_MS });
      }
      return name;
    } catch {
      return undefined;
    }
  }

  private prependAtMention(text: string, sender?: { id: string; name?: string }): string {
    if (!sender) return text;
    return `<at user_id="${sender.id}">${sender.name ?? '用户'}</at> ${text}`;
  }

  async sendReply(externalChatId: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    const sender = (metadata as { replyToSender?: { id: string; name?: string } } | undefined)?.replyToSender;
    const text = this.prependAtMention(content, sender);
    await this.sendLarkMessage(externalChatId, 'text', JSON.stringify({ text }));
  }

  async sendRichMessage(
    externalChatId: string,
    textContent: string,
    blocks: RichBlock[],
    catDisplayName: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const sender = (metadata as { replyToSender?: { id: string; name?: string } } | undefined)?.replyToSender;
    const text = this.prependAtMention(textContent, sender);
    const card = formatFeishuCard(blocks, catDisplayName, text);
    await this.sendLarkMessage(externalChatId, 'interactive', JSON.stringify(card));
  }

  async sendFormattedReply(
    externalChatId: string,
    envelope: MessageEnvelope,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const isCallback = envelope.origin === 'callback';
    const headerTitle = isCallback ? `📨 ${envelope.header} · 传话` : envelope.header;
    const headerTemplate = isCallback ? 'purple' : 'blue';

    const sender = (metadata as { replyToSender?: { id: string; name?: string } } | undefined)?.replyToSender;
    const atPrefix = sender ? `<at id=${sender.id}>${sender.name ?? '用户'}</at> ` : '';

    const elements: Array<{ tag: string; content?: string }> = [];
    if (envelope.subtitle) {
      elements.push({ tag: 'markdown', content: `**${envelope.subtitle}**` });
    }
    elements.push({ tag: 'markdown', content: `${atPrefix}${envelope.body}` });
    if (envelope.footer) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'markdown', content: envelope.footer });
    }
    const card = {
      header: {
        title: { tag: 'plain_text' as const, content: headerTitle },
        template: headerTemplate as 'blue' | 'purple',
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

  /**
   * Test helper: clear TTL caches.
   * @internal
   */
  _clearCaches(): void {
    this.senderNameCache.clear();
    this.chatNameCache.clear();
  }
}

/**
 * Phase J: Map file extension to Feishu file_type for native preview.
 * Feishu recognizes: pdf, doc, xls, ppt, mp4, opus, stream (catch-all).
 */
const FEISHU_EXT_TO_FILE_TYPE: Record<string, string> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  xls: 'xls',
  xlsx: 'xls',
  ppt: 'ppt',
  pptx: 'ppt',
  mp4: 'mp4',
};

export function inferFeishuFileType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return FEISHU_EXT_TO_FILE_TYPE[ext] ?? 'stream';
}

/** Read a Node.js ReadStream into a Buffer. */
async function streamToBuffer(stream: import('node:fs').ReadStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
