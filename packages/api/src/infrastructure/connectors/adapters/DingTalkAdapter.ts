/**
 * DingTalk (钉钉) Enterprise Bot Adapter
 * Inbound: Parse Stream events → extract DM messages
 * Outbound: Send reply via DingTalk OpenAPI + AI Card streaming
 *
 * Uses dingtalk-stream for Stream mode (no public URL needed).
 * AI Card for rich/streaming replies (create → streaming update → finish).
 *
 * F132 DingTalk + WeCom Chat Gateway — Phase A
 */

import { basename } from 'node:path';
import type { RichBlock } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyBaseLogger } from 'fastify';
import type { MessageEnvelope } from '../ConnectorMessageFormatter.js';
import type { IStreamableOutboundAdapter } from '../OutboundDeliveryHook.js';

// ── Types ──

export interface DingTalkAttachment {
  type: 'image' | 'file' | 'audio';
  /** DingTalk media download code (for images/files/audio) */
  downloadCode?: string;
  fileName?: string;
  duration?: number;
}

export interface DingTalkInboundMessage {
  /** DM: staffId | Group: openConversationId */
  chatId: string;
  /** DingTalk conversationId — used for AI Card delivery routing */
  conversationId: string;
  text: string;
  messageId: string;
  senderId: string;
  chatType: 'p2p' | 'group';
  /** Group: sender's display name from webhook payload */
  senderNick?: string;
  /** Group: chat title from webhook payload */
  conversationTitle?: string;
  attachments?: DingTalkAttachment[];
}

export interface DingTalkAdapterOptions {
  appKey: string;
  appSecret: string;
  /** Robot code (used for sending messages), defaults to appKey */
  robotCode?: string;
  /** Optional Redis client for persisting group chatId set across cold restarts. */
  redis?: RedisClient | undefined;
}

/** AI Card streaming state machine */
type CardState = 'PROCESSING' | 'INPUTING' | 'FINISHED';

interface ActiveCard {
  outTrackId: string;
  state: CardState;
  lastUpdateAt: number;
  lastContentLength: number;
}

// ── AI Card Throttle Config ──

const AI_CARD_THROTTLE_MS = 300;
const AI_CARD_TEMPLATE_ID = 'StandardCard';

// ── Adapter ──

export class DingTalkAdapter implements IStreamableOutboundAdapter {
  readonly connectorId = 'dingtalk';
  private readonly log: FastifyBaseLogger;
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly robotCode: string;
  private readonly redis: RedisClient | undefined;

  // Stream client (dingtalk-stream SDK)
  private streamClient: unknown = null;
  private stopFn: (() => Promise<void>) | null = null;

  // Active AI Card sessions (keyed by outTrackId)
  private readonly activeCards = new Map<string, ActiveCard>();

  // staffId → conversationId mapping (populated from inbound parseEvent)
  // AI Card delivery needs the real conversationId, but the public layer
  // passes externalChatId (= staffId) for outbound routing.
  private readonly staffToConversation = new Map<string, string>();
  private readonly groupConversationIds = new Set<string>();
  private readonly senderNickCache = new Map<string, string>();
  private readonly conversationTitleCache = new Map<string, string>();

  // DI injection points (for testing + runtime override)
  private sendMessageFn:
    | ((params: { chatId: string; content: string; msgType: string; chatType?: 'p2p' | 'group' }) => Promise<unknown>)
    | null = null;
  private createCardFn:
    | ((params: { outTrackId: string; cardData: Record<string, unknown> }) => Promise<unknown>)
    | null = null;
  private streamingCardFn:
    | ((params: { outTrackId: string; content: string; state: CardState }) => Promise<unknown>)
    | null = null;
  private accessTokenFn: (() => Promise<string>) | null = null;
  private downloadMediaFn: ((downloadCode: string) => Promise<string>) | null = null;
  private uploadMediaFn: ((params: { filePath: string; type: string }) => Promise<string>) | null = null;

  constructor(log: FastifyBaseLogger, options: DingTalkAdapterOptions) {
    this.log = log;
    this.appKey = options.appKey;
    this.appSecret = options.appSecret;
    this.robotCode = options.robotCode ?? options.appKey;
    this.redis = options.redis;
  }

  // ── Inbound: Parse Stream Event ──

  /**
   * Parse a DingTalk Stream bot message callback into an inbound message.
   * Supports text, richText, picture, audio, file message types.
   * Returns null for group or unsupported events.
   *
   * AC-A1: DM text + richText parsing
   */
  parseEvent(eventBody: unknown): DingTalkInboundMessage | null {
    if (!eventBody || typeof eventBody !== 'object') return null;

    const body = eventBody as Record<string, unknown>;

    const msgType = body.msgtype as string | undefined;
    if (!msgType) return null;

    const conversationType = body.conversationType as string | undefined;
    if (conversationType !== '1' && conversationType !== '2') return null;

    const isGroup = conversationType === '2';
    const chatType: 'p2p' | 'group' = isGroup ? 'group' : 'p2p';
    const conversationId = (body.conversationId as string) ?? '';
    const openConversationId = (body.openConversationId as string) ?? '';
    const conversationTitle = (body.conversationTitle as string) ?? undefined;
    const messageId = (body.msgId as string) ?? '';
    const senderStaffId = (body.senderStaffId as string) ?? (body.senderId as string) ?? 'unknown';
    const senderNick = (body.senderNick as string) ?? undefined;
    const chatId = isGroup ? openConversationId : senderStaffId;

    const base = {
      chatId,
      conversationId,
      messageId,
      senderId: senderStaffId,
      chatType,
      senderNick,
      conversationTitle,
    };

    if (conversationId) this.staffToConversation.set(senderStaffId, conversationId);
    if (isGroup && openConversationId) {
      this.groupConversationIds.add(openConversationId);
      if (senderNick) this.senderNickCache.set(senderStaffId, senderNick);
      if (conversationTitle) this.conversationTitleCache.set(openConversationId, conversationTitle);
    }

    switch (msgType) {
      case 'text': {
        const textObj = body.text as Record<string, unknown> | undefined;
        const text = textObj?.content as string | undefined;
        if (!text) return null;
        return { ...base, text: text.trim() };
      }
      case 'richText': {
        // DingTalk Stream FAQ confirms: body.richText is a flat array
        const richContent = Array.isArray(body.richText) ? (body.richText as unknown[]) : null;
        if (!richContent) return null;
        const textParts: string[] = [];
        const attachments: DingTalkAttachment[] = [];
        for (const node of richContent) {
          const n = node as Record<string, unknown>;
          if (n.text) textParts.push(String(n.text));
          if (n.type === 'picture' && n.downloadCode) {
            attachments.push({ type: 'image', downloadCode: String(n.downloadCode) });
          }
        }
        const text = textParts.join('') || '[富文本]';
        return { ...base, text, ...(attachments.length > 0 ? { attachments } : {}) };
      }
      case 'picture': {
        const downloadCode = (body.content as Record<string, unknown>)?.downloadCode as string | undefined;
        return {
          ...base,
          text: '[图片]',
          attachments: downloadCode ? [{ type: 'image' as const, downloadCode }] : undefined,
        };
      }
      case 'audio': {
        const audioBody = body.content as Record<string, unknown> | undefined;
        const downloadCode = audioBody?.downloadCode as string | undefined;
        const duration = audioBody?.duration as number | undefined;
        return {
          ...base,
          text: '[语音]',
          attachments: downloadCode
            ? [{ type: 'audio' as const, downloadCode, ...(duration != null ? { duration } : {}) }]
            : undefined,
        };
      }
      case 'file': {
        const fileBody = body.content as Record<string, unknown> | undefined;
        const downloadCode = fileBody?.downloadCode as string | undefined;
        const fileName = fileBody?.fileName as string | undefined;
        return {
          ...base,
          text: fileName ? `[文件] ${fileName}` : '[文件]',
          attachments: downloadCode
            ? [{ type: 'file' as const, downloadCode, ...(fileName ? { fileName } : {}) }]
            : undefined,
        };
      }
      default:
        return null;
    }
  }

  // ── Name Resolution (AC-A2.5) ──

  /**
   * Resolve sender display name from cached inbound event data.
   * DingTalk group webhooks include senderNick, so no API call needed.
   */
  resolveSenderName(staffId: string): string | undefined {
    return this.senderNickCache.get(staffId);
  }

  /**
   * Resolve group conversation title from cached inbound event data.
   * DingTalk group webhooks include conversationTitle, so no API call needed.
   */
  resolveConversationTitle(openConversationId: string): string | undefined {
    return this.conversationTitleCache.get(openConversationId);
  }

  private static readonly REDIS_GROUP_IDS_KEY = 'dingtalk-group-chat-ids';

  registerGroupChatId(chatId: string): void {
    this.groupConversationIds.add(chatId);
    this.redis?.sadd(DingTalkAdapter.REDIS_GROUP_IDS_KEY, chatId).catch(() => {});
  }

  async hydrateGroupChatIds(): Promise<void> {
    if (!this.redis) return;
    try {
      const ids = await this.redis.smembers(DingTalkAdapter.REDIS_GROUP_IDS_KEY);
      for (const id of ids) this.groupConversationIds.add(id);
      this.log.info({ count: ids.length }, '[DingTalkAdapter] Hydrated group chatIds from Redis');
    } catch (err) {
      this.log.warn({ err }, '[DingTalkAdapter] Failed to hydrate group chatIds from Redis');
    }
  }

  // ── Outbound: Send Messages ──

  /**
   * Prepend @sender mention for group chat replies (AC-A2.4).
   * Only used for group chats — DM replies must NOT @mention (Feishu AC-C2 pattern).
   */
  private prependAtSender(content: string, sender: { id: string; name?: string }): string {
    const name = sender.name ?? this.senderNickCache.get(sender.id) ?? '用户';
    return `@${name} ${content}`;
  }

  /**
   * Send a plain text reply via DingTalk Robot API.
   * AC-A2: Basic text + markdown sending
   */
  async sendReply(externalChatId: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    const metaChatType = (metadata as { chatType?: 'p2p' | 'group' } | undefined)?.chatType;
    const isGroup = metaChatType === 'group' || this.groupConversationIds.has(externalChatId);
    const sender = (metadata as { replyToSender?: { id: string; name?: string } } | undefined)?.replyToSender;
    const text = isGroup && sender ? this.prependAtSender(content, sender) : content;
    await this.sendDingTalkMessage(externalChatId, 'text', { content: text }, isGroup ? 'group' : undefined);
  }

  /**
   * Send a markdown reply.
   */
  async sendMarkdown(
    externalChatId: string,
    title: string,
    text: string,
    chatTypeOverride?: 'p2p' | 'group',
  ): Promise<void> {
    await this.sendDingTalkMessage(externalChatId, 'markdown', { title, text }, chatTypeOverride);
  }

  /**
   * Send a rich block message (convert blocks to markdown text).
   */
  async sendRichMessage(
    externalChatId: string,
    textContent: string,
    _blocks: RichBlock[],
    catDisplayName: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const chatTypeOverride = (metadata as { chatType?: 'p2p' | 'group' } | undefined)?.chatType;
    const title = `🐱 ${catDisplayName}`;
    await this.sendMarkdown(externalChatId, title, textContent, chatTypeOverride);
  }

  /**
   * Send a formatted reply as AI Card.
   * AC-A3: AI Card with cat name header + body + deep link
   */
  async sendFormattedReply(
    externalChatId: string,
    envelope: MessageEnvelope,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const metaChatType = (metadata as { chatType?: 'p2p' | 'group' } | undefined)?.chatType;
    const chatTypeOverride = metaChatType === 'group' ? 'group' : undefined;
    const isCallback = envelope.origin === 'callback';
    const headerTitle = isCallback ? `📨 ${envelope.header} · 传话` : envelope.header;

    // Build markdown body for AI Card
    let body = '';
    if (envelope.subtitle) {
      body += `**${envelope.subtitle}**\n\n`;
    }
    body += envelope.body;
    if (envelope.footer) {
      body += `\n\n---\n${envelope.footer}`;
    }

    // Try AI Card first, fall back to markdown
    try {
      await this.sendAICard(externalChatId, headerTitle, body, chatTypeOverride);
    } catch (err) {
      this.log.warn({ err }, '[DingTalkAdapter] AI Card sendFormattedReply failed, falling back to markdown');
      await this.sendMarkdown(externalChatId, headerTitle, body, chatTypeOverride);
    }
  }

  // ── Streaming: AI Card ──

  /**
   * Send a placeholder AI Card and return its outTrackId.
   * AC-A4: AI Card streaming (create phase)
   */
  async sendPlaceholder(externalChatId: string, text: string): Promise<string> {
    const outTrackId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      await this.createAICardInstance(externalChatId, outTrackId, text);

      this.activeCards.set(outTrackId, {
        outTrackId,
        state: 'PROCESSING',
        lastUpdateAt: 0,
        lastContentLength: 0,
      });

      return outTrackId;
    } catch (err) {
      this.log.warn({ err }, '[DingTalkAdapter] sendPlaceholder failed');
      return '';
    }
  }

  /**
   * Edit an AI Card via streaming update.
   * AC-A4: AI Card streaming (update phase, 300ms throttle)
   */
  async editMessage(_externalChatId: string, platformMessageId: string, text: string): Promise<void> {
    const card = this.activeCards.get(platformMessageId);
    if (!card) {
      this.log.warn({ platformMessageId }, '[DingTalkAdapter] editMessage: no active card found');
      return;
    }

    // 300ms throttle (AC-A4)
    const now = Date.now();
    if (now - card.lastUpdateAt < AI_CARD_THROTTLE_MS) return;

    try {
      // Transition to INPUTING if still PROCESSING
      const newState: CardState = card.state === 'PROCESSING' ? 'INPUTING' : card.state;

      await this.updateAICardStreaming(platformMessageId, text, newState);

      card.state = newState;
      card.lastUpdateAt = now;
      card.lastContentLength = text.length;
    } catch (err) {
      this.log.warn({ err, platformMessageId }, '[DingTalkAdapter] editMessage streaming update failed');
    }
  }

  /**
   * Delete/finish an AI Card (transition to FINISHED state).
   * StreamingOutboundHook calls this for cleanup.
   */
  async deleteMessage(platformMessageId: string): Promise<void> {
    const card = this.activeCards.get(platformMessageId);
    if (!card) return;

    try {
      await this.updateAICardStreaming(platformMessageId, '', 'FINISHED');
    } catch (err) {
      this.log.warn({ err, platformMessageId }, '[DingTalkAdapter] deleteMessage (finish card) failed');
    } finally {
      this.activeCards.delete(platformMessageId);
    }
  }

  // ── Media ──

  /**
   * Send a media message (image, file, audio).
   * AC-A5: Media upload + send
   */
  async sendMedia(
    externalChatId: string,
    payload: {
      type: 'image' | 'file' | 'audio';
      url?: string;
      absPath?: string;
      fileName?: string;
      duration?: number;
      [key: string]: unknown;
    },
  ): Promise<void> {
    const url = typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : undefined;
    const absPath = typeof payload.absPath === 'string' && payload.absPath.length > 0 ? payload.absPath : undefined;

    // Path 1: Image with URL — direct photoURL fast path (no upload needed)
    if (payload.type === 'image' && url && !absPath) {
      await this.sendDingTalkImageMessage(externalChatId, url);
      return;
    }

    // Path 2: Has absPath → native media sending via upload
    if (absPath) {
      try {
        const mediaId = await this.uploadToDingTalk(absPath, payload.type);
        if (mediaId) {
          await this.sendDingTalkMediaMessage(externalChatId, payload.type, mediaId, {
            fileName: payload.fileName ?? basename(absPath),
            duration: payload.duration,
          });
          return;
        }
      } catch (err) {
        this.log.warn(
          { err, type: payload.type, absPath },
          '[DingTalkAdapter] sendMedia: upload failed, falling through',
        );
      }
    }

    // Path 3: Fallback — text link
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
    this.log.warn({ type: payload.type }, '[DingTalkAdapter] sendMedia: no URL available, skipping');
  }

  /**
   * Download media file from an inbound message using its downloadCode.
   * Returns a temporary download URL.
   * AC-A5: Inbound media download via POST /v1.0/robot/messageFiles/download
   */
  async downloadMedia(downloadCode: string): Promise<string> {
    if (this.downloadMediaFn) return this.downloadMediaFn(downloadCode);

    const accessToken = await this.getAccessToken();
    const url = 'https://api.dingtalk.com/v1.0/robot/messageFiles/download';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify({ downloadCode, robotCode: this.robotCode }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      throw new Error(`DingTalk media download error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { downloadUrl?: string };
    if (!data.downloadUrl) throw new Error('DingTalk media download: missing downloadUrl in response');
    return data.downloadUrl;
  }

  // ── Stream Connection ──

  /**
   * Start the DingTalk Stream connection (long-lived, like Telegram polling).
   * Calls onMessage for each inbound bot message.
   * AC-A7: Stream connection + reconnect + dedup
   */
  async startStream(onMessage: (msg: DingTalkInboundMessage) => Promise<void>): Promise<void> {
    try {
      const { DWClient, EventAck, TOPIC_ROBOT } = await import('dingtalk-stream');

      const client = new DWClient({
        clientId: this.appKey,
        clientSecret: this.appSecret,
        debug: false,
      });

      client.registerCallbackListener(TOPIC_ROBOT, async (res: unknown) => {
        const downstream = res as { headers?: { messageId?: string }; data?: string };
        const messageId = downstream.headers?.messageId ?? '';
        try {
          const data = downstream.data ? JSON.parse(downstream.data) : null;
          if (!data) return;

          const parsed = this.parseEvent(data);
          if (parsed) {
            await onMessage(parsed);
          }
        } catch (err) {
          this.log.error({ err }, '[DingTalkAdapter] Stream message handler error');
        } finally {
          // Always ACK to prevent 60s retry (guard: SDK throws if messageId is empty)
          if (messageId) client.socketCallBackResponse(messageId, EventAck.SUCCESS);
        }
      });

      await client.connect();
      this.streamClient = client;
      this.stopFn = async () => {
        try {
          client.disconnect();
        } catch {
          // ignore disconnect errors
        }
      };

      this.log.info('[DingTalkAdapter] Stream connection established');
    } catch (err) {
      this.log.error({ err }, '[DingTalkAdapter] Failed to start Stream connection');
      throw err;
    }
  }

  /**
   * Stop the Stream connection.
   */
  async stopStream(): Promise<void> {
    if (this.stopFn) {
      await this.stopFn();
      this.stopFn = null;
      this.streamClient = null;
      this.log.info('[DingTalkAdapter] Stream connection stopped');
    }
  }

  // ── Private: DingTalk OpenAPI Calls ──

  private async postRobotMessage(
    chatId: string,
    msgKey: string,
    msgParam: Record<string, unknown>,
    diMsgType: string,
    errorLabel: string,
    chatTypeOverride?: 'p2p' | 'group',
  ): Promise<unknown> {
    const isGroup = chatTypeOverride === 'group' || this.groupConversationIds.has(chatId);

    if (this.sendMessageFn) {
      return this.sendMessageFn({
        chatId,
        content: JSON.stringify(msgParam),
        msgType: diMsgType,
        chatType: isGroup ? 'group' : 'p2p',
      });
    }

    const accessToken = await this.getAccessToken();
    const url = isGroup
      ? 'https://api.dingtalk.com/v1.0/robot/orgGroupSend'
      : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

    const payload = isGroup
      ? { robotCode: this.robotCode, openConversationId: chatId, msgKey, msgParam: JSON.stringify(msgParam) }
      : { robotCode: this.robotCode, userIds: [chatId], msgKey, msgParam: JSON.stringify(msgParam) };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      throw new Error(`DingTalk ${errorLabel} error ${res.status}: ${body}`);
    }

    return res.json();
  }

  private async sendDingTalkMessage(
    chatId: string,
    msgType: string,
    msgContent: Record<string, unknown>,
    chatTypeOverride?: 'p2p' | 'group',
  ): Promise<unknown> {
    const msgKey = msgType === 'text' ? 'sampleText' : 'sampleMarkdown';
    return this.postRobotMessage(chatId, msgKey, msgContent, msgType, 'send', chatTypeOverride);
  }

  private async sendDingTalkImageMessage(
    chatId: string,
    photoURL: string,
    chatTypeOverride?: 'p2p' | 'group',
  ): Promise<unknown> {
    return this.postRobotMessage(chatId, 'sampleImageMsg', { photoURL }, 'image', 'image send', chatTypeOverride);
  }

  private async uploadToDingTalk(absPath: string, type: string): Promise<string | null> {
    if (this.uploadMediaFn) {
      return this.uploadMediaFn({ filePath: absPath, type });
    }

    const accessToken = await this.getAccessToken();
    const uploadUrl = 'https://api.dingtalk.com/v1.0/robot/messageFiles/upload';

    const { readFile } = await import('node:fs/promises');
    const fileBuffer = await readFile(absPath);
    const fileName = basename(absPath);

    const formData = new FormData();
    formData.append('robotCode', this.robotCode);
    formData.append('mediaType', type === 'image' ? 'image' : 'file');
    formData.append('file', new Blob([fileBuffer]), fileName);

    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      this.log.warn({ status: res.status, body }, '[DingTalkAdapter] uploadToDingTalk failed');
      return null;
    }

    const data = (await res.json()) as { mediaId?: string };
    return data.mediaId ?? null;
  }

  private async sendDingTalkMediaMessage(
    chatId: string,
    type: 'image' | 'file' | 'audio',
    mediaId: string,
    meta: { fileName?: string; duration?: number },
    chatTypeOverride?: 'p2p' | 'group',
  ): Promise<unknown> {
    const msgKeyMap: Record<string, { msgKey: string; buildParam: () => Record<string, unknown> }> = {
      audio: {
        msgKey: 'sampleAudio',
        buildParam: () => ({ mediaId, duration: String(meta.duration ?? 0) }),
      },
      file: {
        msgKey: 'sampleFile',
        buildParam: () => ({
          mediaId,
          fileName: meta.fileName ?? 'file',
          fileType: (meta.fileName ?? 'file').split('.').pop() ?? '',
        }),
      },
      image: {
        msgKey: 'sampleImageMsg',
        buildParam: () => ({ photoURL: mediaId }),
      },
    };

    const entry = msgKeyMap[type];
    if (!entry) throw new Error(`Unsupported media type for DingTalk: ${type}`);

    return this.postRobotMessage(
      chatId,
      entry.msgKey,
      entry.buildParam(),
      entry.msgKey,
      'media send',
      chatTypeOverride,
    );
  }

  /**
   * Create an AI Card instance and deliver it.
   * POST /v1.0/card/instances/createAndDeliver
   */
  private async createAICardInstance(
    chatId: string,
    outTrackId: string,
    headerText: string,
    chatTypeOverride?: 'p2p' | 'group',
  ): Promise<void> {
    const isGroup = chatTypeOverride === 'group' || this.groupConversationIds.has(chatId);

    if (!isGroup) {
      const conversationId = this.staffToConversation.get(chatId);
      if (!conversationId) {
        throw new Error(`No conversationId mapped for staffId=${chatId}; AI Card requires a prior inbound message`);
      }

      if (this.createCardFn) {
        await this.createCardFn({ outTrackId, cardData: { headerText, conversationId, chatType: 'p2p' } });
        return;
      }

      const accessToken = await this.getAccessToken();
      const url = 'https://api.dingtalk.com/v1.0/card/instances/createAndDeliver';

      const cardData = {
        outTrackId,
        cardTemplateId: AI_CARD_TEMPLATE_ID,
        cardData: {
          cardParamMap: {
            title: headerText,
            content: '...',
            status: 'PROCESSING',
          },
        },
        imRobotOpenDeliverModel: {
          spaceType: 'IM_ROBOT',
          robotCode: this.robotCode,
          extension: JSON.stringify({
            conversationType: '1',
            conversationId,
          }),
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify(cardData),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '(unreadable)');
        throw new Error(`DingTalk AI Card create error ${res.status}: ${body}`);
      }
      return;
    }

    if (this.createCardFn) {
      await this.createCardFn({
        outTrackId,
        cardData: { headerText, chatType: 'group', openConversationId: chatId },
      });
      return;
    }

    const accessToken = await this.getAccessToken();
    const url = 'https://api.dingtalk.com/v1.0/card/instances/createAndDeliver';

    const cardData = {
      outTrackId,
      cardTemplateId: AI_CARD_TEMPLATE_ID,
      cardData: {
        cardParamMap: {
          title: headerText,
          content: '...',
          status: 'PROCESSING',
        },
      },
      imGroupOpenSpaceModel: {
        supportForward: true,
      },
      imGroupOpenDeliverModel: {
        robotCode: this.robotCode,
        openConversationId: chatId,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify(cardData),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      throw new Error(`DingTalk AI Card group create error ${res.status}: ${body}`);
    }
  }

  /**
   * Update an AI Card streaming content.
   * PUT /v1.0/card/streaming
   * State machine: PROCESSING → INPUTING → FINISHED
   */
  private async updateAICardStreaming(outTrackId: string, content: string, state: CardState): Promise<void> {
    if (this.streamingCardFn) {
      await this.streamingCardFn({ outTrackId, content, state });
      return;
    }

    const accessToken = await this.getAccessToken();
    const url = 'https://api.dingtalk.com/v1.0/card/streaming';

    const payload = {
      outTrackId,
      key: 'content',
      content,
      isFull: true,
      isFinalize: state === 'FINISHED',
      guid: `${outTrackId}-${Date.now()}`,
    };

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      throw new Error(`DingTalk AI Card streaming error ${res.status}: ${body}`);
    }
  }

  /**
   * Send an AI Card with title and markdown body (non-streaming, single shot).
   */
  private async sendAICard(
    staffId: string,
    title: string,
    body: string,
    chatTypeOverride?: 'p2p' | 'group',
  ): Promise<void> {
    const outTrackId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.createAICardInstance(staffId, outTrackId, title, chatTypeOverride);
    await this.updateAICardStreaming(outTrackId, body, 'FINISHED');
  }

  /**
   * Get DingTalk access token (cached, 2h TTL).
   */
  private cachedToken: { token: string; expiresAt: number } | null = null;

  private async getAccessToken(): Promise<string> {
    if (this.accessTokenFn) return this.accessTokenFn();

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) {
      return this.cachedToken.token;
    }

    const url = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.appKey, appSecret: this.appSecret }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      throw new Error(`DingTalk accessToken error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { accessToken?: string; expireIn?: number };
    const token = data.accessToken;
    if (!token) throw new Error('DingTalk accessToken response missing token');

    // expireIn is in seconds, cache with 5-minute safety margin
    const expiresAt = now + (data.expireIn ?? 7200) * 1000;
    this.cachedToken = { token, expiresAt };
    return token;
  }

  // ── Test Helpers ──

  /** @internal */
  _injectSendMessage(
    fn: (params: { chatId: string; content: string; msgType: string; chatType?: 'p2p' | 'group' }) => Promise<unknown>,
  ): void {
    this.sendMessageFn = fn;
  }

  /** @internal */
  _injectCreateCard(fn: (params: { outTrackId: string; cardData: Record<string, unknown> }) => Promise<unknown>): void {
    this.createCardFn = fn;
  }

  /** @internal */
  _injectStreamingCard(
    fn: (params: { outTrackId: string; content: string; state: CardState }) => Promise<unknown>,
  ): void {
    this.streamingCardFn = fn;
  }

  /** @internal */
  _injectAccessToken(fn: () => Promise<string>): void {
    this.accessTokenFn = fn;
  }

  /** @internal */
  _injectDownloadMedia(fn: (downloadCode: string) => Promise<string>): void {
    this.downloadMediaFn = fn;
  }

  /** @internal */
  _injectUploadMedia(fn: (params: { filePath: string; type: string }) => Promise<string>): void {
    this.uploadMediaFn = fn;
  }
}
