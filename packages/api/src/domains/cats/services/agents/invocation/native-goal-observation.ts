import { type CatId, normalizeThreadGoalObjective, type ProviderGoalSemanticEvent } from '@cat-cafe/shared';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { IThreadStore, ThreadGoalStateV1 } from '../../stores/ports/ThreadStore.js';
import type { AgentMessage, ProviderNativeGoalObservation } from '../../types.js';

interface NativeGoalObservationInput {
  readonly threadStore: IThreadStore;
  readonly sessionChainStore: ISessionChainStore;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: CatId;
  readonly observation: ProviderNativeGoalObservation;
}

export async function projectNativeGoalMessage(
  input: Omit<NativeGoalObservationInput, 'observation'> & { readonly message: AgentMessage },
): Promise<AgentMessage | null> {
  if (!input.message.nativeGoalObservation) return input.message;
  const event = await applyNativeGoalObservation({ ...input, observation: input.message.nativeGoalObservation });
  if (!event) return null;
  const { nativeGoalObservation: _observation, ...message } = input.message;
  return { ...message, semanticEvent: event };
}

/** Apply one provider-native goal observation only through its exact active Clowder AI binding. */
export async function applyNativeGoalObservation(
  input: NativeGoalObservationInput,
): Promise<ProviderGoalSemanticEvent | null> {
  const active = await input.sessionChainStore.getActive(input.catId, input.threadId, input.userId);
  if (!active || active.cliSessionId !== input.observation.runtimeSessionId) return null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const thread = await input.threadStore.get(input.threadId);
    if (!thread) return null;
    const current = thread.goal;
    if (input.observation.state === 'updated') {
      const objective = normalizeThreadGoalObjective(input.observation.objective);
      if (!objective) return null;
      if (current?.intent === 'clear' || (current ? alreadyObserved(current, input.observation) : false)) return null;
      const revision = (current?.revision ?? 0) + 1;
      const next: ThreadGoalStateV1 = {
        v: 1,
        intent: 'set',
        objective,
        status: input.observation.status,
        tokenBudget: input.observation.tokenBudget,
        revision,
        updatedAt: input.observation.providerUpdatedAt,
        sync: {
          state: 'synced',
          source: 'codex_app_server',
          catId: input.catId,
          sessionId: input.observation.runtimeSessionId,
          observedAt: input.observation.providerUpdatedAt,
        },
      };
      if (await input.threadStore.compareAndSetGoal(input.threadId, current?.revision ?? null, next)) {
        return updatedEvent(input, next);
      }
      continue;
    }

    if (!current || (current.intent === 'clear' && current.sync.state === 'synced')) return null;
    const observedAt = Date.now();
    const revision = current.revision + 1;
    const cleared: ThreadGoalStateV1 = {
      v: 1,
      intent: 'clear',
      revision,
      updatedAt: observedAt,
      clearedAt: observedAt,
      sync: {
        state: 'synced',
        source: 'codex_app_server',
        catId: input.catId,
        sessionId: input.observation.runtimeSessionId,
        observedAt,
      },
    };
    if (await input.threadStore.compareAndSetGoal(input.threadId, current.revision, cleared)) {
      return clearedEvent(input, revision, observedAt);
    }
  }
  return null;
}

function alreadyObserved(
  current: ThreadGoalStateV1,
  observation: Extract<ProviderNativeGoalObservation, { state: 'updated' }>,
): boolean {
  return (
    current.updatedAt >= observation.providerUpdatedAt ||
    (current.sync.source === 'codex_app_server' &&
      current.sync.sessionId === observation.runtimeSessionId &&
      (current.sync.observedAt ?? -1) >= observation.providerUpdatedAt)
  );
}

function updatedEvent(input: NativeGoalObservationInput, goal: ThreadGoalStateV1): ProviderGoalSemanticEvent {
  return {
    v: 1,
    id: `native-goal:${input.threadId}:${goal.revision}:updated`,
    kind: 'goal',
    occurredAt: goal.sync.observedAt ?? goal.updatedAt,
    state: 'updated',
    revision: goal.revision,
    objective: goal.objective,
    status: goal.status,
    source: input.observation.source,
    observedAt: goal.sync.observedAt ?? goal.updatedAt,
    provenance: { provider: 'openai_codex', carrier: 'app_server', nativeType: 'thread/goal/updated' },
  };
}

function clearedEvent(
  input: NativeGoalObservationInput,
  revision: number,
  observedAt: number,
): ProviderGoalSemanticEvent {
  return {
    v: 1,
    id: `native-goal:${input.threadId}:${revision}:cleared`,
    kind: 'goal',
    occurredAt: observedAt,
    state: 'cleared',
    revision,
    source: input.observation.source,
    observedAt,
    provenance: { provider: 'openai_codex', carrier: 'app_server', nativeType: 'thread/goal/cleared' },
  };
}
