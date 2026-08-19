import type { FreshnessClosureScope } from '../../freshness/FreshnessClosureStore.js';

function part(value: string): string {
  return encodeURIComponent(value);
}

export const FreshnessClosureKeys = {
  DETAIL_PREFIX: 'freshness:closure:detail:',
  ALL: 'freshness:closure:all',
  detail(closureId: string): string {
    return `${this.DETAIL_PREFIX}${part(closureId)}`;
  },
  activeScope(scope: FreshnessClosureScope): string {
    return `freshness:closure:active:${part(scope.userId)}:${part(scope.threadId)}:${part(scope.catId)}`;
  },
  lineages(scope: FreshnessClosureScope): string {
    return `freshness:closure:lineages:v2:${part(scope.userId)}:${part(scope.threadId)}:${part(scope.catId)}`;
  },
  runningLease(scope: FreshnessClosureScope): string {
    return `freshness:closure:running:v2:${part(scope.userId)}:${part(scope.threadId)}:${part(scope.catId)}`;
  },
  thread(threadId: string): string {
    return `freshness:closure:thread:${part(threadId)}`;
  },
} as const;

/** ADR-042 supplement records share the F254 store but never reuse closure carriers/keys. */
export const FreshnessSupplementKeys = {
  DETAIL_PREFIX: 'freshness:supplement:detail:',
  ALL: 'freshness:supplement:all',
  detail(supplementId: string): string {
    return `${this.DETAIL_PREFIX}${part(supplementId)}`;
  },
  lineage(lineageId: string): string {
    return `freshness:supplement:lineage:${part(lineageId)}`;
  },
  runningLease(lineageId: string): string {
    return `freshness:supplement:running:${part(lineageId)}`;
  },
  thread(threadId: string): string {
    return `freshness:supplement:thread:${part(threadId)}`;
  },
} as const;
