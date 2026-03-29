/**
 * WeCom Bot (企微智能机器人) Adapter
 * Inbound:  WebSocket long-connection via @wecom/aibot-node-sdk → parse text/image/mixed/voice/file
 * Outbound: replyStream (native frame-based streaming) + sendMessage (proactive push)
 *
 * F132 DingTalk + WeCom Chat Gateway — Phase B
 */

import { basename } from 'node:path';
import type { RichBlock } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyBaseLogger } from 'fastify';
import type { MessageEnvelope } from '../ConnectorMessageFormatter.js';
import type { IStreamableOutboundAdapter } from '../OutboundDeliveryHook.js';

// ── Types ──

export interface WeComBotAttachment {
  type: 'image' | 'file' | 'voice';
  /** Encrypted download URL (5-min TTL) */
  url?: string;
  /** AES decryption key (Base64), unique per file */
  aesKey?: string;
  fileName?: string;
  /** Voice: text transcription from WeCom ASR */
  voiceText?: string;
}

export interface WeComBotInboundMessage {
  /** Single: from.userid | Group: chatid */
  chatId: string;
  text: string;
  messageId: string;
  senderId: string;
  chatType: 'p2p' | 'group';
  attachments?: WeComBotAttachment[];
}

export interface WeComBotAdapterOptions {
  botId: string;
  secret: string;
  /** Optional Redis client for persisting group chatId set across cold restarts. */
  redis?: RedisClient | undefined;
}

// ── Streaming Bridge State ──

/** Active streaming session: maps streamId → frame + streamId for replyStream calls */
interface ActiveStream {
  /** Original inbound frame headers (carries req_id) */
  frame: { headers: { req_id: string; [key: string]: unknown } };
  streamId: string;
  lastContent: string;
  lastUpdateAt: number;
}

// ── Throttle Config ──

const STREAM_THROTTLE_MS = 300;

// ── Adapter ──

export class WeComBotAdapter implements IStreamableOutboundAdapter {
  readonly connectorId = 'wecom-bot';
  private readonly log: FastifyBaseLogger;
  private readonly botId: string;
  private readonly secret: string;
  private readonly redis: RedisClient | undefined;

  // SDK client (lazy-loaded)
  private wsClient: unknown = null;
  private stopFn: (() => Promise<void>) | null = null;

  // Active streaming sessions (keyed by streamId = platformMessageId)
  private readonly activeStreams = new Map<string, ActiveStream>();

  // Frame cache: externalChatId → last inbound frame (for proactive streaming on new messages)
  // This allows sendPlaceholder to find the frame needed for replyStream
  private readonly lastFrameByChat = new Map<string, { headers: { req_id: string; [key: string]: unknown } }>();

  // Group chatId tracking (for chatType resolution on outbound)
  private readonly groupChatIds = new Set<string>();

  // DI injection points (for testing + runtime override)
  private replyStreamFn:
    | ((
        frame: { headers: { req_id: string } },
        streamId: string,
        content: string,
        finish?: boolean,
      ) => Promise<unknown>)
    | null = null;
  private sendMessageFn: ((chatId: string, body: Record<string, unknown>) => Promise<unknown>) | null = null;
  private uploadMediaFn:
    | ((fileBuffer: Buffer, options: { type: string; filename: string }) => Promise<{ media_id: string }>)
    | null = null;
  private sendMediaMessageFn: ((chatId: string, mediaType: string, mediaId: string) => Promise<unknown>) | null = null;
  private replyTemplateCardFn:
    | ((frame: { headers: { req_id: string } }, templateCard: Record<string, unknown>) => Promise<unknown>)
    | null = null;
  private updateTemplateCardFn:
    | ((
        frame: { headers: { req_id: string } },
        templateCard: Record<string, unknown>,
        userids?: string[],
      ) => Promise<unknown>)
    | null = null;
  private downloadFileFn: ((url: string, aesKey?: string) => Promise<{ buffer: Buffer; filename?: string }>) | null =
    null;
  private generateReqIdFn: ((prefix: string) => string) | null = null;

  constructor(log: FastifyBaseLogger, options: WeComBotAdapterOptions) {
    this.log = log;
    this.botId = options.botId;
    this.secret = options.secret;
    this.redis = options.redis;
  }

  // ── Inbound: Parse WsFrame Body ──

  /**
   * Parse a WeCom SDK message body into a normalized inbound message.
   * Supports text, image, mixed, voice, file message types.
   * Returns null for unsupported events.
   *
   * AC-B1: DM + Group text/image/mixed/voice/file parsing
   */
  parseEvent(frame: {
    headers: { req_id: string; [key: string]: unknown };
    body?: Record<string, unknown>;
  }): WeComBotInboundMessage | null {
    const body = frame.body;
    if (!body || typeof body !== 'object') return null;

    const msgtype = body.msgtype as string | undefined;
    if (!msgtype || msgtype === 'event') return null;

    const chattype = body.chattype as 'single' | 'group' | undefined;
    if (chattype !== 'single' && chattype !== 'group') return null;

    const isGroup = chattype === 'group';
    const chatTypeNorm: 'p2p' | 'group' = isGroup ? 'group' : 'p2p';
    const from = body.from as { userid: string } | undefined;
    const senderId = from?.userid ?? 'unknown';
    const messageId = (body.msgid as string) ?? '';
    const groupChatId = (body.chatid as string) ?? '';
    const chatId = isGroup ? groupChatId : senderId;

    // Cache frame for streaming bridge
    this.lastFrameByChat.set(chatId, { headers: frame.headers });

    // Track group chatIds
    if (isGroup && groupChatId) {
      this.groupChatIds.add(groupChatId);
      this.redis?.sadd(WeComBotAdapter.REDIS_GROUP_IDS_KEY, groupChatId).catch(() => {});
    }

    const base = { chatId, messageId, senderId, chatType: chatTypeNorm };

    switch (msgtype) {
      case 'text': {
        const textObj = body.text as { content?: string } | undefined;
        const text = textObj?.content;
        if (!text) return null;
        return { ...base, text: text.trim() };
      }
      case 'image': {
        const imageObj = body.image as { url?: string; aeskey?: string } | undefined;
        return {
          ...base,
          text: '[图片]',
          attachments: imageObj?.url
            ? [{ type: 'image' as const, url: imageObj.url, aesKey: imageObj.aeskey }]
            : undefined,
        };
      }
      case 'mixed': {
        const mixedObj = body.mixed as { msg_item?: Array<Record<string, unknown>> } | undefined;
        const items = mixedObj?.msg_item;
        if (!items || !Array.isArray(items)) return null;

        const textParts: string[] = [];
        const attachments: WeComBotAttachment[] = [];

        for (const item of items) {
          const itemType = item.msgtype as string;
          if (itemType === 'text') {
            const t = item.text as { content?: string } | undefined;
            if (t?.content) textParts.push(t.content);
          } else if (itemType === 'image') {
            const img = item.image as { url?: string; aeskey?: string } | undefined;
            if (img?.url) {
              attachments.push({ type: 'image', url: img.url, aesKey: img.aeskey });
            }
          }
        }

        const text = textParts.join('') || '[图文混排]';
        return { ...base, text, ...(attachments.length > 0 ? { attachments } : {}) };
      }
      case 'voice': {
        const voiceObj = body.voice as { content?: string } | undefined;
        const voiceText = voiceObj?.content ?? '';
        return {
          ...base,
          text: voiceText || '[语音]',
          attachments: voiceText ? [{ type: 'voice' as const, voiceText }] : undefined,
        };
      }
      case 'file': {
        const fileObj = body.file as { url?: string; aeskey?: string } | undefined;
        return {
          ...base,
          text: '[文件]',
          attachments: fileObj?.url ? [{ type: 'file' as const, url: fileObj.url, aesKey: fileObj.aeskey }] : undefined,
        };
      }
      default:
        return null;
    }
  }

  // ── Group ChatId Persistence ──

  private static readonly REDIS_GROUP_IDS_KEY = 'wecom-bot-group-chat-ids';

  registerGroupChatId(chatId: string): void {
    this.groupChatIds.add(chatId);
    this.redis?.sadd(WeComBotAdapter.REDIS_GROUP_IDS_KEY, chatId).catch(() => {});
  }

  async hydrateGroupChatIds(): Promise<void> {
    if (!this.redis) return;
    try {
      const ids = await this.redis.smembers(WeComBotAdapter.REDIS_GROUP_IDS_KEY);
      for (const id of ids) this.groupChatIds.add(id);
      this.log.info({ count: ids.length }, '[WeComBotAdapter] Hydrated group chatIds from Redis');
    } catch (err) {
      this.log.warn({ err }, '[WeComBotAdapter] Failed to hydrate group chatIds from Redis');
    }
  }

  // ── Outbound: Send Messages ──

  /**
   * Send a plain text reply via sendMessage (proactive push, no frame needed).
   * AC-B2: Basic markdown sending
   */
  async sendReply(externalChatId: string, content: string, _metadata?: Record<string, unknown>): Promise<void> {
    await this.wecomSendMessage(externalChatId, {
      msgtype: 'markdown',
      markdown: { content },
    });
  }

  /**
   * Send a rich block message (convert blocks to markdown text).
   */
  async sendRichMessage(
    externalChatId: string,
    textContent: string,
    _blocks: RichBlock[],
    catDisplayName: string,
    _metadata?: Record<string, unknown>,
  ): Promise<void> {
    const title = `🐱 ${catDisplayName}`;
    await this.wecomSendMessage(externalChatId, {
      msgtype: 'markdown',
      markdown: { content: `**${title}**\n\n${textContent}` },
    });
  }

  /**
   * Send a formatted reply as a template card (text_notice).
   * Falls back to markdown if no cached frame is available.
   * AC-B4: Template card send + update
   */
  async sendFormattedReply(
    externalChatId: string,
    envelope: MessageEnvelope,
    _metadata?: Record<string, unknown>,
  ): Promise<void> {
    const isCallback = envelope.origin === 'callback';
    const headerTitle = isCallback ? `📨 ${envelope.header} · 传话` : envelope.header;

    // Try template card via frame-based replyTemplateCard first
    const frame = this.lastFrameByChat.get(externalChatId);
    if (frame) {
      try {
        const templateCard: Record<string, unknown> = {
          card_type: 'text_notice',
          main_title: { title: headerTitle, ...(envelope.subtitle ? { desc: envelope.subtitle } : {}) },
          sub_title_text: envelope.body.slice(0, 200),
          ...(envelope.footer ? { card_action: { type: 0, url: '' } } : {}),
          task_id: `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        };
        await this.wecomReplyTemplateCard(frame, templateCard);
        return;
      } catch (err) {
        this.log.warn({ err }, '[WeComBotAdapter] replyTemplateCard failed, falling back to markdown');
      }
    }

    // Fallback: markdown via sendMessage (proactive push)
    let body = `**${headerTitle}**\n\n`;
    if (envelope.subtitle) {
      body += `**${envelope.subtitle}**\n\n`;
    }
    body += envelope.body;
    if (envelope.footer) {
      body += `\n\n---\n${envelope.footer}`;
    }

    await this.wecomSendMessage(externalChatId, {
      msgtype: 'markdown',
      markdown: { content: body },
    });
  }

  // ── Streaming: Frame-Based replyStream Bridge ──

  /**
   * Send a placeholder via replyStream (first chunk, finish=false).
   * Returns streamId as the platformMessageId.
   * AC-B3: Native streaming (create phase)
   */
  async sendPlaceholder(externalChatId: string, text: string): Promise<string> {
    const frame = this.lastFrameByChat.get(externalChatId);
    if (!frame) {
      this.log.warn(
        { externalChatId },
        '[WeComBotAdapter] sendPlaceholder: no cached frame for chatId, falling back to sendMessage',
      );
      // Fallback: send via proactive push (non-streaming)
      await this.sendReply(externalChatId, text);
      return '';
    }

    const streamId = this.generateStreamId();

    try {
      await this.wecomReplyStream(frame, streamId, text, false);

      this.activeStreams.set(streamId, {
        frame,
        streamId,
        lastContent: text,
        lastUpdateAt: Date.now(),
      });

      return streamId;
    } catch (err) {
      this.log.warn({ err }, '[WeComBotAdapter] sendPlaceholder replyStream failed');
      return '';
    }
  }

  /**
   * Edit a streaming message via replyStream (update phase, throttled).
   * AC-B3: Native streaming (update phase, 300ms throttle)
   */
  async editMessage(_externalChatId: string, platformMessageId: string, text: string): Promise<void> {
    const session = this.activeStreams.get(platformMessageId);
    if (!session) {
      this.log.warn({ platformMessageId }, '[WeComBotAdapter] editMessage: no active stream found');
      return;
    }

    // 300ms throttle
    const now = Date.now();
    if (now - session.lastUpdateAt < STREAM_THROTTLE_MS) return;

    try {
      await this.wecomReplyStream(session.frame, session.streamId, text, false);
      session.lastContent = text;
      session.lastUpdateAt = now;
    } catch (err) {
      this.log.warn({ err, platformMessageId }, '[WeComBotAdapter] editMessage streaming update failed');
    }
  }

  /**
   * Finish/delete a streaming session (send finish=true).
   * StreamingOutboundHook calls this for cleanup.
   */
  async deleteMessage(platformMessageId: string): Promise<void> {
    const session = this.activeStreams.get(platformMessageId);
    if (!session) return;

    try {
      // Send final content with finish=true to properly close the stream
      await this.wecomReplyStream(session.frame, session.streamId, session.lastContent, true);
    } catch (err) {
      this.log.warn({ err, platformMessageId }, '[WeComBotAdapter] deleteMessage (finish stream) failed');
    } finally {
      this.activeStreams.delete(platformMessageId);
    }
  }

  // ── Media ──

  /**
   * Send a media message (image, file, voice).
   * AC-B5: Media upload + send
   */
  async sendMedia(
    externalChatId: string,
    payload: {
      type: 'image' | 'file' | 'audio';
      url?: string;
      absPath?: string;
      fileName?: string;
      [key: string]: unknown;
    },
  ): Promise<void> {
    const absPath = typeof payload.absPath === 'string' && payload.absPath.length > 0 ? payload.absPath : undefined;
    const url = typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : undefined;

    // Map 'audio' → 'voice' for WeCom SDK
    const wecomMediaType = payload.type === 'audio' ? 'voice' : payload.type;

    // Path 1: Has absPath → upload + send
    if (absPath) {
      try {
        const { readFile } = await import('node:fs/promises');
        const fileBuffer = await readFile(absPath);
        const fileName = payload.fileName ?? basename(absPath);
        const mediaId = await this.wecomUploadMedia(fileBuffer, wecomMediaType, fileName);
        if (mediaId) {
          await this.wecomSendMediaMessage(externalChatId, wecomMediaType, mediaId);
          return;
        }
      } catch (err) {
        this.log.warn(
          { err, type: payload.type, absPath },
          '[WeComBotAdapter] sendMedia: upload failed, falling through',
        );
      }
    }

    // Path 2: Fallback — text link
    const mediaReference =
      url ??
      (typeof payload.fileName === 'string' && payload.fileName.length > 0
        ? payload.fileName
        : absPath
          ? basename(absPath)
          : undefined);

    if (mediaReference) {
      const label = payload.type === 'image' ? '🖼️' : payload.type === 'audio' ? '🔊' : '📎';
      await this.sendReply(externalChatId, `${label} ${mediaReference}`);
      return;
    }
    this.log.warn({ type: payload.type }, '[WeComBotAdapter] sendMedia: no file available, skipping');
  }

  /**
   * Download an encrypted media file using the SDK's downloadFile + AES decryption.
   * Returns a temporary file path after writing to disk.
   * AC-B5: Inbound media download
   */
  async downloadMedia(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }> {
    if (this.downloadFileFn) return this.downloadFileFn(url, aesKey);

    const client = this.wsClient as {
      downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
    } | null;

    if (!client) {
      throw new Error('[WeComBotAdapter] downloadMedia: wsClient not connected');
    }

    return client.downloadFile(url, aesKey);
  }

  // ── WebSocket Connection ──

  /**
   * Start the WeCom Bot WebSocket connection.
   * Calls onMessage for each inbound bot message.
   * AC-B7: WebSocket connection + reconnect + event dispatch
   */
  async startStream(onMessage: (msg: WeComBotInboundMessage) => Promise<void>): Promise<void> {
    try {
      const { default: AiBot, generateReqId } = await import('@wecom/aibot-node-sdk');

      // Store generateReqId for streaming
      this.generateReqIdFn = generateReqId;

      const client = new AiBot.WSClient({
        botId: this.botId,
        secret: this.secret,
        maxReconnectAttempts: -1, // Infinite reconnect
      });

      // Message dedup set (msgid → timestamp)
      const processedMsgIds = new Map<string, number>();
      const DEDUP_TTL_MS = 60_000;

      // Periodically clean dedup cache
      const dedupCleanupInterval = setInterval(() => {
        const cutoff = Date.now() - DEDUP_TTL_MS;
        for (const [msgId, ts] of processedMsgIds) {
          if (ts < cutoff) processedMsgIds.delete(msgId);
        }
      }, DEDUP_TTL_MS);

      const handleMessage = async (frame: {
        headers: { req_id: string; [key: string]: unknown };
        body?: Record<string, unknown>;
      }) => {
        try {
          const msgId = (frame.body?.msgid as string) ?? '';
          if (msgId && processedMsgIds.has(msgId)) return;
          if (msgId) processedMsgIds.set(msgId, Date.now());

          const parsed = this.parseEvent(frame);
          if (parsed) {
            await onMessage(parsed);
          }
        } catch (err) {
          this.log.error({ err }, '[WeComBotAdapter] Message handler error');
        }
      };

      // Listen to all message types
      client.on('message.text', handleMessage);
      client.on('message.image', handleMessage);
      client.on('message.mixed', handleMessage);
      client.on('message.voice', handleMessage);
      client.on('message.file', handleMessage);

      // AC-B4: Listen for template card button click events and update the card
      client.on(
        'event.template_card_event',
        async (frame: { headers: { req_id: string; [key: string]: unknown }; body?: Record<string, unknown> }) => {
          try {
            const event = frame.body?.event as { event_key?: string; task_id?: string } | undefined;
            this.log.info(
              { eventKey: event?.event_key, taskId: event?.task_id },
              '[WeComBotAdapter] template_card_event received',
            );

            if (event?.task_id) {
              const updatedCard: Record<string, unknown> = {
                card_type: 'text_notice',
                main_title: {
                  title: event.event_key === 'btn_confirm' ? '已确认 ✅' : `已操作: ${event.event_key ?? ''}`,
                },
                task_id: event.task_id,
              };
              await this.wecomUpdateTemplateCard(frame, updatedCard);
            }
          } catch (err) {
            this.log.error({ err }, '[WeComBotAdapter] template_card_event handler error');
          }
        },
      );

      // Lifecycle events
      client.on('authenticated', () => {
        this.log.info('[WeComBotAdapter] WebSocket authenticated');
      });
      client.on('disconnected', (reason: string) => {
        this.log.warn({ reason }, '[WeComBotAdapter] WebSocket disconnected');
      });
      client.on('reconnecting', (attempt: number) => {
        this.log.info({ attempt }, '[WeComBotAdapter] WebSocket reconnecting');
      });
      client.on('error', (error: Error) => {
        this.log.error({ err: error }, '[WeComBotAdapter] WebSocket error');
      });

      client.connect();
      this.wsClient = client;
      this.stopFn = async () => {
        clearInterval(dedupCleanupInterval);
        try {
          client.disconnect();
        } catch {
          // ignore disconnect errors
        }
      };

      this.log.info('[WeComBotAdapter] WebSocket connection initiated');
    } catch (err) {
      this.log.error({ err }, '[WeComBotAdapter] Failed to start WebSocket connection');
      throw err;
    }
  }

  /**
   * Stop the WebSocket connection.
   */
  async stopStream(): Promise<void> {
    if (this.stopFn) {
      await this.stopFn();
      this.stopFn = null;
      this.wsClient = null;
      this.log.info('[WeComBotAdapter] WebSocket connection stopped');
    }
  }

  // ── Private: WeCom SDK Calls ──

  private generateStreamId(): string {
    if (this.generateReqIdFn) return this.generateReqIdFn('stream');
    return `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private async wecomReplyStream(
    frame: { headers: { req_id: string; [key: string]: unknown } },
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<void> {
    if (this.replyStreamFn) {
      await this.replyStreamFn(frame, streamId, content, finish);
      return;
    }

    const client = this.wsClient as {
      replyStream(
        frame: { headers: { req_id: string } },
        streamId: string,
        content: string,
        finish?: boolean,
      ): Promise<unknown>;
    } | null;

    if (!client) {
      throw new Error('[WeComBotAdapter] replyStream: wsClient not connected');
    }

    await client.replyStream(frame, streamId, content, finish);
  }

  private async wecomReplyTemplateCard(
    frame: { headers: { req_id: string; [key: string]: unknown } },
    templateCard: Record<string, unknown>,
  ): Promise<void> {
    if (this.replyTemplateCardFn) {
      await this.replyTemplateCardFn(frame, templateCard);
      return;
    }

    const client = this.wsClient as {
      replyTemplateCard(
        frame: { headers: { req_id: string } },
        templateCard: Record<string, unknown>,
      ): Promise<unknown>;
    } | null;

    if (!client) {
      throw new Error('[WeComBotAdapter] replyTemplateCard: wsClient not connected');
    }

    await client.replyTemplateCard(frame, templateCard);
  }

  private async wecomUpdateTemplateCard(
    frame: { headers: { req_id: string; [key: string]: unknown } },
    templateCard: Record<string, unknown>,
    userids?: string[],
  ): Promise<void> {
    if (this.updateTemplateCardFn) {
      await this.updateTemplateCardFn(frame, templateCard, userids);
      return;
    }

    const client = this.wsClient as {
      updateTemplateCard(
        frame: { headers: { req_id: string } },
        templateCard: Record<string, unknown>,
        userids?: string[],
      ): Promise<unknown>;
    } | null;

    if (!client) {
      throw new Error('[WeComBotAdapter] updateTemplateCard: wsClient not connected');
    }

    await client.updateTemplateCard(frame, templateCard, userids);
  }

  private async wecomSendMessage(chatId: string, body: Record<string, unknown>): Promise<void> {
    if (this.sendMessageFn) {
      await this.sendMessageFn(chatId, body);
      return;
    }

    const client = this.wsClient as {
      sendMessage(chatId: string, body: Record<string, unknown>): Promise<unknown>;
    } | null;

    if (!client) {
      throw new Error('[WeComBotAdapter] sendMessage: wsClient not connected');
    }

    await client.sendMessage(chatId, body);
  }

  private async wecomUploadMedia(fileBuffer: Buffer, mediaType: string, filename: string): Promise<string | null> {
    if (this.uploadMediaFn) {
      const result = await this.uploadMediaFn(fileBuffer, { type: mediaType, filename });
      return result.media_id;
    }

    const client = this.wsClient as {
      uploadMedia(fileBuffer: Buffer, options: { type: string; filename: string }): Promise<{ media_id: string }>;
    } | null;

    if (!client) {
      this.log.warn('[WeComBotAdapter] uploadMedia: wsClient not connected');
      return null;
    }

    try {
      const result = await client.uploadMedia(fileBuffer, { type: mediaType, filename });
      return result.media_id;
    } catch (err) {
      this.log.warn({ err, mediaType, filename }, '[WeComBotAdapter] uploadMedia failed');
      return null;
    }
  }

  private async wecomSendMediaMessage(chatId: string, mediaType: string, mediaId: string): Promise<void> {
    if (this.sendMediaMessageFn) {
      await this.sendMediaMessageFn(chatId, mediaType, mediaId);
      return;
    }

    const client = this.wsClient as {
      sendMediaMessage(chatId: string, mediaType: string, mediaId: string): Promise<unknown>;
    } | null;

    if (!client) {
      throw new Error('[WeComBotAdapter] sendMediaMessage: wsClient not connected');
    }

    await client.sendMediaMessage(chatId, mediaType, mediaId);
  }

  // ── Test Helpers ──

  /** @internal */
  _injectReplyStream(
    fn: (
      frame: { headers: { req_id: string } },
      streamId: string,
      content: string,
      finish?: boolean,
    ) => Promise<unknown>,
  ): void {
    this.replyStreamFn = fn;
  }

  /** @internal */
  _injectSendMessage(fn: (chatId: string, body: Record<string, unknown>) => Promise<unknown>): void {
    this.sendMessageFn = fn;
  }

  /** @internal */
  _injectUploadMedia(
    fn: (fileBuffer: Buffer, options: { type: string; filename: string }) => Promise<{ media_id: string }>,
  ): void {
    this.uploadMediaFn = fn;
  }

  /** @internal */
  _injectSendMediaMessage(fn: (chatId: string, mediaType: string, mediaId: string) => Promise<unknown>): void {
    this.sendMediaMessageFn = fn;
  }

  /** @internal */
  _injectReplyTemplateCard(
    fn: (frame: { headers: { req_id: string } }, templateCard: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.replyTemplateCardFn = fn;
  }

  /** @internal */
  _injectUpdateTemplateCard(
    fn: (
      frame: { headers: { req_id: string } },
      templateCard: Record<string, unknown>,
      userids?: string[],
    ) => Promise<unknown>,
  ): void {
    this.updateTemplateCardFn = fn;
  }

  /** @internal */
  _injectDownloadFile(fn: (url: string, aesKey?: string) => Promise<{ buffer: Buffer; filename?: string }>): void {
    this.downloadFileFn = fn;
  }

  /** @internal */
  _injectGenerateReqId(fn: (prefix: string) => string): void {
    this.generateReqIdFn = fn;
  }

  /** @internal — expose frame cache for testing */
  _setLastFrame(chatId: string, frame: { headers: { req_id: string; [key: string]: unknown } }): void {
    this.lastFrameByChat.set(chatId, frame);
  }

  /** @internal — expose group chatId set for testing */
  _getGroupChatIds(): Set<string> {
    return this.groupChatIds;
  }

  /** @internal — expose active streams for testing */
  _getActiveStreams(): Map<string, ActiveStream> {
    return this.activeStreams;
  }
}
