import { createCatId, type ProviderGoalSemanticEvent, projectProviderSemanticEvent } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ThreadGoalStateV1 } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ProviderNativeGoal } from '../domains/cats/services/types.js';
import type { NativeSessionTarget } from './native-session-target.js';

export interface GoalSyncResult {
  readonly goal: ThreadGoalStateV1 | null;
  readonly synced: boolean;
  readonly event?: ProviderGoalSemanticEvent;
  readonly catId?: string;
}

export function syncedGoal(
  goal: ThreadGoalStateV1,
  target: NativeSessionTarget,
  result: ProviderNativeGoal,
): ThreadGoalStateV1 {
  const observedAt = result.goal?.updatedAt ?? Date.now();
  return {
    ...goal,
    revision: goal.revision + 1,
    updatedAt: observedAt,
    sync: {
      state: 'synced',
      source: 'codex_app_server',
      catId: target.catId,
      sessionId: target.sessionId,
      observedAt,
    },
  };
}

export function syncedClearFence(
  goal: ThreadGoalStateV1,
  target: NativeSessionTarget,
  observedAt: number,
): ThreadGoalStateV1 {
  return {
    v: 1,
    intent: 'clear',
    revision: goal.revision + 1,
    updatedAt: observedAt,
    clearedAt: observedAt,
    sync: {
      state: 'synced',
      source: 'codex_app_server',
      catId: target.catId,
      sessionId: target.sessionId,
      observedAt,
    },
  };
}

export function visibleGoal(goal: ThreadGoalStateV1 | null | undefined): ThreadGoalStateV1 | null {
  return goal && !isClearedFence(goal) ? goal : null;
}

export function isClearedFence(goal: ThreadGoalStateV1): boolean {
  return goal.intent === 'clear' && goal.sync.state === 'synced';
}

export function goalSemanticEvent(
  threadId: string,
  goal: ThreadGoalStateV1,
  state: 'updated' | 'cleared',
): ProviderGoalSemanticEvent {
  const observedAt = goal.sync.observedAt ?? goal.updatedAt;
  return {
    v: 1,
    id: `native-goal:${threadId}:${goal.revision}:${state}`,
    kind: 'goal',
    occurredAt: observedAt,
    state,
    revision: goal.revision,
    ...(state === 'updated' ? { objective: goal.objective, status: goal.status } : {}),
    source: goal.sync.source,
    observedAt,
    provenance: { provider: 'openai_codex', carrier: 'app_server', nativeType: `thread/goal/${state}` },
  };
}

export async function appendGoalEvent(
  options: {
    readonly messageStore: IMessageStore;
    readonly publishMessage?: (threadId: string, message: StoredMessage) => void;
  },
  access: { readonly threadId: string; readonly userId: string },
  catId: string,
  event: ProviderGoalSemanticEvent,
): Promise<void> {
  const projection = projectProviderSemanticEvent(event);
  if (projection.status !== 'projected') throw new Error('invalid_goal_semantic_event');
  const stored = await options.messageStore.append({
    userId: access.userId,
    catId: createCatId(catId),
    threadId: access.threadId,
    content: projection.content,
    mentions: [],
    timestamp: event.occurredAt,
    idempotencyKey: event.id,
    extra: { semanticEvent: event },
  });
  options.publishMessage?.(access.threadId, stored);
}
