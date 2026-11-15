import type { WatcherSurfaceRetirement } from '@cat-cafe/shared';
import type { BoundedWatcherNativeClient } from '../../../cats/services/agents/providers/BoundedWatcherRunPort.js';
import { asCodexAppServerRecord } from '../../../cats/services/agents/providers/CodexAppServerEventMapper.js';

/** Full, positive history proof; missing target, malformed/unknown history and foreign tails are never empty. */
export function watcherRetirementClient(
  client: BoundedWatcherNativeClient,
  operation: WatcherSurfaceRetirement,
  signal: AbortSignal,
) {
  const threadId = operation.nativeCliSessionId;
  if (!threadId) throw new Error('watcher_retirement_binding_missing');
  const read = async () => {
    signal.throwIfAborted();
    const result = await client.request('thread/read', { threadId, includeTurns: true });
    signal.throwIfAborted();
    const thread = asCodexAppServerRecord(asCodexAppServerRecord(result)?.thread);
    if (thread?.id !== threadId || !Array.isArray(thread.turns)) throw new Error('watcher_native_history_unavailable');
    const turns: Record<string, unknown>[] = [];
    for (const raw of thread.turns) {
      const turn = asCodexAppServerRecord(raw);
      if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items))
        throw new Error('watcher_native_history_unavailable');
      turns.push(turn);
    }
    if (turns.some((turn) => !['completed', 'interrupted', 'failed'].includes(String(turn.status))))
      throw new Error('watcher_native_still_active');
    if (turns.length) {
      const owned = turns.filter((turn) =>
        operation.nativeTurnId
          ? turn.id === operation.nativeTurnId
          : JSON.stringify(turn.items).includes(`watcherAttemptId=${operation.wakeInvocationId}`),
      );
      if (turns.length !== 1 || owned.length !== 1 || owned[0] !== turns.at(-1))
        throw new Error('watcher_unowned_native_turn');
    }
    return { result, turns };
  };
  return {
    read: async () => (await read()).result,
    assertEmpty: async () => {
      if ((await read()).turns.length) throw new Error('watcher_retirement_native_not_pruned');
    },
    client: {
      async request(method, params) {
        if (params.threadId !== threadId) throw new Error('watcher_native_binding_mismatch');
        if (method === 'thread/read' && params.includeTurns === true) return (await read()).result;
        if (method !== 'thread/revert' || typeof params.beforeTurnId !== 'string')
          throw new Error('watcher_retirement_rpc_forbidden');
        const { turns } = await read();
        if (turns.at(-1)?.id !== params.beforeTurnId) throw new Error('watcher_retirement_turn_changed');
        signal.throwIfAborted();
        return client.request(method, params);
      },
    } satisfies BoundedWatcherNativeClient,
  };
}
