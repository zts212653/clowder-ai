import { ROUTING_EVENT_WAIT_REASON } from '../../infrastructure/telemetry/genai-semconv.js';
import {
  routingEventWaitFalseBypassTotal,
  routingEventWaitRejectedTotal,
} from '../../infrastructure/telemetry/instruments.js';
import type { QueuedMessageCustody, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import {
  isLiveTypedWaitRegistration,
  type TypedWaitContinuationIdentity,
  type TypedWaitReference,
  type TypedWaitRegistrationSnapshot,
} from './TypedWaitRegistration.js';

/** Internal commit dependency, never serialized into a message or public Task. */
export interface TypedWaitCustodyGuard {
  readonly identity: TypedWaitContinuationIdentity;
  readonly reference: TypedWaitReference;
  readonly readSnapshot: () => TypedWaitRegistrationSnapshot | null | Promise<TypedWaitRegistrationSnapshot | null>;
}

/** Count only the final consumer rejection, never a retried Queue revision conflict or a successful replay. */
export function rejectTypedWaitCustody(
  reason: 'proof_invalid' | 'authority_stale' | 'authority_changed' | 'query_failed',
  cause?: unknown,
): never {
  routingEventWaitFalseBypassTotal.add(1);
  routingEventWaitRejectedTotal.add(1, { [ROUTING_EVENT_WAIT_REASON]: reason });
  throw new Error(`typed wait continuation rejected: ${reason}`, { cause });
}

export function assertTypedWaitCustodyBindings(
  message: StoredMessage,
  next: QueuedMessageCustody,
  guards: readonly TypedWaitCustodyGuard[] = [],
): void {
  for (const [catId, outcome] of Object.entries(next.targetOutcomeByCatId ?? {})) {
    const witness = outcome.consumption;
    if (witness?.kind !== 'managed_hold_continued' || witness.transition !== 'event_wait') continue;
    if (message.queueCustody?.handledByCatIds.some((holder) => holder === catId)) continue;
    const guard = guards.find((candidate) => candidate.identity.catId === catId);
    if (
      !guard ||
      !witness.waitRegistration ||
      guard.identity.invocationId !== outcome.invocationId ||
      guard.identity.sourceMessageId !== message.id ||
      witness.sourceMessageId !== message.id ||
      guard.identity.threadId !== message.threadId ||
      guard.identity.userId !== message.queueCustody?.ownerUserId ||
      message.source?.connector !== 'hold-ball' ||
      message.source.meta?.wakeWhen !== true ||
      message.source.meta?.threadId !== guard.identity.threadId ||
      message.source.meta?.catId !== catId ||
      guard.identity.holdTaskId !== witness.taskId ||
      witness.taskId !== message.source?.meta?.taskId ||
      witness.waitRegistration.taskId !== guard.reference.taskId ||
      witness.waitRegistration.generation !== guard.reference.generation
    ) {
      rejectTypedWaitCustody('proof_invalid');
    }
  }
}

/** Memory store calls this in the same synchronous section as its Queue mutation. */
export function assertMemoryTypedWaitCustody(guards: readonly TypedWaitCustodyGuard[] = []): void {
  for (const guard of guards) {
    let snapshot: ReturnType<TypedWaitCustodyGuard['readSnapshot']>;
    try {
      snapshot = guard.readSnapshot();
    } catch (error) {
      rejectTypedWaitCustody('query_failed', error);
    }
    if (
      snapshot instanceof Promise ||
      !isLiveTypedWaitRegistration(snapshot, guard.identity, Date.now(), guard.reference)
    ) {
      rejectTypedWaitCustody('authority_stale');
    }
  }
}
