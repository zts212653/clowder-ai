import type { AgentRegistry } from '../domains/cats/services/agents/registry/AgentRegistry.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';

export interface NativeSessionTarget {
  readonly catId: string;
  readonly sessionId: string;
  readonly service: ReturnType<AgentRegistry['get']>;
}

export async function resolveNativeSessionTarget(input: {
  readonly agentRegistry: AgentRegistry;
  readonly sessionChainStore: ISessionChainStore;
  readonly threadId: string;
  readonly userId: string;
  readonly requestedCatId?: string;
  readonly capability: 'requestNativeGoal' | 'requestNativeReview';
}): Promise<NativeSessionTarget | null> {
  const candidates = await listNativeSessionTargets(input);
  return candidates.length === 1 ? candidates[0] : null;
}

export async function listNativeSessionTargets(input: {
  readonly agentRegistry: AgentRegistry;
  readonly sessionChainStore: ISessionChainStore;
  readonly threadId: string;
  readonly userId: string;
  readonly requestedCatId?: string;
  readonly capability: 'requestNativeGoal' | 'requestNativeReview';
}): Promise<NativeSessionTarget[]> {
  const sessions = await input.sessionChainStore.getChainByThread(input.threadId);
  const candidates = sessions.filter(
    (session) =>
      session.status === 'active' &&
      session.userId === input.userId &&
      !!session.cliSessionId &&
      (!input.requestedCatId || session.catId === input.requestedCatId) &&
      input.agentRegistry.has(session.catId) &&
      !!input.agentRegistry.get(session.catId)[input.capability],
  );
  return candidates
    .map((session) => ({
      catId: session.catId,
      sessionId: session.cliSessionId as string,
      service: input.agentRegistry.get(session.catId),
    }))
    .sort((left, right) => left.catId.localeCompare(right.catId));
}
