import type {
  IThreadStore,
  ThreadGoalStateV1,
  ThreadGoalStatus,
} from '../domains/cats/services/stores/ports/ThreadStore.js';

export async function writeGoalIntent(
  store: IThreadStore,
  threadId: string,
  input: {
    intent: 'set' | 'clear';
    objective?: string;
    status?: ThreadGoalStatus;
    tokenBudget?: number | null;
    syncState: 'syncing' | 'clearing';
    catId?: string;
  },
): Promise<ThreadGoalStateV1 | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await store.get(threadId);
    if (!current) return null;
    const goal = buildGoalIntent(input, current.goal?.revision ?? 0);
    if (await store.compareAndSetGoal(threadId, current.goal?.revision ?? null, goal)) return goal;
  }
  return null;
}

function buildGoalIntent(
  input: {
    intent: 'set' | 'clear';
    objective?: string;
    status?: ThreadGoalStatus;
    tokenBudget?: number | null;
    syncState: 'syncing' | 'clearing';
    catId?: string;
  },
  revision: number,
): ThreadGoalStateV1 {
  const goal: ThreadGoalStateV1 = {
    v: 1,
    intent: input.intent,
    revision: revision + 1,
    updatedAt: Date.now(),
    sync: { state: input.syncState, source: 'cat_cafe' },
  };
  if (input.objective) goal.objective = input.objective;
  if (input.status) goal.status = input.status;
  if (input.intent === 'set') goal.tokenBudget = input.tokenBudget ?? null;
  if (input.catId) goal.sync.catId = input.catId;
  return goal;
}
