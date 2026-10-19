import { createHash } from 'node:crypto';

/** Authenticated sender + opaque caller key; message prose never identifies a callback retry. */
export function buildCallbackPostMessageIdempotencyKey(catId: string, clientMessageId: string): string {
  const digest = createHash('sha256').update(clientMessageId).digest('hex');
  return `callback:post:${catId}:${digest}`;
}
