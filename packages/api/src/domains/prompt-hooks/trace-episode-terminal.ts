import type { TraceToolCall } from '@cat-cafe/shared';
import type { StoredToolEvent } from '../cats/services/stores/ports/MessageStore.js';
import type { InjectionTraceStore } from './InjectionTraceStore.js';

/** Convert persisted tool telemetry into the compact terminal episode view. */
export function buildTraceToolCalls(events: readonly StoredToolEvent[]): TraceToolCall[] {
  const resultsById = new Map(
    events
      .filter((event) => event.type === 'tool_result' && event.toolUseId)
      .map((event) => [event.toolUseId!, { outcome: event.status ?? 'unknown', detail: event.detail }] as const),
  );
  return events
    .filter((event) => event.type === 'tool_use')
    .map((event) => {
      const result = event.toolUseId ? resultsById.get(event.toolUseId) : undefined;
      return {
        toolName: event.toolName ?? event.label,
        ...(event.toolUseId ? { callId: event.toolUseId } : {}),
        outcome: result?.outcome ?? 'unknown',
        ...(result?.detail ? { resultDetail: result.detail } : {}),
      };
    });
}

/** Close observability after terminal persistence without changing route semantics. */
export async function closeTraceEpisode(params: {
  traceStore: InjectionTraceStore;
  traceTurnId: string;
  invocationId: string;
  ownerUserId: string;
  threadId: string;
  catId: string;
  inputMessageId: string | null;
  outputMessageId: string | null;
  terminalKind: 'completed' | 'failed' | 'cancelled';
  toolEvents: readonly StoredToolEvent[];
  terminalAt?: number;
}): Promise<void> {
  await params.traceStore.closeEpisode({
    traceTurnId: params.traceTurnId,
    invocationId: params.invocationId,
    ownerUserId: params.ownerUserId,
    threadId: params.threadId,
    catId: params.catId,
    inputMessageId: params.inputMessageId,
    outputMessageId: params.outputMessageId,
    terminalAt: params.terminalAt ?? Date.now(),
    terminalKind: params.terminalKind,
    toolCalls: buildTraceToolCalls(params.toolEvents),
  });
}
