import { randomUUID } from 'node:crypto';
import { normalizeThreadGoalObjective } from '@cat-cafe/shared';
import type { IThreadStore, ThreadGoalStateV1 } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ProviderNativeGoal } from '../domains/cats/services/types.js';
import type { NativeSessionTarget } from './native-session-target.js';
import { type GoalSyncResult, goalSemanticEvent, isClearedFence } from './native-thread-goal-projection.js';

export function nativeGoalRequest(target: NativeSessionTarget, goal: ThreadGoalStateV1) {
  return {
    sessionId: target.sessionId,
    invocationId: `native-goal-${randomUUID()}`,
    timeoutMs: 30_000,
    request:
      goal.intent === 'clear'
        ? ({ action: 'clear' } as const)
        : ({
            action: 'set',
            objective: goal.objective ?? '',
            status: goal.status ?? 'active',
            tokenBudget: goal.tokenBudget ?? null,
          } as const),
  };
}

export async function applySyncedGoal(
  store: IThreadStore,
  threadId: string,
  expectedRevision: number | null,
  goal: ThreadGoalStateV1,
  catId: string,
): Promise<GoalSyncResult> {
  const applied = await store.compareAndSetGoal(threadId, expectedRevision, goal);
  const state = goal.intent === 'clear' ? 'cleared' : 'updated';
  return {
    goal: applied ? goal : ((await store.get(threadId))?.goal ?? null),
    synced: applied,
    ...(applied ? { event: goalSemanticEvent(threadId, goal, state), catId } : {}),
  };
}

export async function applyRefreshedGoal(
  store: IThreadStore,
  threadId: string,
  target: NativeSessionTarget,
  providerGoal: ProviderNativeGoal['goal'],
): Promise<GoalSyncResult> {
  const current = await store.get(threadId);
  if (!providerGoal) return reconcileAbsentProviderGoal(store, threadId, current?.goal ?? null);
  if (current?.goal) {
    if (isClearedFence(current.goal)) return { goal: current.goal, synced: true };
    if (providerGoalMatches(current.goal, providerGoal)) return { goal: current.goal, synced: true };
    return markUnavailable(store, threadId, current.goal, 'provider_goal_conflict');
  }
  const objective = normalizeThreadGoalObjective(providerGoal.objective);
  if (!objective) return { goal: null, synced: false };
  const adopted: ThreadGoalStateV1 = {
    v: 1,
    intent: 'set',
    objective,
    status: providerGoal.status,
    tokenBudget: providerGoal.tokenBudget,
    revision: 1,
    updatedAt: providerGoal.updatedAt,
    sync: {
      state: 'synced',
      source: 'codex_app_server',
      catId: target.catId,
      sessionId: target.sessionId,
      observedAt: providerGoal.updatedAt,
    },
  };
  return applySyncedGoal(store, threadId, null, adopted, target.catId);
}

function providerGoalMatches(
  current: ThreadGoalStateV1,
  providerGoal: NonNullable<ProviderNativeGoal['goal']>,
): boolean {
  return (
    current.intent === 'set' &&
    normalizeThreadGoalObjective(current.objective) === normalizeThreadGoalObjective(providerGoal.objective) &&
    current.status === providerGoal.status &&
    (current.tokenBudget ?? null) === providerGoal.tokenBudget
  );
}

async function reconcileAbsentProviderGoal(
  store: IThreadStore,
  threadId: string,
  goal: ThreadGoalStateV1 | null,
): Promise<GoalSyncResult> {
  if (!goal) return { goal: null, synced: true };
  if (isClearedFence(goal)) return { goal, synced: true };
  return markUnavailable(store, threadId, goal, 'provider_goal_absent');
}

export async function markUnavailable(
  store: IThreadStore,
  threadId: string,
  goal: ThreadGoalStateV1,
  reason: string,
): Promise<{ goal: ThreadGoalStateV1 | null; synced: false }> {
  const unavailable: ThreadGoalStateV1 = {
    ...goal,
    revision: goal.revision + 1,
    updatedAt: Date.now(),
    sync: { ...goal.sync, state: 'unavailable', reason },
  };
  const applied = await store.compareAndSetGoal(threadId, goal.revision, unavailable);
  return { goal: applied ? unavailable : ((await store.get(threadId))?.goal ?? null), synced: false };
}
