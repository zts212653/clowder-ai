import type { RecoveryTranscriptTarget } from './transcript-scan.js';

export interface RecoveryCensusEntry extends RecoveryTranscriptTarget {
  threadId: string;
  catId: string;
  withheldAtUtc: string;
  associationMethod?: string;
  closureId: string;
  decisionKind: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`census ${field} must be a non-empty string`);
  }
  return value;
}

export function parseRecoveryCensus(value: unknown): RecoveryCensusEntry[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) throw new Error('census entries must be an array');
  if (!Number.isSafeInteger(value.total) || value.total !== value.entries.length) {
    throw new Error('census total does not match entries');
  }
  const seen = new Set<string>();
  return value.entries.map((item, index) => {
    if (!isRecord(item)) throw new Error(`census entry ${index} must be an object`);
    const invocationId = requireString(item, 'invocationId');
    if (seen.has(invocationId)) throw new Error(`census duplicate invocationId: ${invocationId}`);
    seen.add(invocationId);
    const withheldAtUtc = requireString(item, 'withheldAtUtc');
    if (!Number.isFinite(Date.parse(withheldAtUtc))) {
      throw new Error(`census ${invocationId} withheldAtUtc must be an ISO timestamp`);
    }
    const associationMethod = item.associationMethod;
    if (associationMethod !== undefined && typeof associationMethod !== 'string') {
      throw new Error(`census ${invocationId} associationMethod must be a string`);
    }
    return {
      invocationId,
      userId: requireString(item, 'userId'),
      threadId: requireString(item, 'threadId'),
      catId: requireString(item, 'catId'),
      withheldAtUtc,
      closureId: requireString(item, 'closureId'),
      decisionKind: requireString(item, 'kind'),
      withheldDecision: {
        withheldAtUtc,
        closureId: requireString(item, 'closureId'),
        decisionKind: requireString(item, 'kind'),
      },
      ...(associationMethod ? { associationMethod } : {}),
    };
  });
}
