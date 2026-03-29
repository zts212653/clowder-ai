/**
 * WeCom Agent (企微自建应用) Adapter
 * Inbound:  HTTP callback with AES-256-CBC encrypted XML → parse text/image/voice/video/file
 * Outbound: message/send API (text/markdown/textcard) — final-only, no streaming
 *
 * F132 DingTalk + WeCom Chat Gateway — Phase C
 */

import crypto from 'node:crypto';
import { basename } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { FastifyBaseLogger } from 'fastify';
import type { MessageEnvelope } from '../ConnectorMessageFormatter.js';
import type { IOutboundAdapter } from '../OutboundDeliveryHook.js';

// ── Constants ──

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
/** WeCom text message body limit in bytes */
const TEXT_BODY_LIMIT_BYTES = 2048;
/** Access token cache TTL: refresh 5 min before expiry (7200s → use 7080s) */
const TOKEN_REFRESH_MARGIN_MS = 120_000;

// ── Types ──

export interface WeComAgentAttachment {
  type: 'image' | 'file' | 'audio' | 'video';
  /** WeCom media_id for download via /media/get */
  mediaId: string;
  fileName?: string;
}

export interface WeComAgentInboundMessage {
  /** FromUserName (企微 userid) */
  chatId: string;
  text: string;
  messageId: string;
  senderId: string;
  attachments?: WeComAgentAttachment[];
}

export interface WeComAgentAdapterOptions {
  corpId: string;
  agentId: string;
  agentSecret: string;
  /** 回调 Token for SHA1 signature verification */
  token: string;
  /** 回调 EncodingAESKey (43 chars, no trailing =) */
  encodingAesKey: string;
}

// ── Crypto helpers (AC-C2) ──

/**
 * Derive AES key and IV from EncodingAESKey.
 * EncodingAESKey is 43 chars; append '=' for valid Base64 → 32-byte key.
 * IV = first 16 bytes of key.
 */
function deriveAesKeyIv(encodingAesKey: string): { key: Buffer; iv: Buffer } {
  const key = Buffer.from(encodingAesKey + '=', 'base64');
  if (key.length !== 32) {
    throw new Error(`[WeComAgentAdapter] Invalid EncodingAESKey: expected 32 bytes, got ${key.length}`);
  }
  return { key, iv: key.subarray(0, 16) };
}

/**
 * Compute SHA1 signature for WeCom callback verification.
 * sig = sha1(sort([token, timestamp, nonce, encrypt]).join(''))
 */
export function computeSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const params = [token, timestamp, nonce, encrypt].sort();
  return crypto.createHash('sha1').update(params.join('')).digest('hex');
}

/**
 * Decrypt an AES-256-CBC encrypted WeCom message.
 * Returns { message, corpId } after PKCS7 unpadding.
 *
 * Layout after decryption:
 *   [16 bytes random] [4 bytes msg_len BE] [msg_len bytes XML] [corpId bytes]
 */
export function decryptMessage(
  encryptedBase64: string,
  aesKey: Buffer,
  iv: Buffer,
): { message: string; receivedCorpId: string } {
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encryptedBase64, 'base64'), decipher.final()]);

  // PKCS7 unpadding
  const padLen = decrypted[decrypted.length - 1];
  const raw = decrypted.subarray(0, decrypted.length - padLen);

  // Skip 16-byte random prefix
  const msgLenBuf = raw.subarray(16, 20);
  const msgLen = msgLenBuf.readUInt32BE(0);
  const message = raw.subarray(20, 20 + msgLen).toString('utf-8');
  const receivedCorpId = raw.subarray(20 + msgLen).toString('utf-8');

  return { message, receivedCorpId };
}

/**
 * Encrypt a plaintext message for WeCom callback response.
 * Used for echostr challenge response.
 */
export function encryptMessage(plaintext: string, aesKey: Buffer, iv: Buffer, corpId: string): string {
  const randomBytes = crypto.randomBytes(16);
  const msgBuf = Buffer.from(plaintext, 'utf-8');
  const corpIdBuf = Buffer.from(corpId, 'utf-8');
  const msgLenBuf = Buffer.alloc(4);
  msgLenBuf.writeUInt32BE(msgBuf.length, 0);

  const payload = Buffer.concat([randomBytes, msgLenBuf, msgBuf, corpIdBuf]);

  // PKCS7 padding to AES block size (16)
  const blockSize = 16;
  const padLen = blockSize - (payload.length % blockSize);
  const padding = Buffer.alloc(padLen, padLen);
  const padded = Buffer.concat([payload, padding]);

  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

// ── XML Parser (AC-C3) ──

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
});

// ── Adapter ──

export class WeComAgentAdapter implements IOutboundAdapter {
  readonly connectorId = 'wecom-agent';
  private readonly log: FastifyBaseLogger;
  private readonly corpId: string;
  private readonly agentId: string;
  private readonly agentSecret: string;
  private readonly token: string;
  private readonly aesKey: Buffer;
  private readonly iv: Buffer;

  // Access token cache
  private accessToken = '';
  private tokenExpiresAt = 0;

  // DI injection points
  private fetchFn: typeof fetch = globalThis.fetch;

  constructor(log: FastifyBaseLogger, options: WeComAgentAdapterOptions) {
    this.log = log;
    this.corpId = options.corpId;
    this.agentId = options.agentId;
    this.agentSecret = options.agentSecret;
    this.token = options.token;
    const { key, iv } = deriveAesKeyIv(options.encodingAesKey);
    this.aesKey = key;
    this.iv = iv;
  }

  // ── Callback Verification (AC-C1) ──

  /**
   * Handle GET echostr challenge for URL verification.
   * WeCom sends: ?msg_signature=X&timestamp=T&nonce=N&echostr=E
   * We decrypt echostr and return plaintext if signature matches.
   */
  verifyCallback(query: { msg_signature: string; timestamp: string; nonce: string; echostr: string }): string | null {
    const { msg_signature, timestamp, nonce, echostr } = query;

    const expectedSig = computeSignature(this.token, timestamp, nonce, echostr);
    if (expectedSig !== msg_signature) {
      this.log.warn({ expected: expectedSig, got: msg_signature }, '[WeComAgentAdapter] echostr signature mismatch');
      return null;
    }

    try {
      const { message, receivedCorpId } = decryptMessage(echostr, this.aesKey, this.iv);
      if (receivedCorpId !== this.corpId) {
        this.log.warn({ expected: this.corpId, got: receivedCorpId }, '[WeComAgentAdapter] echostr corpId mismatch');
        return null;
      }
      return message;
    } catch (err) {
      this.log.error({ err }, '[WeComAgentAdapter] echostr decryption failed');
      return null;
    }
  }

  // ── Inbound: Parse encrypted XML (AC-C2, AC-C3) ──

  /**
   * Verify signature and decrypt an incoming POST body (encrypted XML).
   * Returns the decrypted XML string, or null if verification fails.
   */
  decryptInbound(body: string, query: { msg_signature: string; timestamp: string; nonce: string }): string | null {
    // Parse outer XML to extract <Encrypt>
    const outer = xmlParser.parse(body);
    const encrypt = outer?.xml?.Encrypt ?? outer?.Encrypt ?? null;
    if (!encrypt) {
      this.log.warn('[WeComAgentAdapter] No <Encrypt> in POST body');
      return null;
    }

    // Verify signature
    const expectedSig = computeSignature(this.token, query.timestamp, query.nonce, encrypt);
    if (expectedSig !== query.msg_signature) {
      this.log.warn({ expected: expectedSig, got: query.msg_signature }, '[WeComAgentAdapter] POST signature mismatch');
      return null;
    }

    // Decrypt
    try {
      const { message, receivedCorpId } = decryptMessage(encrypt, this.aesKey, this.iv);
      if (receivedCorpId !== this.corpId) {
        this.log.warn({ expected: this.corpId, got: receivedCorpId }, '[WeComAgentAdapter] POST corpId mismatch');
        return null;
      }
      return message;
    } catch (err) {
      this.log.error({ err }, '[WeComAgentAdapter] POST decryption failed');
      return null;
    }
  }

  /**
   * Parse decrypted XML into a normalized inbound message.
   * Supports text, image, voice, video, file (location is logged and skipped).
   */
  parseEvent(decryptedXml: string): WeComAgentInboundMessage | null {
    const parsed = xmlParser.parse(decryptedXml);
    const root = parsed?.xml ?? parsed;
    if (!root) return null;

    const msgType = root.MsgType as string | undefined;
    const fromUser = root.FromUserName as string | undefined;
    const msgId = root.MsgId != null ? String(root.MsgId) : `wa-${Date.now()}`;

    if (!msgType || !fromUser) return null;

    const base = {
      chatId: fromUser,
      messageId: msgId,
      senderId: fromUser,
    };

    switch (msgType) {
      case 'text': {
        const content = root.Content as string | undefined;
        if (!content) return null;
        return { ...base, text: content.trim() };
      }
      case 'image': {
        const mediaId = root.MediaId as string | undefined;
        return {
          ...base,
          text: '[图片]',
          attachments: mediaId ? [{ type: 'image' as const, mediaId }] : undefined,
        };
      }
      case 'voice': {
        const mediaId = root.MediaId as string | undefined;
        // WeCom voice may include Recognition (speech-to-text)
        const recognition = root.Recognition as string | undefined;
        return {
          ...base,
          text: recognition || '[语音]',
          attachments: mediaId ? [{ type: 'audio' as const, mediaId }] : undefined,
        };
      }
      case 'video':
      case 'shortvideo': {
        const mediaId = root.MediaId as string | undefined;
        return {
          ...base,
          text: '[视频]',
          attachments: mediaId ? [{ type: 'video' as const, mediaId }] : undefined,
        };
      }
      case 'file': {
        const mediaId = root.MediaId as string | undefined;
        const title = root.Title as string | undefined;
        return {
          ...base,
          text: `[文件] ${title ?? ''}`.trim(),
          attachments: mediaId
            ? [
                {
                  type: 'file' as const,
                  mediaId,
                  ...(title ? { fileName: title } : {}),
                },
              ]
            : undefined,
        };
      }
      case 'location': {
        const label = (root.Label as string) ?? `${root.Location_X ?? ''},${root.Location_Y ?? ''}`;
        return { ...base, text: `[位置] ${label}` };
      }
      case 'event': {
        this.log.debug({ eventType: root.Event }, '[WeComAgentAdapter] Event message skipped');
        return null;
      }
      default:
        this.log.debug({ msgType }, '[WeComAgentAdapter] Unsupported message type');
        return null;
    }
  }

  // ── Access Token Management ──

  /**
   * Get a valid access_token, refreshing if expired.
   * WeCom access_token has 7200s (2h) TTL.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const url = `${WECOM_API_BASE}/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.agentSecret)}`;
    const res = await this.fetchFn(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`[WeComAgentAdapter] gettoken HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
      expires_in?: number;
    };

    if (data.errcode && data.errcode !== 0) {
      throw new Error(`[WeComAgentAdapter] gettoken errcode ${data.errcode}: ${data.errmsg ?? 'unknown'}`);
    }

    if (!data.access_token) {
      throw new Error('[WeComAgentAdapter] gettoken: no access_token in response');
    }

    this.accessToken = data.access_token;
    const expiresIn = data.expires_in ?? 7200;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS;

    this.log.info({ expiresIn }, '[WeComAgentAdapter] Access token refreshed');
    return this.accessToken;
  }

  /** Force token refresh on next call (e.g., after 401/40001 error). */
  invalidateToken(): void {
    this.accessToken = '';
    this.tokenExpiresAt = 0;
  }

  // ── Outbound: Send Messages (AC-C4) ──

  /**
   * Send a text reply via message/send API.
   * Long messages are chunked at TEXT_BODY_LIMIT_BYTES (2048 bytes).
   * AC-C6: final-only mode, long reply chunking.
   */
  async sendReply(externalChatId: string, content: string, _metadata?: Record<string, unknown>): Promise<void> {
    const chunks = this.chunkMessage(content, TEXT_BODY_LIMIT_BYTES);
    for (const chunk of chunks) {
      await this.messageSend(externalChatId, {
        msgtype: 'text',
        agentid: Number(this.agentId),
        text: { content: chunk },
      });
    }
  }

  /**
   * Send a formatted reply as markdown (body) or textcard (with link).
   * AC-C4: markdown + textcard + 图文卡片
   */
  async sendFormattedReply(
    externalChatId: string,
    envelope: MessageEnvelope,
    _metadata?: Record<string, unknown>,
  ): Promise<void> {
    const isCallback = envelope.origin === 'callback';
    const headerTitle = isCallback ? `📨 ${envelope.header} · 传话` : envelope.header;

    // If we have a deep link URL, use textcard format
    if (envelope.footer?.includes('http')) {
      // Extract URL from footer
      const urlMatch = envelope.footer.match(/(https?:\/\/[^\s)]+)/);
      const url = urlMatch ? urlMatch[1] : '';
      await this.messageSend(externalChatId, {
        msgtype: 'textcard',
        agentid: Number(this.agentId),
        textcard: {
          title: headerTitle,
          description: envelope.body.slice(0, 512),
          url,
          btntxt: '查看详情',
        },
      });
      return;
    }

    // Default: markdown format
    let mdContent = `**${headerTitle}**\n\n`;
    if (envelope.subtitle) {
      mdContent += `**${envelope.subtitle}**\n\n`;
    }
    mdContent += envelope.body;
    if (envelope.footer) {
      mdContent += `\n\n---\n${envelope.footer}`;
    }

    const chunks = this.chunkMessage(mdContent, TEXT_BODY_LIMIT_BYTES);
    for (const chunk of chunks) {
      await this.messageSend(externalChatId, {
        msgtype: 'markdown',
        agentid: Number(this.agentId),
        markdown: { content: chunk },
      });
    }
  }

  // ── Media (AC-C5) ──

  /**
   * Send a media message (image/file/audio) via temporary material upload.
   * AC-C5: 临时素材 API 收发
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

    // Map 'audio' → 'voice' for WeCom API
    const wecomMediaType = payload.type === 'audio' ? 'voice' : payload.type;

    if (absPath) {
      try {
        const { readFile } = await import('node:fs/promises');
        const fileBuffer = await readFile(absPath);
        const fileName = payload.fileName ?? basename(absPath);
        const mediaId = await this.uploadMedia(fileBuffer, wecomMediaType, fileName);
        if (mediaId) {
          await this.messageSend(externalChatId, {
            msgtype: wecomMediaType,
            agentid: Number(this.agentId),
            [wecomMediaType]: { media_id: mediaId },
          });
          return;
        }
      } catch (err) {
        this.log.warn(
          { err, type: payload.type, absPath },
          '[WeComAgentAdapter] sendMedia: upload failed, falling through',
        );
      }
    }

    // Fallback: text link
    const mediaRef =
      url ??
      (typeof payload.fileName === 'string' && payload.fileName.length > 0
        ? payload.fileName
        : absPath
          ? basename(absPath)
          : undefined);

    if (mediaRef) {
      const label = payload.type === 'image' ? '🖼️' : payload.type === 'audio' ? '🔊' : '📎';
      await this.sendReply(externalChatId, `${label} ${mediaRef}`);
      return;
    }
    this.log.warn({ type: payload.type }, '[WeComAgentAdapter] sendMedia: no file available, skipping');
  }

  /**
   * Download a media file by media_id via /media/get API.
   * AC-C5: inbound media download
   */
  async downloadMedia(mediaId: string): Promise<Buffer> {
    const token = await this.getAccessToken();
    const url = `${WECOM_API_BASE}/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;

    const res = await this.fetchFn(url, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`[WeComAgentAdapter] media/get HTTP ${res.status}: ${res.statusText}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  // ── Private: API Calls ──

  /**
   * Upload a temporary material via /media/upload.
   * Returns media_id on success, null on failure.
   */
  private async uploadMedia(fileBuffer: Buffer, mediaType: string, filename: string): Promise<string | null> {
    try {
      const token = await this.getAccessToken();
      const url = `${WECOM_API_BASE}/media/upload?access_token=${encodeURIComponent(token)}&type=${encodeURIComponent(mediaType)}`;

      // Build multipart form data
      const boundary = `----WeComAgent${Date.now()}`;
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([header, fileBuffer, footer]);

      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        this.log.warn({ status: res.status }, '[WeComAgentAdapter] media/upload HTTP error');
        return null;
      }

      const data = (await res.json()) as {
        errcode?: number;
        errmsg?: string;
        media_id?: string;
      };
      if (data.errcode && data.errcode !== 0) {
        this.log.warn({ errcode: data.errcode, errmsg: data.errmsg }, '[WeComAgentAdapter] media/upload errcode');
        return null;
      }

      return data.media_id ?? null;
    } catch (err) {
      this.log.warn({ err, mediaType, filename }, '[WeComAgentAdapter] uploadMedia failed');
      return null;
    }
  }

  /**
   * Send a message via /message/send API.
   * Handles token refresh on 40001/42001 errors.
   */
  private async messageSend(toUser: string, body: Record<string, unknown>): Promise<void> {
    const token = await this.getAccessToken();
    const url = `${WECOM_API_BASE}/message/send?access_token=${encodeURIComponent(token)}`;

    const payload = {
      touser: toUser,
      ...body,
    };

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`[WeComAgentAdapter] message/send HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as {
      errcode?: number;
      errmsg?: string;
    };

    // Token expired — refresh and retry once
    if (data.errcode === 40001 || data.errcode === 42001) {
      this.log.warn({ errcode: data.errcode }, '[WeComAgentAdapter] Token expired, refreshing and retrying');
      this.invalidateToken();
      const newToken = await this.getAccessToken();
      const retryUrl = `${WECOM_API_BASE}/message/send?access_token=${encodeURIComponent(newToken)}`;
      const retryRes = await this.fetchFn(retryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!retryRes.ok) {
        throw new Error(`[WeComAgentAdapter] message/send retry HTTP ${retryRes.status}`);
      }
      const retryData = (await retryRes.json()) as {
        errcode?: number;
        errmsg?: string;
      };
      if (retryData.errcode && retryData.errcode !== 0) {
        throw new Error(
          `[WeComAgentAdapter] message/send retry errcode ${retryData.errcode}: ${retryData.errmsg ?? 'unknown'}`,
        );
      }
      return;
    }

    if (data.errcode && data.errcode !== 0) {
      throw new Error(`[WeComAgentAdapter] message/send errcode ${data.errcode}: ${data.errmsg ?? 'unknown'}`);
    }
  }

  // ── Helpers ──

  /**
   * Split text into chunks respecting byte limit, breaking at newlines/spaces.
   * AC-C6: long reply chunking at 2048 bytes.
   */
  chunkMessage(text: string, maxBytes: number): string[] {
    const totalBytes = Buffer.byteLength(text, 'utf-8');
    if (totalBytes <= maxBytes) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (Buffer.byteLength(remaining, 'utf-8') <= maxBytes) {
        chunks.push(remaining);
        break;
      }

      // Binary search for the max char index that fits in maxBytes
      let lo = 0;
      let hi = remaining.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (Buffer.byteLength(remaining.slice(0, mid), 'utf-8') <= maxBytes) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }

      // Try to break at newline or space
      let breakAt = remaining.lastIndexOf('\n', lo);
      if (breakAt <= 0) breakAt = remaining.lastIndexOf(' ', lo);
      if (breakAt <= 0) breakAt = lo;

      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }

    return chunks;
  }

  // ── Test Helpers ──

  /** @internal */
  _injectFetch(fn: typeof fetch): void {
    this.fetchFn = fn;
  }

  /** @internal */
  _injectAccessToken(token: string, expiresAt?: number): void {
    this.accessToken = token;
    this.tokenExpiresAt = expiresAt ?? Date.now() + 7200_000;
  }

  /** @internal — expose crypto params for testing */
  _getCryptoParams(): { aesKey: Buffer; iv: Buffer; token: string } {
    return { aesKey: this.aesKey, iv: this.iv, token: this.token };
  }
}
