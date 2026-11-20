import { createHash } from 'node:crypto';
import type { SessionCacheObservation } from '@cat-cafe/shared';
import type { CacheRetentionProbeReceipt } from './CacheRetentionProbeService.js';

export const RETENTION_HORIZON_MS = 2 * 60 * 60_000;
export const RETENTION_LEAD_MS = 10 * 60_000;
export const RETENTION_LATE_MS = 2 * 60_000;

/** References only. Dispatch History remains the owner of whether the work is pending. */
export interface RetentionCandidate {
  id: string;
  userId: string;
  catId: string;
  threadId: string;
  messageId: string;
  messageThreadId: string;
  sourceInvocationId: string;
  /** Initial selection for provenance; live dispatchRefs remain the waiting-work authority. */
  targets: string[];
  createdAt: number;
}

export interface RetentionWindow {
  id: string;
  revision: number;
  userId: string;
  catId: string;
  threadId: string;
  sessionId: string;
  nativeSessionId: string;
  source: SessionCacheObservation;
  /** Immutable source input boundary. A later head must never become a new maintenance baseline. */
  sourceInputSequence?: number;
  candidateId?: string;
  preferenceRevision: number;
  dueAt: number;
  retainUntil: number;
  state: 'waiting' | 'retaining' | 'stopped';
  reason?: string;
  /** A claimed attempt survives crashes; it is never silently replayed. */
  attempt?: { id: string; startedAt: number; completed: boolean };
  receipts: CacheRetentionProbeReceipt[];
  returned?: {
    invocationId: string;
    /** Canonical provider-entry order, independent of observation/storage time. */
    inputSequence: number;
    observedAt: number;
    readRatio?: number;
    maintenanceInvocationId: string;
    /** Every preceding maintenance shares this next real return. */
    maintenanceInvocationIds?: string[];
  };
  /** A missing ordered fact is never replaced by a later lastUsage snapshot. */
  returnUnknown?: string;
}

export interface RetentionHealth {
  lastInvocationId: string;
  lastObservedAt: number;
  consecutiveCold: number;
  stopped: boolean;
}

export function retentionWindowId(
  user: string,
  cat: string,
  thread: string,
  session: string,
  invocation: string,
): string {
  return retentionKey(user, cat, thread, session, invocation);
}

export function retentionSourceKey(
  source: Pick<RetentionCandidate, 'userId' | 'catId' | 'threadId' | 'sourceInvocationId'>,
): string {
  return retentionKey(source.userId, source.catId, source.threadId, source.sourceInvocationId);
}

export function retentionKey(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function retentionWarmUntil(window: RetentionWindow): number {
  const receipt = window.receipts.at(-1);
  // The two-hour cap limits maintenance sends, not the provider's physical TTL after the last send.
  return receipt?.outcome === 'sample_pass'
    ? receipt.startedAt + 60 * 60_000
    : window.source.requestStartedAt + (window.source.retentionMs ?? 0);
}
