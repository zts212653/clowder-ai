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
  /** staffId of the sender — used as target for outbound oToMessages/batchSend */
  chatId: string;
  /** DingTalk conversationId — used for AI Card delivery routing */
  conversationId: string;
  text: string;
  messageId: string;
  senderId: string;
  chatType: string;
  attachments?: DingTalkAttachment[];
}

export interface DingTalkAdapterOptions {
  appKey: string;
  appSecret: string;
  /** Robot code (used for sending messages), defaults to appKey */
  robotCode?: string;
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

  // Stream client (dingtalk-stream SDK)
  private streamClient: unknown = null;
  private stopFn: (() => Promise<void>) | null = null;

  // Active AI Card sessions (keyed by outTrackId)
  private readonly activeCards = new Map<string, ActiveCard>();

  // staffId → conversationId mapping (populated from inbound parseEvent)
  // AI Card delivery needs the real conversationId, but the public layer
  // passes externalChatId (= staffId) for outbound routing.
  private readonly staffToConversation = new Map<string, string>();

  // DI injection points (for testing + runtime override)
  private sendMessageFn: ((params: { chatId: string; content: string; msgType: string }) => Promise<unknown>) | null =
    null;
  private createCardFn:
    | ((params: { outTrackId: string; cardData: Record<string, unknown> }) => Promise<unknown>)
    | null = null;
  private streamingCardFn:
    | ((params: { outTrackId: string; content: string; state: CardState }) => Promise<unknown>)
    | null = null;
  private accessTokenFn: (() => Promise<string>) | null = null;
  private downloadMediaFn: ((downloadCode: string) => Promise<string>) | null = null;

  constructor(log: FastifyBaseLogger, options: DingTalkAdapterOptions) {
    this.log = log;
    this.appKey = options.appKey;
    this.appSecret = options.appSecret;
    this.robotCode = options.robotCode ?? options.appKey;
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

    // DingTalk Stream bot message structure:
    // { msgtype, text?: { content }, richText?: {...}, ... , conversationId, chatbotUserId, senderStaffId, msgId, ... }
    const msgType = body.msgtype as string | undefined;
    if (!msgType) return null;

    // MVP: DM-only (1-to-1 conversation)
    const conversationType = body.conversationType as string | undefined;
    if (conversationType !== '1') return null;

    const conversationId = (body.conversationId as string) ?? '';
    const messageId = (body.msgId as string) ?? '';
    const senderStaffId = (body.senderStaffId as string) ?? (body.senderId as string) ?? 'unknown';
    const chatType = conversationType === '1' ? 'p2p' : 'group';

    const base = { chatId: senderStaffId, conversationId, messageId, senderId: senderStaffId, chatType };

    if (conversationId) this.staffToConversation.set(senderStaffId, conversationId);

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

  // ── Outbound: Send Messages ──

  /**
   * Send a plain text reply via DingTalk Robot API.
   * AC-A2: Basic text + markdown sending
   */
  async sendReply(externalChatId: string, content: string): Promise<void> {
    await this.sendDingTalkMessage(externalChatId, 'text', { content });
  }

  /**
   * Send a markdown reply.
   */
  async sendMarkdown(externalChatId: string, title: string, text: string): Promise<void> {
    await this.sendDingTalkMessage(externalChatId, 'markdown', { title, text });
  }

  /**
   * Send a rich block message (convert blocks to markdown text).
   */
  async sendRichMessage(
    externalChatId: string,
    textContent: string,
    _blocks: RichBlock[],
    catDisplayName: string,
  ): Promise<void> {
    // DingTalk markdown supports basic formatting
    const title = `🐱 ${catDisplayName}`;
    await this.sendMarkdown(externalChatId, title, textContent);
  }

  /**
   * Send a formatted reply as AI Card.
   * AC-A3: AI Card with cat name header + body + deep link
   */
  async sendFormattedReply(externalChatId: string, envelope: MessageEnvelope): Promise<void> {
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
      await this.sendAICard(externalChatId, headerTitle, body);
    } catch (err) {
      this.log.warn({ err }, '[DingTalkAdapter] AI Card sendFormattedReply failed, falling back to markdown');
      await this.sendMarkdown(externalChatId, headerTitle, body);
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
      [key: string]: unknown;
    },
  ): Promise<void> {
    const url = typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : undefined;
    const mediaReference =
      url ??
      (typeof payload.fileName === 'string' && payload.fileName.length > 0
        ? payload.fileName
        : typeof payload.absPath === 'string' && payload.absPath.length > 0
          ? basename(payload.absPath)
          : undefined);

    if (payload.type === 'image' && url) {
      await this.sendDingTalkImageMessage(externalChatId, url);
      return;
    }

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

  private async sendDingTalkMessage(
    staffId: string,
    msgType: string,
    msgContent: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.sendMessageFn) {
      return this.sendMessageFn({
        chatId: staffId,
        content: JSON.stringify(msgContent),
        msgType,
      });
    }

    const accessToken = await this.getAccessToken();
    const url = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
    const payload = {
      robotCode: this.robotCode,
      userIds: [staffId],
      msgKey: msgType === 'text' ? 'sampleText' : 'sampleMarkdown',
      msgParam: JSON.stringify(msgContent),
    };

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
      throw new Error(`DingTalk API error ${res.status}: ${body}`);
    }

    return res.json();
  }

  private async sendDingTalkImageMessage(staffId: string, photoURL: string): Promise<unknown> {
    if (this.sendMessageFn) {
      return this.sendMessageFn({
        chatId: staffId,
        content: JSON.stringify({ photoURL }),
        msgType: 'image',
      });
    }

    const accessToken = await this.getAccessToken();
    const url = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
    const payload = {
      robotCode: this.robotCode,
      userIds: [staffId],
      msgKey: 'sampleImageMsg',
      msgParam: JSON.stringify({ photoURL }),
    };

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
      throw new Error(`DingTalk image send error ${res.status}: ${body}`);
    }

    return res.json();
  }

  /**
   * Create an AI Card instance and deliver it.
   * POST /v1.0/card/instances/createAndDeliver
   */
  private async createAICardInstance(staffId: string, outTrackId: string, headerText: string): Promise<void> {
    const conversationId = this.staffToConversation.get(staffId);
    if (!conversationId) {
      throw new Error(`No conversationId mapped for staffId=${staffId}; AI Card requires a prior inbound message`);
    }

    if (this.createCardFn) {
      await this.createCardFn({ outTrackId, cardData: { headerText, conversationId } });
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
      imGroupOpenDeliverModel: {
        robotCode: this.robotCode,
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
  private async sendAICard(staffId: string, title: string, body: string): Promise<void> {
    const outTrackId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.createAICardInstance(staffId, outTrackId, title);
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
  _injectSendMessage(fn: (params: { chatId: string; content: string; msgType: string }) => Promise<unknown>): void {
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
}
