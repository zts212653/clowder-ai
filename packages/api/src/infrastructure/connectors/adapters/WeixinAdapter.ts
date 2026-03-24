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
const WEIXIN_MAX_MESSAGE_LENGTH = 2000;
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

interface ILinkUpdate {
  errcode?: number;
  errmsg?: string;
  get_updates_buf?: string;
  messages?: ILinkMessage[];
}

interface ILinkMessage {
  msg_id?: string;
  from_user_name?: { str?: string };
  content?: { str?: string };
  context_token?: string;
  msg_type?: number;
  /** Image/media fields */
  img_buf?: { buffer?: string };
  cdn_img_url?: string;
}

interface ILinkSendResponse {
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
    if (raw.errcode === ERRCODE_SESSION_EXPIRED) {
      return { messages: [], newCursor: this.getUpdatesBuf, sessionExpired: true };
    }

    if (raw.errcode && raw.errcode !== 0) {
      this.log.warn({ errcode: raw.errcode, errmsg: raw.errmsg }, '[WeixinAdapter] getupdates error');
      return { messages: [], newCursor: this.getUpdatesBuf, sessionExpired: false };
    }

    const newCursor = raw.get_updates_buf ?? this.getUpdatesBuf;
    const messages: WeixinInboundMessage[] = [];

    if (raw.messages) {
      for (const msg of raw.messages) {
        const parsed = this.parseMessage(msg);
        if (parsed) messages.push(parsed);
      }
    }

    return { messages, newCursor, sessionExpired: false };
  }

  /**
   * Parse a single iLink message into our standard format.
   * msg_type 1 = text, 3 = image, 34 = voice, 49 = file/link
   */
  private parseMessage(msg: ILinkMessage): WeixinInboundMessage | null {
    const senderId = msg.from_user_name?.str;
    const contextToken = msg.context_token;
    if (!senderId || !contextToken) return null;

    const msgId = msg.msg_id ?? `weixin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msgType = msg.msg_type ?? 1;

    // Text message (msg_type 1)
    if (msgType === 1) {
      const text = msg.content?.str;
      if (!text) return null;
      return {
        chatId: senderId,
        text,
        messageId: msgId,
        senderId,
        contextToken,
      };
    }

    // Image message (msg_type 3) — Phase B, pass through as placeholder
    if (msgType === 3) {
      const imageUrl = msg.cdn_img_url ?? '';
      return {
        chatId: senderId,
        text: '[图片]',
        messageId: msgId,
        senderId,
        contextToken,
        attachments: imageUrl ? [{ type: 'image', mediaUrl: imageUrl }] : undefined,
      };
    }

    // Voice message (msg_type 34)
    if (msgType === 34) {
      return {
        chatId: senderId,
        text: '[语音]',
        messageId: msgId,
        senderId,
        contextToken,
      };
    }

    // Unsupported type — log and skip
    this.log.debug({ msgType, msgId }, '[WeixinAdapter] Unsupported message type, skipping');
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
            // Only include cursor if we have one
            ...(this.getUpdatesBuf ? { get_updates_buf: this.getUpdatesBuf } : {}),
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

  /**
   * Send a text reply to a WeChat user.
   * Requires a cached context_token for the target chatId.
   * Auto-chunks messages exceeding 2000 characters.
   */
  async sendReply(externalChatId: string, content: string): Promise<void> {
    const contextToken = this.contextTokens.get(externalChatId);
    if (!contextToken) {
      this.log.warn(
        { chatId: externalChatId },
        '[WeixinAdapter] No context_token cached for chatId — cannot send reply. User must send a message first.',
      );
      return;
    }

    const chunks = this.chunkMessage(content, WEIXIN_MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.sendMessageApi(externalChatId, chunk, contextToken);
    }
  }

  /**
   * Low-level: call /ilink/bot/sendmessage API.
   */
  private async sendMessageApi(chatId: string, text: string, contextToken: string): Promise<void> {
    const body = {
      context_token: contextToken,
      to_user_name: chatId,
      content: { str: text },
      msg_type: 1,
      message_state: 2,
    };

    const res = await this.fetchFn(`${ILINK_BASE_URL}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`sendmessage HTTP ${res.status}: ${errorText}`);
    }

    const data = (await res.json()) as ILinkSendResponse;
    if (data.errcode && data.errcode !== 0) {
      if (data.errcode === ERRCODE_SESSION_EXPIRED) {
        this.log.error('[WeixinAdapter] Session expired during sendmessage (errcode -14)');
      }
      throw new Error(`sendmessage errcode ${data.errcode}: ${data.errmsg ?? 'unknown'}`);
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
