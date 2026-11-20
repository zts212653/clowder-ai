import { isDeepStrictEqual } from 'node:util';
import type { SessionCacheObservation, SessionRecord } from '@cat-cafe/shared';

/** Internal, durable successful maintenance fact. Never accepted from a request body. */
export interface CacheRetentionWarmProof {
  sessionId: string;
  source: SessionCacheObservation;
  maintenanceInvocationId: string;
  observedAt: number;
  expiresAt: number;
  retaining?: boolean;
}
export function validRetentionProof(record: SessionRecord, proof: CacheRetentionWarmProof | undefined): boolean {
  return (
    !!proof &&
    proof.sessionId === record.id &&
    proof.source.nativeSessionId === record.cliSessionId &&
    isDeepStrictEqual(proof.source, record.lastUsage?.cacheObservation) &&
    proof.observedAt >= proof.source.observedAt &&
    proof.expiresAt > proof.observedAt &&
    proof.expiresAt <= proof.observedAt + 60 * 60_000
  );
}
