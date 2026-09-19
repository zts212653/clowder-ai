import { resolveTypedWaitContinuation } from '../../../../../ball-custody/TypedWaitContinuation.js';
import type { TypedWaitReference } from '../../../../../ball-custody/TypedWaitRegistration.js';
import type { ITaskStore } from '../../../stores/ports/TaskStoreContract.js';

export type EventBackedRoutingExitRejectReason =
  | 'state_source_unavailable'
  | 'missing_identity'
  | 'no_candidate'
  | 'query_failed';

export type EventBackedRoutingExitResolution =
  | { kind: 'bypass'; reference: TypedWaitReference }
  | { kind: 'reject'; reason: EventBackedRoutingExitRejectReason };

export interface EventBackedRoutingSourceIdentity {
  sourceMessageId: string;
  holdTaskId?: string;
}

interface ResolveEventBackedRoutingExitInput {
  taskStore: Pick<ITaskStore, 'listByThread' | 'getWaitRegistration'> | undefined;
  userId: string;
  threadId: string;
  catId: string;
  invocationId: string | undefined;
  sources: readonly EventBackedRoutingSourceIdentity[];
  now?: number;
}

/**
 * An event-backed routing exit is authoritative only when one current private
 * Task registration binds this exact child invocation and one of its exact
 * lifecycle input messages. Public Task fields alone never grant the bypass.
 */
export async function resolveEventBackedRoutingExit(
  input: ResolveEventBackedRoutingExitInput,
): Promise<EventBackedRoutingExitResolution> {
  if (!input.taskStore?.getWaitRegistration) return { kind: 'reject', reason: 'state_source_unavailable' };
  if (!input.invocationId || input.sources.length === 0) return { kind: 'reject', reason: 'missing_identity' };

  let observedReject: EventBackedRoutingExitRejectReason = 'no_candidate';
  for (const source of input.sources) {
    const resolution = await resolveTypedWaitContinuation({
      taskStore: input.taskStore,
      invocationId: input.invocationId,
      userId: input.userId,
      catId: input.catId,
      threadId: input.threadId,
      sourceMessageId: source.sourceMessageId,
      ...(source.holdTaskId ? { holdTaskId: source.holdTaskId } : {}),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (resolution.kind === 'bypass') return resolution;
    if (resolution.reason === 'query_failed' || resolution.reason === 'state_source_unavailable') {
      return resolution;
    }
    observedReject = resolution.reason;
  }
  return { kind: 'reject', reason: observedReject };
}
