/**
 * WeChat CDN upload/download with AES-128-ECB encryption.
 * Aligned with @tencent-weixin/openclaw-weixin@2.0.1 cdn/ module.
 *
 * Flow: readFile → md5 → genKey → getUploadUrl → AES encrypt → POST to CDN → get downloadParam
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const UPLOAD_MAX_RETRIES = 3;

export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

export interface UploadedFileInfo {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

// ── AES-128-ECB ──

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ── CDN Download Pipeline ──

/**
 * Download encrypted media from WeChat CDN and decrypt.
 * `platformKey` is a JSON-encoded string: { encryptQueryParam, aesKey }.
 */
export async function downloadMediaFromCdn(params: {
  platformKey: string;
  cdnBaseUrl: string;
  log: FastifyBaseLogger;
  fetchFn?: typeof fetch;
}): Promise<Buffer> {
  const { platformKey, cdnBaseUrl, log, fetchFn = globalThis.fetch } = params;

  const { encryptQueryParam, aesKey } = JSON.parse(platformKey) as {
    encryptQueryParam: string;
    aesKey: string;
  };

  const cdnUrl = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  log.info({ cdnUrl: cdnUrl.slice(0, 80) }, '[weixin-cdn] Downloading media from CDN');

  const res = await fetchFn(cdnUrl, {
    method: 'GET',
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`CDN download HTTP ${res.status}: ${errText}`);
  }

  const ciphertext = Buffer.from(await res.arrayBuffer());
  // iLink protocol uses base64 for aes_key; our upload pipeline uses hex internally.
  // Detect: 32 hex chars → hex, otherwise → base64.
  const key = /^[0-9a-f]{32}$/i.test(aesKey) ? Buffer.from(aesKey, 'hex') : Buffer.from(aesKey, 'base64');
  const plaintext = decryptAesEcb(ciphertext, key);

  log.info({ ciphertextLen: ciphertext.length, plaintextLen: plaintext.length }, '[weixin-cdn] Media decrypted');

  return plaintext;
}

// ── CDN Upload Pipeline ──

export async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  mediaType: number;
  botToken: string;
  cdnBaseUrl: string;
  log: FastifyBaseLogger;
  fetchFn?: typeof fetch;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, mediaType, botToken, cdnBaseUrl, log, fetchFn = globalThis.fetch } = params;

  const plaintext = await readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString('hex');
  const aeskey = randomBytes(16);

  log.info({ filePath: basename(filePath), rawsize, filesize, mediaType }, '[weixin-cdn] Uploading media');

  const uploadUrlResp = await callGetUploadUrl({
    filekey,
    mediaType,
    toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString('hex'),
    botToken,
    fetchFn,
  });

  if (!uploadUrlResp.upload_param) {
    throw new Error('[weixin-cdn] getUploadUrl returned no upload_param');
  }

  const downloadParam = await uploadBufferToCdn({
    buf: plaintext,
    uploadParam: uploadUrlResp.upload_param,
    filekey,
    cdnBaseUrl,
    aeskey,
    log,
    fetchFn,
  });

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString('hex'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

// ── Internal API calls ──

function getHeaders(botToken: string): Record<string, string> {
  const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64');
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${botToken}`,
    'X-WECHAT-UIN': uin,
  };
}

async function callGetUploadUrl(params: {
  filekey: string;
  mediaType: number;
  toUserId: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  aeskey: string;
  botToken: string;
  fetchFn: typeof fetch;
}): Promise<{ upload_param?: string }> {
  const body = JSON.stringify({
    filekey: params.filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize: params.rawsize,
    rawfilemd5: params.rawfilemd5,
    filesize: params.filesize,
    no_need_thumb: true,
    aeskey: params.aeskey,
    base_info: { channel_version: '1.0.0' },
  });

  const res = await params.fetchFn(`${ILINK_BASE_URL}/ilink/bot/getuploadurl`, {
    method: 'POST',
    headers: getHeaders(params.botToken),
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`getuploadurl HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as { upload_param?: string };
}

async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
  log: FastifyBaseLogger;
  fetchFn: typeof fetch;
}): Promise<string> {
  const { buf, uploadParam, filekey, cdnBaseUrl, aeskey, log, fetchFn } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetchFn(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const msg = res.headers.get('x-error-message') ?? (await res.text());
        throw new Error(`CDN client error ${res.status}: ${msg}`);
      }
      if (res.status !== 200) {
        throw new Error(`CDN server error ${res.status}`);
      }
      const downloadParam = res.headers.get('x-encrypted-param');
      if (!downloadParam) {
        throw new Error('CDN response missing x-encrypted-param header');
      }
      log.info({ attempt, filekey }, '[weixin-cdn] CDN upload success');
      return downloadParam;
    } catch (err) {
      if (err instanceof Error && err.message.includes('client error')) throw err;
      if (attempt === UPLOAD_MAX_RETRIES) throw err;
      log.warn({ attempt, err: String(err) }, '[weixin-cdn] CDN upload retry');
    }
  }
  throw new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
}
