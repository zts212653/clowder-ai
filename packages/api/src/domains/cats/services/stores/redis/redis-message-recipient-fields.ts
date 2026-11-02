/**
 * Recipient selection needs sender, mentions, author/publication times and the
 * canonical visibility inputs, not content/thinking/metadata/toolEvents/blocks.
 * extra and dedicated authority carriers remain whole serialized fields; this
 * is not a byte bound on those fields or a general-purpose message read.
 */
export const MESSAGE_RECIPIENT_FIELDS = [
  'id',
  'threadId',
  'userId',
  'catId',
  'from',
  'source',
  'lifecycle',
  'origin',
  'deliveryStatus',
  'deletedAt',
  'timestamp',
  'mentions',
  'extra',
  'pluginMessage',
  'custodyOfferV1',
  'deliveredAt',
  'timelineOrderAt',
  'visibility',
  'whisperTo',
  'revealedAt',
  'recall',
  '_tombstone',
] as const;

export function recipientMessageHash(
  value: unknown,
  expectedId: string | undefined,
): Record<string, string> | undefined {
  if (!Array.isArray(value) || value.length !== MESSAGE_RECIPIENT_FIELDS.length) return undefined;
  const result: Record<string, string> = {};
  for (const [index, field] of MESSAGE_RECIPIENT_FIELDS.entries()) {
    const raw: unknown = value[index];
    if (raw === null) continue;
    if (typeof raw !== 'string') return undefined;
    result[field] = raw;
  }
  // A vanished hash returns a full-length all-null HMGET, not a Redis error.
  // Never skip that uncertainty or accept a row belonging to a different key.
  return expectedId && result.id === expectedId ? result : undefined;
}
