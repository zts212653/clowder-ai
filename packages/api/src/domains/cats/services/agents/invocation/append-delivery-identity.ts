import { createHash } from 'node:crypto';

/** Stable correlation only. Provider idempotency is not assumed. */
export function appendDeliveryId(sourceId: string, targetId: string, invocationId: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([sourceId, targetId, invocationId]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** One deliberate new input per original attempt; repeated HTTP clicks share its admission. */
export function appendRepeatKey(sourceId: string, targetId: string, invocationId: string): string {
  return `append-repeat:${appendDeliveryId(sourceId, targetId, invocationId)}`;
}
