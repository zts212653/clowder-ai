import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import https from 'node:https';
import { createPinnedRequestOptions, resolveExternalUrl } from '../../../../../utils/url-safety.js';
import { createProxyDotWebhookSender } from './dot-proxy-doh.js';

export interface DotWebhookResponse {
  status: number;
  body: string;
}
export type DotWebhookSend = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<DotWebhookResponse>;

export function createDotWebhookSender(proxyUrl?: string): DotWebhookSend {
  return proxyUrl === undefined ? sendDotWebhookPinned : createProxyDotWebhookSender(proxyUrl);
}

export function dotSigningKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('invalid_signing_secret');
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded)
    throw new Error('invalid_signing_secret');
  return key;
}

export function dotWebhookHeaders(
  id: string,
  subscriptionId: string,
  secret: string,
  body: string,
  now = Date.now(),
  previousSecret?: string,
) {
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error('event_payload_too_large');
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac('sha256', dotSigningKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': previousSecret
      ? `v1,${signature} v1,${createHmac('sha256', dotSigningKey(previousSecret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`
      : `v1,${signature}`,
    'X-MCP-Subscription-Id': subscriptionId,
  };
}

/** Re-resolve on every send, pin the address, preserve TLS hostname, never follow redirects. */
export const sendDotWebhookPinned: DotWebhookSend = async (url, headers, body) => {
  validateDotCallbackUrl(url);
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const resolved = await Promise.race([
    resolveExternalUrl(url),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(() => reject(new Error('callback_dns_timeout')), 5000);
      dnsTimer.unref();
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  const requestOptions = createPinnedRequestOptions(resolved);
  requestOptions.method = 'POST';
  requestOptions.headers = { ...headers, ...requestOptions.headers };
  return new Promise((resolve, reject) => {
    const req = https.request(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          req.destroy(new Error('callback_response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      response.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('callback_timeout')), 10_000);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(body);
  });
};

function validateDotCallbackUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
    throw new Error('invalid_callback_url');
}

export async function verifyDotWebhook(
  url: string,
  subscriptionId: string,
  secret: string,
  send = sendDotWebhookPinned,
) {
  validateDotCallbackUrl(url);
  dotSigningKey(secret);
  const challenge = randomUUID();
  const id = `verification_${randomUUID()}`;
  const body = JSON.stringify({ type: 'verification', challenge });
  const response = await send(url, dotWebhookHeaders(id, subscriptionId, secret, body), body);
  if (response.status < 200 || response.status >= 300) throw new Error('challenge_failed');
  const value: unknown = JSON.parse(response.body);
  const echo = typeof value === 'object' && value !== null && 'challenge' in value ? value.challenge : undefined;
  if (
    typeof echo !== 'string' ||
    echo.length !== challenge.length ||
    !timingSafeEqual(Buffer.from(echo), Buffer.from(challenge))
  ) {
    throw new Error('challenge_failed');
  }
}
