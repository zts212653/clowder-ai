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

import type { FastifyBaseLogger } from 'fastify';
import type { IOutboundAdapter } from '../OutboundDeliveryHook.js';

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const GETUPDATES_TIMEOUT_MS = 35_000;
const POLL_ERROR_BACKOFF_MS = 3_000;
const POLL_MAX_BACKOFF_MS = 60_000;
const WEIXIN_MAX_MESSAGE_LENGTH = 400;
/** Delay between sending multiple chunks to avoid iLink-side throttling (ms) */
const WEIXIN_CHUNK_DELAY_MS = 300;
/** errcode -14 means session expired — need re-login */
const ERRCODE_SESSION_EXPIRED = -14;
/** QR code status poll interval (ms) */
const QRCODE_POLL_INTERVAL_MS = 2_000;
/** iLink get_qrcode_status is a ~30 s long-poll; timeout must exceed that */
const QRCODE_STATUS_POLL_TIMEOUT_MS = 40_000;
/** QR code timeout (5 minutes) */
const QRCODE_TIMEOUT_MS = 5 * 60 * 1000;

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
  private fetchFn: typeof fetch = globalThis.fetch;
  private sessionExpiredCallback: (() => void) | null = null;

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
            this.contextTokens.set(msg.chatId, msg.contextToken);

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
    this.log.info('[WeixinAdapter] Long polling stopped');
  }

  // ── Outbound: Send reply ──

  async sendReply(externalChatId: string, content: string): Promise<void> {
    const contextToken = this.contextTokens.get(externalChatId);
    this.log.info(
      {
        chatId: externalChatId,
        hasContextToken: !!contextToken,
        contentLen: content.length,
        cachedTokenCount: this.contextTokens.size,
      },
      '[WeixinAdapter] sendReply() called',
    );
    if (!contextToken) {
      this.log.warn(
        { chatId: externalChatId },
        '[WeixinAdapter] No context_token cached for chatId — cannot send reply. User must send a message first.',
      );
      return;
    }

    const plainContent = WeixinAdapter.stripMarkdownForWeixin(content);
    const chunks = this.chunkMessage(plainContent, WEIXIN_MAX_MESSAGE_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await this.sleep(WEIXIN_CHUNK_DELAY_MS);
      await this.sendMessageApi(externalChatId, chunks[i], contextToken);
    }
    this.log.info(
      { chatId: externalChatId, chunks: chunks.length, originalLen: content.length, plainLen: plainContent.length },
      '[WeixinAdapter] sendReply() completed successfully',
    );
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
        to_user_id: chatId,
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

    const data = (await res.json()) as ILinkSendResponse;
    const errorCode = data.errcode ?? data.ret;
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
