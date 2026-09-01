import type { FreshnessClosureAggregate } from '@cat-cafe/shared';

export function parseClosure(raw: string | null): FreshnessClosureAggregate | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as FreshnessClosureAggregate & {
    originTriggerMessageId?: string | null;
    turnInvocationId?: string;
  };
  const value: FreshnessClosureAggregate = {
    ...parsed,
    originTriggerMessageId: parsed.originTriggerMessageId ?? null,
    turnInvocationId: parsed.turnInvocationId ?? parsed.latestDraft.invocationId,
  };
  if (!value.id || !value.userId || !value.threadId || !value.catId || typeof value.revision !== 'number') {
    throw new Error('invalid persisted freshness closure');
  }
  return value;
}

export function isTerminal(closure: FreshnessClosureAggregate): boolean {
  return closure.status === 'committed' || closure.status === 'disposed';
}
