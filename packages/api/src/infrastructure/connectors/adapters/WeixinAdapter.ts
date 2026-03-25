/**
 * WeChat Personal (iLink Bot) Adapter
 * Inbound: Long-poll via /ilink/bot/getupdates → parse text messages
 * Outbound: Send reply via /ilink/bot/sendmessage (requires context_token)
 *
 * Uses Tencent's iLink Bot protocol for personal WeChat accounts.
 * No SDK dependency — pure HTTP (fetch) implementation.
 *
 * MVP: DM-only, text-only, single-account.
 *
 * F137 WeChat Personal Gateway
 */

import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { IOutboundAdapter } from '../OutboundDeliveryHook.js';

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const GETUPDATES_TIMEOUT_MS = 35_000;
const POLL_ERROR_BACKOFF_MS = 3_000;
const POLL_MAX_BACKOFF_MS = 60_000;
// Chunking disabled: iLink only delivers the first sendmessage per context_token turn.
// All content is sent in a single call. See BUG-3 in F137 spec.
/** Debounce window for aggregating multi-cat replies into one outbound message (ms) */
const WEIXIN_REPLY_DEBOUNCE_MS = 3_000;
/** Typing keepalive interval (ms) — openclaw v2 uses 5s */
const TYPING_KEEPALIVE_MS = 5_000;
/** errcode -14 means session expired — need re-login */
const ERRCODE_SESSION_EXPIRED = -14;
/** QR code status poll interval (ms) */
const QRCODE_POLL_INTERVAL_MS = 2_000;
/** iLink get_qrcode_status is a ~30 s long-poll; timeout must exceed that */
const QRCODE_STATUS_POLL_TIMEOUT_MS = 40_000;
/** QR code timeout (5 minutes) */
const QRCODE_TIMEOUT_MS = 5 * 60 * 1000;

function generateClientId(): string {
  return `cat-cafe-weixin-${crypto.randomUUID()}`;
}

// ── iLink Bot API types ──

export interface WeixinInboundMessage {
  chatId: string;
  text: string;
  messageId: string;
  senderId: string;
  contextToken: string;
  attachments?: WeixinAttachment[];
}

export interface WeixinAttachment {
  type: 'image' | 'file' | 'audio';
  /** CDN URL or media key */
  mediaUrl: string;
  fileName?: string;
}

/**
 * iLink getupdates response — aligned with @tencent-weixin/openclaw-weixin v1.0.2
 * (GetUpdatesResp in src/api/types.ts).
 */
interface ILinkUpdate {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: ILinkWeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

/** MessageItem inside a WeixinMessage — matches openclaw-weixin MessageItem. */
interface ILinkMessageItem {
  type?: number; // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
  text_item?: { text?: string };
  image_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string };
    url?: string;
    aeskey?: string;
  };
  voice_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string };
    text?: string;
  };
  file_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string };
    file_name?: string;
  };
  video_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string };
  };
}

/**
 * iLink WeixinMessage — aligned with @tencent-weixin/openclaw-weixin v1.0.2
 * (WeixinMessage in src/api/types.ts).
 */
interface ILinkWeixinMessage {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  message_type?: number; // 1=USER, 2=BOT
  message_state?: number; // 0=NEW, 1=GENERATING, 2=FINISH
  item_list?: ILinkMessageItem[];
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
}

/** MessageItemType constants — mirrors openclaw-weixin. */
const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/** MessageState constants — mirrors openclaw-weixin. */
const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

interface ILinkSendResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

// ── QR code login API types ──

export interface WeixinQrCodeResult {
  qrUrl: string;
  qrPayload: string;
}

export type WeixinQrCodeStatus =
  | { status: 'waiting' }
  | { status: 'scanned' }
  | { status: 'confirmed'; botToken: string }
  | { status: 'expired' }
  | { status: 'error'; message: string };

interface ILinkQrCodeResponse {
  errcode?: number;
  errmsg?: string;
  ret?: number;
  qrcode_url?: string;
  qrcode_img_content?: string;
  qrcode?: string;
}

interface ILinkQrCodeStatusResponse {
  errcode?: number;
  errmsg?: string;
  ret?: number;
  status?: number | string;
  bot_token?: string;
}

// ── Adapter ──

export class WeixinAdapter implements IOutboundAdapter {
  readonly connectorId = 'weixin';

  private readonly log: FastifyBaseLogger;
  private botToken: string;
  private polling = false;
  private pollAbortController: AbortController | null = null;
  private consecutiveErrors = 0;
  private getUpdatesBuf = '';
  private readonly contextTokens = new Map<string, string>();
  /** Per-chatId: last consumed token — bounded by chatId count, naturally evicted when new token arrives */
  private readonly lastConsumedToken = new Map<string, string>();
  private readonly pendingReplies = new Map<
    string,
    {
      token: string;
      parts: string[];
      timer: ReturnType<typeof setTimeout>;
      resolvers: Array<{ resolve: () => void; reject: (err: Error) => void }>;
    }
  >();
  private fetchFn: typeof fetch = globalThis.fetch;
  private sessionExpiredCallback: (() => void) | null = null;
  private readonly typingTickets = new Map<string, string>();
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly typingEpoch = new Map<string, number>();

  constructor(botToken: string, log: FastifyBaseLogger) {
    this.botToken = botToken;
    this.log = log;
  }

  hasBotToken(): boolean {
    return this.botToken !== '';
  }

  setBotToken(token: string): void {
    this.botToken = token;
  }

  setOnSessionExpired(cb: () => void): void {
    this.sessionExpiredCallback = cb;
  }

  // ── Auth headers ──

  private getHeaders(): Record<string, string> {
    // X-WECHAT-UIN: random uint32 base64-encoded (protocol requirement)
    const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64');
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${this.botToken}`,
      'X-WECHAT-UIN': uin,
    };
  }

  // ── Inbound: Long-poll ──

  /**
   * Parse a raw iLink getupdates response into inbound messages.
   * Returns parsed messages and updated cursor.
   */
  parseUpdates(raw: ILinkUpdate): { messages: WeixinInboundMessage[]; newCursor: string; sessionExpired: boolean } {
    const errorCode = raw.errcode ?? raw.ret;

    if (errorCode === ERRCODE_SESSION_EXPIRED) {
      return { messages: [], newCursor: this.getUpdatesBuf, sessionExpired: true };
    }

    if (errorCode && errorCode !== 0) {
      this.log.warn({ ret: raw.ret, errcode: raw.errcode, errmsg: raw.errmsg }, '[WeixinAdapter] getupdates error');
      return { messages: [], newCursor: this.getUpdatesBuf, sessionExpired: false };
    }

    const newCursor = raw.get_updates_buf ?? this.getUpdatesBuf;
    const messages: WeixinInboundMessage[] = [];

    if (raw.msgs) {
      for (const msg of raw.msgs) {
        const parsed = this.parseMessage(msg);
        if (parsed) messages.push(parsed);
      }
    }

    return { messages, newCursor, sessionExpired: false };
  }

  /**
   * Parse a single iLink WeixinMessage into our standard format.
   * Uses item_list[].type to determine message kind (TEXT=1, IMAGE=2, VOICE=3, FILE=4, VIDEO=5).
   */
  private parseMessage(msg: ILinkWeixinMessage): WeixinInboundMessage | null {
    const senderId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!senderId || !contextToken) return null;

    const msgId =
      msg.message_id != null
        ? String(msg.message_id)
        : `weixin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const firstItem = msg.item_list?.[0];
    if (!firstItem) {
      this.log.debug({ messageId: msg.message_id }, '[WeixinAdapter] Message with empty item_list, skipping');
      return null;
    }

    const itemType = firstItem.type ?? MessageItemType.TEXT;

    if (itemType === MessageItemType.TEXT) {
      const text = firstItem.text_item?.text;
      if (!text) return null;
      return {
        chatId: senderId,
        text,
        messageId: msgId,
        senderId,
        contextToken,
      };
    }

    if (itemType === MessageItemType.IMAGE) {
      const imageUrl = firstItem.image_item?.url ?? '';
      return {
        chatId: senderId,
        text: '[图片]',
        messageId: msgId,
        senderId,
        contextToken,
        attachments: imageUrl ? [{ type: 'image', mediaUrl: imageUrl }] : undefined,
      };
    }

    if (itemType === MessageItemType.VOICE) {
      return {
        chatId: senderId,
        text: firstItem.voice_item?.text || '[语音]',
        messageId: msgId,
        senderId,
        contextToken,
      };
    }

    if (itemType === MessageItemType.FILE) {
      return {
        chatId: senderId,
        text: `[文件] ${firstItem.file_item?.file_name ?? ''}`.trim(),
        messageId: msgId,
        senderId,
        contextToken,
        attachments: [{ type: 'file', mediaUrl: '', fileName: firstItem.file_item?.file_name }],
      };
    }

    this.log.debug({ itemType, messageId: msg.message_id }, '[WeixinAdapter] Unsupported item type, skipping');
    return null;
  }

  /**
   * Start long-polling loop for inbound messages.
   * Similar pattern to TelegramAdapter.startPolling().
   */
  startPolling(handler: (msg: WeixinInboundMessage) => Promise<void>): void {
    if (this.polling) return;
    this.polling = true;
    this.consecutiveErrors = 0;

    const poll = async (): Promise<void> => {
      while (this.polling) {
        try {
          this.pollAbortController = new AbortController();
          const body: Record<string, unknown> = {
            get_updates_buf: this.getUpdatesBuf || '',
            base_info: { channel_version: '1.0.0' },
          };

          const res = await this.fetchFn(`${ILINK_BASE_URL}/ilink/bot/getupdates`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(body),
            signal: AbortSignal.any([
              this.pollAbortController.signal,
              AbortSignal.timeout(GETUPDATES_TIMEOUT_MS + 5_000),
            ]),
          });

          if (!res.ok) {
            throw new Error(`getupdates HTTP ${res.status}: ${res.statusText}`);
          }

          const raw = (await res.json()) as ILinkUpdate;
          const { messages, newCursor, sessionExpired } = this.parseUpdates(raw);

          if (messages.length > 0) {
            this.log.info({ count: messages.length }, '[WeixinAdapter] Received messages');
          }

          if (sessionExpired) {
            this.log.error('[WeixinAdapter] Session expired (errcode -14). Bot token invalid — need re-login.');
            this.polling = false;
            this.sessionExpiredCallback?.();
            break;
          }

          this.getUpdatesBuf = newCursor;
          this.consecutiveErrors = 0;

          for (const msg of messages) {
            const tokenHash = msg.contextToken.slice(-8);
            this.contextTokens.set(msg.chatId, msg.contextToken);
            this.log.info(
              { chatId: msg.chatId, tokenHash, consumed: this.lastConsumedToken.get(msg.chatId) === msg.contextToken },
              '[WeixinAdapter] Inbound token cached',
            );

            // Start typing indicator (non-blocking, epoch-guarded against stale starts)
            const epoch = (this.typingEpoch.get(msg.chatId) ?? 0) + 1;
            this.typingEpoch.set(msg.chatId, epoch);
            this.fetchTypingTicket(msg.chatId, msg.contextToken)
              .then(() => {
                if (this.typingEpoch.get(msg.chatId) === epoch) {
                  this.startTyping(msg.chatId);
                }
              })
              .catch(() => {});

            try {
              await handler(msg);
            } catch (err) {
              this.log.error({ err, chatId: msg.chatId }, '[WeixinAdapter] Handler error');
            }
          }
        } catch (err) {
          if (!this.polling) break;

          this.consecutiveErrors++;
          const backoff = Math.min(POLL_ERROR_BACKOFF_MS * 2 ** (this.consecutiveErrors - 1), POLL_MAX_BACKOFF_MS);
          this.log.warn(
            { err, consecutiveErrors: this.consecutiveErrors, backoffMs: backoff },
            '[WeixinAdapter] Poll error, backing off',
          );
          await this.sleep(backoff);
        }
      }
    };

    // Fire and forget — poll loop runs until stopPolling()
    poll().catch((err) => {
      this.log.error({ err }, '[WeixinAdapter] Poll loop crashed');
    });

    this.log.info('[WeixinAdapter] Long polling started');
  }

  /**
   * Stop long-polling gracefully.
   */
  async stopPolling(): Promise<void> {
    this.polling = false;
    this.pollAbortController?.abort();
    this.pollAbortController = null;
    // Clean up all typing timers
    for (const chatId of this.typingTimers.keys()) {
      this.stopTyping(chatId);
    }
    this.log.info('[WeixinAdapter] Long polling stopped');
  }

  // ── Typing indicator (iLink protocol: getconfig → sendtyping keepalive) ──

  async fetchTypingTicket(chatId: string, contextToken: string): Promise<void> {
    try {
      const res = await this.fetchFn(`${ILINK_BASE_URL}/ilink/bot/getconfig`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          ilink_user_id: chatId,
          context_token: contextToken,
          base_info: { channel_version: '1.0.0' },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.log.warn({ status: res.status }, '[WeixinAdapter] getconfig HTTP error');
        return;
      }
      const data = (await res.json()) as { typing_ticket?: string; ret?: number };
      if (data.typing_ticket) {
        this.typingTickets.set(chatId, data.typing_ticket);
        this.log.info({ chatId }, '[WeixinAdapter] typing_ticket acquired');
      }
    } catch (err) {
      this.log.warn({ err }, '[WeixinAdapter] getconfig failed (non-fatal)');
    }
  }

  startTyping(chatId: string): void {
    const ticket = this.typingTickets.get(chatId);
    if (!ticket) return;
    // Clear any existing keepalive timer for this chatId (no CANCEL — just stop the old interval)
    const oldTimer = this.typingTimers.get(chatId);
    if (oldTimer) clearInterval(oldTimer);
    const send = () => {
      this.fetchFn(`${ILINK_BASE_URL}/ilink/bot/sendtyping`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          ilink_user_id: chatId,
          typing_ticket: ticket,
          status: 1,
          base_info: { channel_version: '1.0.0' },
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch((err) => this.log.debug({ err }, '[WeixinAdapter] sendTyping error (non-fatal)'));
    };
    send();
    this.typingTimers.set(chatId, setInterval(send, TYPING_KEEPALIVE_MS));
  }

  stopTyping(chatId: string): void {
    // Bump epoch to invalidate any pending fetchTypingTicket→startTyping chain
    this.typingEpoch.set(chatId, (this.typingEpoch.get(chatId) ?? 0) + 1);
    const timer = this.typingTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(chatId);
    }
    const ticket = this.typingTickets.get(chatId);
    if (!ticket) return;
    this.fetchFn(`${ILINK_BASE_URL}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        ilink_user_id: chatId,
        typing_ticket: ticket,
        status: 2,
        base_info: { channel_version: '1.0.0' },
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }

  // ── Outbound: Send reply ──

  async sendReply(externalChatId: string, content: string): Promise<void> {
    const currentToken = this.contextTokens.get(externalChatId) ?? '';
    this.log.info(
      { chatId: externalChatId, contentLen: content.length, tokenHash: currentToken.slice(-8) || 'none' },
      '[WeixinAdapter] sendReply() queued for debounce',
    );

    // No token and no existing pending bucket → skip immediately (don't poison future buckets)
    if (!currentToken && !this.pendingReplies.has(externalChatId)) {
      this.log.warn(
        { chatId: externalChatId },
        '[WeixinAdapter] No context_token and no pending bucket — skipping reply',
      );
      return;
    }

    // If pending exists with a DIFFERENT token → flush old bucket first (isolate turns)
    const existing = this.pendingReplies.get(externalChatId);
    if (existing && currentToken && existing.token !== currentToken) {
      this.log.info(
        { chatId: externalChatId, oldTokenHash: existing.token.slice(-8), newTokenHash: currentToken.slice(-8) },
        '[WeixinAdapter] Token changed mid-debounce — flushing old bucket',
      );
      clearTimeout(existing.timer);
      await this.flushReply(externalChatId);
    }

    return new Promise<void>((resolve, reject) => {
      const pending = this.pendingReplies.get(externalChatId);
      if (pending && pending.token === currentToken) {
        // Same token — safe to merge into existing bucket
        pending.parts.push(content);
        pending.resolvers.push({ resolve, reject });
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => this.flushReply(externalChatId), WEIXIN_REPLY_DEBOUNCE_MS);
      } else if (pending) {
        // Different token bucket exists (created by concurrent sendReply during our flush await)
        // Refuse cross-token merge — content is still in the thread, not lost
        this.log.warn(
          { chatId: externalChatId, ownTokenHash: currentToken.slice(-8), bucketTokenHash: pending.token.slice(-8) },
          '[WeixinAdapter] Token mismatch during debounce — refusing cross-token merge',
        );
        resolve();
      } else {
        const timer = setTimeout(() => this.flushReply(externalChatId), WEIXIN_REPLY_DEBOUNCE_MS);
        this.pendingReplies.set(externalChatId, {
          token: currentToken,
          parts: [content],
          timer,
          resolvers: [{ resolve, reject }],
        });
      }
    });
  }

  private async flushReply(externalChatId: string): Promise<void> {
    const pending = this.pendingReplies.get(externalChatId);
    if (!pending) return;
    this.pendingReplies.delete(externalChatId);

    const { token: boundToken, parts, resolvers } = pending;
    const merged = parts.join('\n\n');

    const tokenHash = boundToken ? boundToken.slice(-8) : 'none';
    const isConsumed = this.lastConsumedToken.get(externalChatId) === boundToken;

    this.log.info(
      { chatId: externalChatId, partsCount: parts.length, mergedLen: merged.length, tokenHash, isConsumed },
      '[WeixinAdapter] flushReply() — sending aggregated reply',
    );

    if (!boundToken || isConsumed) {
      const reason = !boundToken ? 'no token' : 'token already consumed';
      this.log.warn(
        { chatId: externalChatId, reason, tokenHash },
        '[WeixinAdapter] Cannot send — context_token unavailable or consumed',
      );
      this.stopTyping(externalChatId);
      for (const r of resolvers) r.resolve();
      return;
    }

    try {
      const plainContent = WeixinAdapter.stripMarkdownForWeixin(merged);
      // iLink only delivers the FIRST sendmessage per context_token turn.
      // Send everything in one call — no chunking. If iLink has a hard limit,
      // it will truncate server-side, but at least the message arrives.
      await this.sendMessageApi(externalChatId, plainContent, boundToken);

      this.lastConsumedToken.set(externalChatId, boundToken);
      // Compare-and-delete: only remove if still the same token (a newer token may have arrived)
      if (this.contextTokens.get(externalChatId) === boundToken) {
        this.contextTokens.delete(externalChatId);
      }
      this.stopTyping(externalChatId);
      this.log.info(
        { chatId: externalChatId, textLen: plainContent.length, tokenHash },
        '[WeixinAdapter] flushReply() completed — token consumed',
      );

      for (const r of resolvers) r.resolve();
    } catch (err) {
      this.stopTyping(externalChatId);
      this.log.error({ err, chatId: externalChatId }, '[WeixinAdapter] flushReply() failed');
      for (const r of resolvers) r.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  static stripMarkdownForWeixin(text: string): string {
    return text
      .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1') // multi-line fence → keep code body
      .replace(/```(.+?)```/g, '$1') // single-line fence → keep content
      .replace(/`([^`]+)`/g, '$1') // inline code → plain
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // ![alt](url) → alt (must precede link regex)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
      .replace(/^#{1,6}\s+/gm, '') // strip heading markers
      .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold → plain
      .replace(/(?<!\w)\*(?=\S)(.*?\S)\*(?!\w)/gm, '$1') // italic *word* → plain (not inside identifiers)
      .replace(/(?<!\w)_(?=\S)(.*?\S)_(?!\w)/gm, '$1') // italic _word_ → plain (not inside identifiers)
      .replace(/~~(.*?)~~/g, '$1') // strikethrough → plain
      .replace(/^[>\s]*>\s?/gm, '') // blockquote markers
      .replace(/^[-*+]\s+/gm, '• ') // unordered list → bullet
      .replace(/^\d+\.\s+/gm, '') // ordered list markers
      .replace(/^---+$/gm, '') // horizontal rules
      .replace(/\n{3,}/g, '\n\n') // collapse excessive newlines
      .trim();
  }

  /**
   * Low-level: call /ilink/bot/sendmessage API.
   */
  private async sendMessageApi(chatId: string, text: string, contextToken: string): Promise<void> {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: chatId,
        client_id: generateClientId(),
        message_type: 2,
        context_token: contextToken,
        message_state: MessageState.FINISH,
        item_list: [
          {
            type: MessageItemType.TEXT,
            text_item: { text },
          },
        ],
      },
      base_info: { channel_version: '1.0.0' },
    };

    this.log.info({ chatId, textLen: text.length }, '[WeixinAdapter] sendMessageApi() calling iLink API');

    const res = await this.fetchFn(`${ILINK_BASE_URL}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      this.log.error({ chatId, status: res.status, errorText }, '[WeixinAdapter] sendMessageApi() HTTP error');
      throw new Error(`sendmessage HTTP ${res.status}: ${errorText}`);
    }

    let rawText = '';
    let data: ILinkSendResponse = {};
    if (typeof res.text === 'function') {
      rawText = await res.text().catch(() => '');
      if (!rawText.trim()) {
        this.log.error({ chatId }, '[WeixinAdapter] sendMessageApi() returned empty body');
        throw new Error('sendmessage returned empty response body');
      }
      try {
        data = JSON.parse(rawText) as ILinkSendResponse;
      } catch (error) {
        this.log.error(
          { chatId, rawText, error: String(error) },
          '[WeixinAdapter] sendMessageApi() returned non-JSON body',
        );
        throw new Error(`sendmessage returned non-JSON response: ${rawText}`);
      }
    } else if (typeof res.json === 'function') {
      data = (await res.json()) as ILinkSendResponse;
      rawText = JSON.stringify(data);
    } else {
      this.log.error({ chatId }, '[WeixinAdapter] sendMessageApi() response body reader missing');
      throw new Error('sendmessage response body unreadable');
    }

    const errorCode = data.errcode ?? data.ret;
    this.log.debug({ chatId, rawText }, '[WeixinAdapter] sendMessageApi() raw response');
    this.log.info(
      { chatId, errcode: errorCode, errmsg: data.errmsg },
      '[WeixinAdapter] sendMessageApi() response received',
    );
    if (errorCode && errorCode !== 0) {
      if (errorCode === ERRCODE_SESSION_EXPIRED) {
        this.log.error('[WeixinAdapter] Session expired during sendmessage (errcode -14)');
      }
      throw new Error(`sendmessage errcode ${errorCode}: ${data.errmsg ?? 'unknown'}`);
    }
  }

  // ── Helpers ──

  /**
   * Split text into chunks of maxLen characters, breaking at newlines or spaces.
   */
  chunkMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Try to break at newline
      let breakAt = remaining.lastIndexOf('\n', maxLen);
      // Fall back to space
      if (breakAt <= 0) breakAt = remaining.lastIndexOf(' ', maxLen);
      // Fall back to hard cut
      if (breakAt <= 0) breakAt = maxLen;

      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }

    return chunks;
  }

  /**
   * Get the current polling state (for IM Hub status display).
   */
  isPolling(): boolean {
    return this.polling;
  }

  /**
   * Check if we have a context_token for a given chatId.
   */
  hasContextToken(chatId: string): boolean {
    return this.contextTokens.has(chatId);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Test helpers ──

  /** @internal Test helper: inject a mock fetch function. */
  _injectFetch(fn: typeof fetch): void {
    this.fetchFn = fn;
  }

  /** @internal Test helper: inject a context_token for a chatId. */
  _injectContextToken(chatId: string, token: string): void {
    this.contextTokens.set(chatId, token);
  }

  /** @internal Test helper: set the getupdates cursor. */
  _setCursor(cursor: string): void {
    this.getUpdatesBuf = cursor;
  }

  /** @internal Test helper: get the current cursor. */
  _getCursor(): string {
    return this.getUpdatesBuf;
  }

  /** @internal Test helper: flush all pending debounced replies immediately. */
  async _flushAllPending(): Promise<void> {
    const chatIds = [...this.pendingReplies.keys()];
    for (const chatId of chatIds) {
      const pending = this.pendingReplies.get(chatId);
      if (pending) clearTimeout(pending.timer);
      await this.flushReply(chatId);
    }
  }

  /** @internal Test helper: check if a token was the last consumed for its chatId. */
  _isTokenConsumed(chatId: string, token: string): boolean {
    return this.lastConsumedToken.get(chatId) === token;
  }

  // ── QR Code Login (static — no adapter instance needed) ──

  private static staticFetchFn: typeof fetch = globalThis.fetch;

  static async fetchQrCode(): Promise<WeixinQrCodeResult> {
    const url = `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
    const res = await WeixinAdapter.staticFetchFn(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`get_bot_qrcode HTTP ${res.status}: ${res.statusText}`);
    }
    const data = (await res.json()) as ILinkQrCodeResponse;
    const errorCode = data.errcode ?? data.ret;
    if (errorCode && errorCode !== 0) {
      throw new Error(`get_bot_qrcode errcode ${errorCode}: ${data.errmsg ?? 'unknown'}`);
    }
    // iLink API returns qrcode_img_content (not qrcode_url) — accept both for resilience
    const qrUrl = data.qrcode_img_content ?? data.qrcode_url;
    const qrPayload = data.qrcode;
    if (!qrUrl || !qrPayload) {
      throw new Error('get_bot_qrcode: missing qrcode_img_content/qrcode_url or qrcode in response');
    }
    return { qrUrl, qrPayload };
  }

  static async pollQrCodeStatus(qrPayload: string): Promise<WeixinQrCodeStatus> {
    const url = `${ILINK_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrPayload)}`;
    const res = await WeixinAdapter.staticFetchFn(url, {
      method: 'GET',
      signal: AbortSignal.timeout(QRCODE_STATUS_POLL_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { status: 'error', message: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as ILinkQrCodeStatusResponse;
    const errorCode = data.errcode ?? data.ret;
    if (errorCode && errorCode !== 0) {
      return { status: 'error', message: data.errmsg ?? `errcode ${errorCode}` };
    }
    // iLink API returns status as number (0/1/2/3) or string ("wait"/"scanned"/"confirmed"/"expired")
    const s = data.status;
    switch (s) {
      case 0:
      case 'wait':
        return { status: 'waiting' };
      case 1:
      case 'scanned':
        return { status: 'scanned' };
      case 2:
      case 'confirmed':
        if (!data.bot_token) {
          return { status: 'error', message: 'confirmed but no bot_token in response' };
        }
        return { status: 'confirmed', botToken: data.bot_token };
      case 3:
      case 'expired':
        return { status: 'expired' };
      default:
        return { status: 'error', message: `unknown status ${s}` };
    }
  }

  static async waitForQrCodeLogin(
    qrPayload: string,
    onStatusChange?: (status: WeixinQrCodeStatus) => void,
  ): Promise<WeixinQrCodeStatus> {
    const deadline = Date.now() + QRCODE_TIMEOUT_MS;
    let lastStatus = '';
    while (Date.now() < deadline) {
      const result = await WeixinAdapter.pollQrCodeStatus(qrPayload);
      if (result.status !== lastStatus) {
        lastStatus = result.status;
        onStatusChange?.(result);
      }
      if (result.status === 'confirmed' || result.status === 'expired' || result.status === 'error') {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, QRCODE_POLL_INTERVAL_MS));
    }
    return { status: 'expired' };
  }

  /** @internal Test helper: inject a mock fetch function for static QR methods. */
  static _injectStaticFetch(fn: typeof fetch): void {
    WeixinAdapter.staticFetchFn = fn;
  }
}
