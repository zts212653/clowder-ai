/**
 * F141: GitHub Webhook Signature Verification (KD-11)
 *
 * GitHub signs webhook payloads with HMAC-SHA256 over raw body bytes.
 * Must verify against raw body, not re-serialized JSON.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubSignature(secret: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;

  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`, 'utf8');
  const received = Buffer.from(signature, 'utf8');

  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
