/** Includes all inputs to the canonical sender/visibility decoder and the indexing projection. */
export const MESSAGE_EVIDENCE_FIELDS = [
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
  'content',
  'timestamp',
  'contentBlocks',
  'extra',
] as const;

export function evidenceMessageHash(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value) || value.length !== MESSAGE_EVIDENCE_FIELDS.length) return undefined;
  const result: Record<string, string> = {};
  for (const [index, field] of MESSAGE_EVIDENCE_FIELDS.entries()) {
    const raw: unknown = value[index];
    if (raw === null) continue;
    if (typeof raw !== 'string') return undefined;
    result[field] = raw;
  }
  return result;
}
