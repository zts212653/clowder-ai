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
// BUG-5 (2026-03-25): iLink context_token supports multiple sendmessage calls.
// Previous BUG-3 "single-use token" conclusion was a misdiagnosis — see F137 spec.
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

/**
 * Voice item payload mode for WeChat voice delivery.
 * - `minimal` (default): send only `{ media }` — safest fallback ("1s fake" but visible).
 * - `playtime`: send `{ media, playtime }` — shows correct duration but won't play.
 * - `playtime-sec`: send `{ media, playtime }` with playtime in SECONDS (not ms) — hypothesis test.
 * - `playtime-encode`: send `{ media, encode_type: 6, playtime }` — confirmed broken (encode_type is poison).
 * - `metadata`: send all SILK fields — confirmed broken (voice "completely gone").
 *
 * Runtime-configurable via WEIXIN_VOICE_ITEM_MODE so 铲屎官 can A/B test without code changes.
 */
type WeixinVoiceItemMode = 'minimal' | 'playtime' | 'playtime-sec' | 'playtime-encode' | 'metadata';
const UNSAFE_VOICE_MODE_ENV = 'WEIXIN_ENABLE_UNSAFE_VOICE_MODES';
const UNSAFE_VOICE_MODES = new Set<WeixinVoiceItemMode>(['playtime-encode', 'metadata']);
const CAPTURE_INBOUND_VOICE_ENV = 'WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA';

function isUnsafeVoiceModeEnabled(): boolean {
  return process.env[UNSAFE_VOICE_MODE_ENV] === '1';
}

function isInboundVoiceCaptureEnabled(): boolean {
  return process.env[CAPTURE_INBOUND_VOICE_ENV] === '1';
}

function getWeixinVoiceItemMode(log?: FastifyBaseLogger): WeixinVoiceItemMode {
  const mode = process.env.WEIXIN_VOICE_ITEM_MODE?.trim().toLowerCase();
  if (mode === 'playtime' || mode === 'playtime-sec' || mode === 'playtime-encode' || mode === 'metadata') {
    if (UNSAFE_VOICE_MODES.has(mode) && !isUnsafeVoiceModeEnabled()) {
      log?.warn(
        { requestedMode: mode, fallbackMode: 'playtime', unsafeModeEnv: UNSAFE_VOICE_MODE_ENV },
        '[WeixinAdapter] unsafe voice mode disabled — falling back to playtime',
      );
      return 'playtime';
    }
    return mode;
  }
  return 'minimal';
}

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
  // BUG-5: lastConsumedToken removed — iLink context_token is reusable (verified 2026-03-25).
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

  /**
   * F137 Phase D: Full disconnect — stop polling, clear bot_token and all session state.
   * After disconnect, the adapter returns to pre-login state (hasBotToken() === false).
   */
  async disconnect(): Promise<void> {
    await this.stopPolling();
    this.botToken = '';
    this.contextTokens.clear();
    this.getUpdatesBuf = '';
    // Reject all pending sendReply promises before clearing (P1: no dangling promises)
    const disconnectError = new Error('Disconnected by user');
    for (const [, bucket] of this.pendingReplies) {
      clearTimeout(bucket.timer);
      for (const { reject } of bucket.resolvers) {
        reject(disconnectError);
      }
    }
    this.pendingReplies.clear();
    this.typingTickets.clear();
    this.log.info('[WeixinAdapter] Disconnected — bot_token and session state cleared');
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
      const media = firstItem.image_item?.media;
      const mediaKey =
        media?.encrypt_query_param && media?.aes_key
          ? JSON.stringify({ encryptQueryParam: media.encrypt_query_param, aesKey: media.aes_key })
          : '';
      return {
        chatId: senderId,
        text: '[图片]',
        messageId: msgId,
        senderId,
        contextToken,
        attachments: mediaKey ? [{ type: 'image' as const, mediaUrl: mediaKey }] : undefined,
      };
    }

    if (itemType === MessageItemType.VOICE) {
      const media = firstItem.voice_item?.media;
      const mediaKey =
        media?.encrypt_query_param && media?.aes_key
          ? JSON.stringify({ encryptQueryParam: media.encrypt_query_param, aesKey: media.aes_key })
          : '';
      return {
        chatId: senderId,
        text: firstItem.voice_item?.text || '[语音]',
        messageId: msgId,
        senderId,
        contextToken,
        attachments:
          isInboundVoiceCaptureEnabled() && mediaKey
            ? [{ type: 'file' as const, mediaUrl: mediaKey, fileName: `weixin-voice-${msgId}.silk` }]
            : undefined,
      };
    }

    if (itemType === MessageItemType.FILE) {
      const media = firstItem.file_item?.media;
      const mediaKey =
        media?.encrypt_query_param && media?.aes_key
          ? JSON.stringify({ encryptQueryParam: media.encrypt_query_param, aesKey: media.aes_key })
          : '';
      return {
        chatId: senderId,
        text: `[文件] ${firstItem.file_item?.file_name ?? ''}`.trim(),
        messageId: msgId,
        senderId,
        contextToken,
        attachments: mediaKey
          ? [{ type: 'file' as const, mediaUrl: mediaKey, fileName: firstItem.file_item?.file_name }]
          : undefined,
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
            this.log.info({ chatId: msg.chatId, tokenHash }, '[WeixinAdapter] Inbound token cached');

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

    this.log.info(
      { chatId: externalChatId, partsCount: parts.length, mergedLen: merged.length, tokenHash },
      '[WeixinAdapter] flushReply() — sending aggregated reply',
    );

    if (!boundToken) {
      this.log.warn({ chatId: externalChatId, tokenHash }, '[WeixinAdapter] Cannot send — no context_token bound');
      this.stopTyping(externalChatId);
      for (const r of resolvers) r.resolve();
      return;
    }

    try {
      const plainContent = WeixinAdapter.stripMarkdownForWeixin(merged);
      // BUG-5: iLink context_token supports multiple sendmessage calls (verified 2026-03-25).
      // Token is NOT consumed after first send — retain for subsequent cat replies.
      // Previous BUG-3 "single-use" assumption was a misdiagnosis.
      await this.sendMessageApi(externalChatId, plainContent, boundToken);

      // Token intentionally NOT consumed/deleted — allows relay chain A→B→C
      // to deliver each cat's reply as a separate WeChat message.
      this.stopTyping(externalChatId);
      this.log.info(
        { chatId: externalChatId, textLen: plainContent.length, tokenHash },
        '[WeixinAdapter] flushReply() completed — token retained for potential follow-up replies',
      );

      for (const r of resolvers) r.resolve();
    } catch (err) {
      this.stopTyping(externalChatId);
      this.log.error({ err, chatId: externalChatId }, '[WeixinAdapter] flushReply() failed');
      for (const r of resolvers) r.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ── Media send (Phase B): CDN upload → sendmessage with media item ──

  async sendMedia(
    externalChatId: string,
    payload: {
      type: 'image' | 'file' | 'audio';
      absPath?: string;
      url?: string;
      fileName?: string;
      [key: string]: unknown;
    },
  ): Promise<void> {
    const filePath = payload.absPath ?? payload.url;
    if (!filePath) {
      this.log.warn({ chatId: externalChatId, type: payload.type }, '[WeixinAdapter] sendMedia: no file path');
      return;
    }

    const contextToken = this.contextTokens.get(externalChatId) ?? '';
    if (!contextToken) {
      this.log.warn({ chatId: externalChatId }, '[WeixinAdapter] sendMedia: no context_token — skipping');
      return;
    }

    let actualFilePath = filePath;
    let tempFilePath: string | undefined;

    // HTTPS URLs: download to temp file first (CDN upload needs a local file)
    if (filePath.startsWith('https://')) {
      const downloaded = await this.downloadToTemp(filePath);
      if (!downloaded) {
        throw new Error(`Media download failed for ${filePath.slice(0, 80)}`);
      }
      actualFilePath = downloaded;
      tempFilePath = downloaded;
    }

    // WeChat voice messages require SILK codec; when conversion fails, degrade to file delivery.
    let voiceMeta: { durationMs: number; sampleRate: number } | undefined;
    if (payload.type === 'audio' && actualFilePath.endsWith('.wav')) {
      const converted = await this.convertWavToSilk(actualFilePath);
      if (converted) {
        // If we downloaded to temp, clean up the download temp
        if (tempFilePath) {
          const { unlink } = await import('node:fs/promises');
          await unlink(tempFilePath).catch(() => {});
        }
        actualFilePath = converted.silkPath;
        tempFilePath = converted.silkPath;
        voiceMeta = { durationMs: converted.durationMs, sampleRate: converted.sampleRate };
      }
    }

    const { uploadMediaToCdn, UploadMediaType } = await import('./weixin-cdn.js');
    const cdnBaseUrl = 'https://novac2c.cdn.weixin.qq.com/c2c';
    const audioAsVoice = payload.type === 'audio' && actualFilePath.endsWith('.silk');
    const mediaTypeMap = {
      image: UploadMediaType.IMAGE,
      file: UploadMediaType.FILE,
      audio: audioAsVoice ? UploadMediaType.VOICE : UploadMediaType.FILE,
    } as const;

    this.log.info(
      { chatId: externalChatId, type: payload.type, filePath: actualFilePath },
      '[WeixinAdapter] sendMedia: uploading to CDN',
    );

    try {
      const uploaded = await uploadMediaToCdn({
        filePath: actualFilePath,
        toUserId: externalChatId,
        mediaType: mediaTypeMap[payload.type],
        botToken: this.botToken,
        cdnBaseUrl,
        log: this.log,
        fetchFn: this.fetchFn,
      });

      const itemType =
        payload.type === 'image'
          ? MessageItemType.IMAGE
          : payload.type === 'audio' && audioAsVoice
            ? MessageItemType.VOICE
            : MessageItemType.FILE;
      const mediaRef = {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
        encrypt_type: 1,
      };

      const mediaItem: Record<string, unknown> = { type: itemType };
      if (payload.type === 'image') {
        mediaItem.image_item = { media: mediaRef, mid_size: uploaded.fileSizeCiphertext };
      } else if (payload.type === 'audio' && audioAsVoice) {
        const voiceMode = getWeixinVoiceItemMode(this.log);
        if (voiceMode === 'metadata') {
          mediaItem.voice_item = {
            media: mediaRef,
            encode_type: 6,
            bits_per_sample: 16,
            sample_rate: voiceMeta?.sampleRate ?? 24_000,
            playtime: voiceMeta?.durationMs ?? 0,
          };
        } else if (voiceMode === 'playtime-encode' && voiceMeta?.durationMs && voiceMeta.durationMs > 0) {
          mediaItem.voice_item = { media: mediaRef, encode_type: 6, playtime: Math.round(voiceMeta.durationMs) };
        } else if (voiceMode === 'playtime-sec' && voiceMeta?.durationMs && voiceMeta.durationMs > 0) {
          mediaItem.voice_item = { media: mediaRef, playtime: Math.max(1, Math.round(voiceMeta.durationMs / 1000)) };
        } else if (voiceMode === 'playtime' && voiceMeta?.durationMs && voiceMeta.durationMs > 0) {
          mediaItem.voice_item = { media: mediaRef, playtime: Math.round(voiceMeta.durationMs) };
        } else {
          mediaItem.voice_item = { media: mediaRef };
        }
        this.log.info(
          {
            chatId: externalChatId,
            mode: voiceMode,
            requestedMode: process.env.WEIXIN_VOICE_ITEM_MODE,
            unsafeVoiceModesEnabled: isUnsafeVoiceModeEnabled(),
            durationMs: voiceMeta?.durationMs,
          },
          '[WeixinAdapter] sendMedia: voice_item mode',
        );
      } else {
        const { basename } = await import('node:path');
        mediaItem.file_item = {
          media: mediaRef,
          file_name:
            payload.type === 'audio' ? (payload.fileName ?? basename(actualFilePath)) : (payload.fileName ?? 'file'),
        };
      }

      const body = {
        msg: {
          from_user_id: '',
          to_user_id: externalChatId,
          client_id: generateClientId(),
          message_type: 2,
          context_token: contextToken,
          message_state: MessageState.FINISH,
          item_list: [mediaItem],
        },
        base_info: { channel_version: '1.0.0' },
      };

      const res = await this.fetchFn(`${ILINK_BASE_URL}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`sendMedia HTTP ${res.status}: ${errorText}`);
      }

      const rawText = await res.text().catch(() => '');
      if (!rawText.trim()) {
        throw new Error('sendMedia returned empty response body');
      }
      let data: ILinkSendResponse;
      try {
        data = JSON.parse(rawText) as ILinkSendResponse;
      } catch {
        throw new Error(`sendMedia returned non-JSON response: ${rawText}`);
      }
      const errorCode = data.errcode ?? data.ret;
      if (errorCode && errorCode !== 0) {
        throw new Error(`sendMedia errcode ${errorCode}: ${data.errmsg ?? 'unknown'}`);
      }

      // BUG-5: token is reusable — do NOT consume/delete.
      this.log.info(
        { chatId: externalChatId, type: payload.type, filekey: uploaded.filekey },
        '[WeixinAdapter] sendMedia: delivered — token retained',
      );
    } finally {
      if (tempFilePath) {
        const { unlink } = await import('node:fs/promises');
        await unlink(tempFilePath).catch(() => {});
      }
    }
  }

  /** Download an HTTPS URL to a temp file for CDN upload. */
  private async downloadToTemp(url: string): Promise<string | null> {
    try {
      const { writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join, extname } = await import('node:path');

      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { randomUUID } = await import('node:crypto');
      const ext = extname(new URL(url).pathname) || '.tmp';
      const tempPath = join(tmpdir(), `cat-cafe-weixin-dl-${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
      await writeFile(tempPath, buf);
      this.log.info({ url: url.slice(0, 80), tempPath, size: buf.length }, '[WeixinAdapter] downloadToTemp: success');
      return tempPath;
    } catch (err) {
      this.log.warn({ err, url: url.slice(0, 80) }, '[WeixinAdapter] downloadToTemp: failed');
      return null;
    }
  }

  /**
   * Convert WAV audio to SILK v3 (WeChat's native voice codec).
   * Returns path to temp .silk file, or null if conversion fails.
   */
  private async convertWavToSilk(
    wavPath: string,
  ): Promise<{ silkPath: string; durationMs: number; sampleRate: number } | null> {
    try {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { encode } = await import('silk-wasm');

      const wavData = await readFile(wavPath);
      const parsed = this.extractMonoPcmFromWav(wavData);
      if (!parsed) {
        this.log.warn({ wavPath, len: wavData.length }, '[WeixinAdapter] convertWavToSilk: unsupported WAV format');
        return null;
      }
      const result = await encode(parsed.pcm, parsed.sampleRate);
      // Write raw SILK output — do NOT append 0xFFFF EOS marker.
      // Evidence: inbound WeChat SILK has no EOS marker and ends exactly at last frame.
      // The 0xFFFF bytes are read as int16LE frame-size = -1, which crashes WeChat's decoder.
      const silkPath = join(tmpdir(), `cat-cafe-weixin-${Date.now()}.silk`);
      await writeFile(silkPath, Buffer.from(result.data));
      this.log.info(
        { wavPath, silkPath, duration: result.duration, sampleRate: parsed.sampleRate },
        '[WeixinAdapter] convertWavToSilk: success',
      );
      return { silkPath, durationMs: result.duration, sampleRate: parsed.sampleRate };
    } catch (err) {
      this.log.warn({ err, wavPath }, '[WeixinAdapter] convertWavToSilk: failed, uploading WAV as fallback');
      return null;
    }
  }

  /**
   * Parse WAV buffer (tolerant to RIFF size mismatch) and return mono PCM s16le.
   * This avoids passing malformed WAV headers directly into silk-wasm as raw PCM.
   */
  private extractMonoPcmFromWav(wavData: Buffer): { pcm: Buffer; sampleRate: number } | null {
    if (wavData.length < 44) return null;
    if (wavData.toString('ascii', 0, 4) !== 'RIFF' || wavData.toString('ascii', 8, 12) !== 'WAVE') return null;

    let offset = 12;
    let sampleRate = 0;
    let channels = 0;
    let bitsPerSample = 0;
    let dataOffset = -1;
    let dataSize = 0;

    while (offset + 8 <= wavData.length) {
      const chunkId = wavData.toString('ascii', offset, offset + 4);
      const chunkSize = wavData.readUInt32LE(offset + 4);
      const chunkDataStart = offset + 8;
      if (chunkDataStart > wavData.length) break;
      const maxReadable = Math.max(0, Math.min(chunkSize, wavData.length - chunkDataStart));

      if (chunkId === 'fmt ' && maxReadable >= 16) {
        channels = wavData.readUInt16LE(chunkDataStart + 2);
        sampleRate = wavData.readUInt32LE(chunkDataStart + 4);
        bitsPerSample = wavData.readUInt16LE(chunkDataStart + 14);
      } else if (chunkId === 'data') {
        dataOffset = chunkDataStart;
        dataSize = maxReadable;
        break;
      }

      offset = chunkDataStart + maxReadable + (chunkSize % 2);
    }

    if (dataOffset < 0 || dataSize <= 0) return null;
    if (sampleRate <= 0 || channels <= 0 || bitsPerSample !== 16) return null;

    const data = wavData.subarray(dataOffset, dataOffset + dataSize);
    if (channels === 1) return { pcm: data, sampleRate };

    // Downmix multi-channel int16 PCM to mono.
    const frameCount = Math.floor(data.length / (channels * 2));
    const mono = Buffer.alloc(frameCount * 2);
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      const base = i * channels * 2;
      for (let ch = 0; ch < channels; ch++) {
        sum += data.readInt16LE(base + ch * 2);
      }
      const mixed = Math.max(-32768, Math.min(32767, Math.round(sum / channels)));
      mono.writeInt16LE(mixed, i * 2);
    }
    return { pcm: mono, sampleRate };
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
