import type { SessionCacheObservation, TurnExecutionRecord } from '@cat-cafe/shared';

export interface CacheExecutionScope {
  userId: string;
  threadId: string;
  catId: string;
}
export interface CacheExecutionObservation {
  sessionId: string;
  observation: SessionCacheObservation;
}
export type FirstCacheExecution =
  | { status: 'none' }
  | { status: 'pending' }
  | { status: 'unknown'; invocationId?: string }
  | { status: 'observed'; invocationId: string; value: CacheExecutionObservation };

/** Private consumer projection. Native identifiers never join public TurnExecutionRecord responses. */
export interface TurnExecutionCacheFacts {
  head(scope: CacheExecutionScope): number | Promise<number>;
  sequenceOf(scope: CacheExecutionScope, invocationId: string): number | undefined | Promise<number | undefined>;
  recordObservation(invocationId: string, value: CacheExecutionObservation): boolean | Promise<boolean>;
  firstAfter(scope: CacheExecutionScope, frontier: number): FirstCacheExecution | Promise<FirstCacheExecution>;
}
export const cacheExecutionScopeKey = (scope: CacheExecutionScope) =>
  Buffer.from(JSON.stringify([scope.userId, scope.threadId, scope.catId])).toString('base64url');
export const isCacheInput = (record: TurnExecutionRecord) =>
  record.executionKind !== 'watcher' && record.executionKind !== 'cache_retention';
