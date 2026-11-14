import { type CrossThreadCoordination, type CrossThreadCoordinationInput, createCatId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { resolveVisibleReplyParent } from '../domains/cats/services/stores/visibility.js';
import type { CrossThreadCoordinationConflict } from './cross-thread-coordination.js';

const OUTBOUND_COORDINATION_SCAN_LIMIT = 200;

type OutboundHistoryStore = IMessageStore & {
  getByThreadIncludingQueued?: (
    threadId: string,
    limit?: number,
    userId?: string,
  ) => StoredMessage[] | Promise<StoredMessage[]>;
};

export interface VerifyOutboundTerminalBindingInput {
  readonly messageStore: IMessageStore;
  readonly actor: { readonly userId: string; readonly catId: string; readonly threadId: string };
  readonly invocationId: string;
  readonly effectiveThreadId: string;
  readonly explicit: CrossThreadCoordinationInput | undefined;
  readonly incomingCoordinationId: string | undefined;
  readonly replyTo: string | undefined;
  readonly existingIdempotentMessage?: StoredMessage | null | undefined;
}

export type OutboundTerminalBindingResult =
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'verified'; readonly outboundActive: CrossThreadCoordination }
  | { readonly kind: 'conflict'; readonly conflict: CrossThreadCoordinationConflict };

function readCoordination(msg: StoredMessage): CrossThreadCoordination | undefined {
  const crossPost = msg.extra?.crossPost;
  const legacy = (crossPost as (typeof crossPost & { coordination?: CrossThreadCoordination }) | undefined)
    ?.coordination;
  return msg.extra?.coordination ?? legacy;
}

function normalizeSubject(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isLiveMessage(msg: StoredMessage): boolean {
  return !msg.deletedAt && !msg.recall && msg.deliveryStatus !== 'canceled';
}

function sameExactCoordination(a: CrossThreadCoordination | undefined, b: CrossThreadCoordination): boolean {
  return Boolean(
    a &&
      a.id === b.id &&
      a.phase === b.phase &&
      a.hop === b.hop &&
      normalizeSubject(a.subjectRef) === normalizeSubject(b.subjectRef),
  );
}

function isOwnedByCurrentInvocation(msg: StoredMessage, input: VerifyOutboundTerminalBindingInput): boolean {
  const sameActor =
    msg.origin === 'callback' &&
    msg.userId === input.actor.userId &&
    msg.from?.kind === 'agent' &&
    msg.catId === input.actor.catId &&
    msg.threadId === input.effectiveThreadId;
  if (!sameActor) return false;
  if (input.effectiveThreadId !== input.actor.threadId) {
    return (
      msg.extra?.crossPost?.sourceThreadId === input.actor.threadId &&
      msg.extra?.crossPost?.sourceInvocationId === input.invocationId
    );
  }
  const streamInvocationId = msg.extra?.stream?.turnInvocationId ?? msg.extra?.stream?.invocationId;
  return !msg.extra?.crossPost && streamInvocationId === input.invocationId;
}

function idConflict(
  incomingCoordinationId: string | undefined,
  explicitCoordinationId: string,
  message?: string,
): CrossThreadCoordinationConflict {
  const fallback = incomingCoordinationId
    ? 'Explicit terminal coordination id conflicts with the incoming coordination lineage.'
    : 'Explicit terminal coordination id is not bound to an active coordination from this invocation.';
  return {
    kind: 'coordination_id_conflict',
    message: message ?? fallback,
    ...(incomingCoordinationId ? { incomingCoordinationId } : {}),
    explicitCoordinationId,
  };
}

async function readTargetHistory(store: IMessageStore, threadId: string, userId: string): Promise<StoredMessage[]> {
  const candidate = store as OutboundHistoryStore;
  return typeof candidate.getByThreadIncludingQueued === 'function'
    ? candidate.getByThreadIncludingQueued(threadId, OUTBOUND_COORDINATION_SCAN_LIMIT, userId)
    : store.getByThread(threadId, OUTBOUND_COORDINATION_SCAN_LIMIT, userId);
}

async function resolveReplyAnchor(
  input: VerifyOutboundTerminalBindingInput,
  explicitId: string,
): Promise<{ readonly parent: StoredMessage | null; readonly conflict?: CrossThreadCoordinationConflict }> {
  if (!input.replyTo) return { parent: null };
  const parent = await resolveVisibleReplyParent(input.messageStore, input.replyTo, {
    threadId: input.effectiveThreadId,
    viewer: { type: 'cat', catId: createCatId(input.actor.catId) },
    publicReply: true,
  });
  if (!parent || parent.userId !== input.actor.userId || !isLiveMessage(parent)) {
    const msg = 'Explicit terminal replyTo anchor was not found or is not active in the target thread.';
    return { parent: null, conflict: idConflict(input.incomingCoordinationId, explicitId, msg) };
  }
  const anchorCoord = readCoordination(parent);
  if (anchorCoord && anchorCoord.id !== explicitId) {
    const msg = 'Explicit terminal replyTo anchor belongs to a different coordination lineage.';
    return { parent: null, conflict: idConflict(input.incomingCoordinationId, explicitId, msg) };
  }
  return { parent };
}

function validateBoundTerminal(
  boundActive: CrossThreadCoordination,
  sameIdMessages: readonly StoredMessage[],
  input: VerifyOutboundTerminalBindingInput,
): CrossThreadCoordinationConflict | undefined {
  const boundSubjectRef = normalizeSubject(boundActive.subjectRef);
  const explicitSubjectRef = normalizeSubject(input.explicit?.subjectRef);
  if (explicitSubjectRef && boundSubjectRef !== explicitSubjectRef) {
    return {
      kind: 'coordination_subject_conflict',
      message: 'Explicit terminal coordination subject conflicts with the bound outbound coordination.',
      coordinationId: boundActive.id,
      ...(boundSubjectRef ? { incomingSubjectRef: boundSubjectRef } : {}),
      explicitSubjectRef,
    };
  }
  const resolvedSubjectRef = boundSubjectRef ?? explicitSubjectRef;
  const expectedTerminal: CrossThreadCoordination = {
    id: boundActive.id,
    phase: 'terminal',
    hop: boundActive.hop + 1,
    ...(resolvedSubjectRef ? { subjectRef: resolvedSubjectRef } : {}),
  };
  const replay = input.existingIdempotentMessage;
  if (
    replay != null &&
    (!isOwnedByCurrentInvocation(replay, input) || !sameExactCoordination(readCoordination(replay), expectedTerminal))
  ) {
    const msg = 'Explicit terminal clientMessageId is already bound to a non-matching message.';
    return idConflict(input.incomingCoordinationId, expectedTerminal.id, msg);
  }
  const alreadyClosed = sameIdMessages.some((m) => {
    const phase = readCoordination(m)?.phase;
    return (phase === 'terminal' || phase === 'ack') && replay?.id !== m.id;
  });
  return alreadyClosed
    ? idConflict(
        input.incomingCoordinationId,
        expectedTerminal.id,
        'Explicit terminal coordination has already been closed.',
      )
    : undefined;
}

export async function verifyOutboundTerminalCoordinationBinding(
  input: VerifyOutboundTerminalBindingInput,
): Promise<OutboundTerminalBindingResult> {
  const explicitId = input.explicit?.id;
  if (input.explicit?.phase !== 'terminal' || !explicitId || explicitId === input.incomingCoordinationId) {
    return { kind: 'not_applicable' };
  }

  const anchor = await resolveReplyAnchor(input, explicitId);
  if (anchor.conflict) return { kind: 'conflict', conflict: anchor.conflict };

  const history = await readTargetHistory(input.messageStore, input.effectiveThreadId, input.actor.userId);
  const candidates =
    anchor.parent && !history.some((m) => m.id === anchor.parent?.id) ? [anchor.parent, ...history] : history;
  const sameIdMessages = candidates.filter((m) => readCoordination(m)?.id === explicitId);
  if (sameIdMessages.length === 0 || !sameIdMessages.every((m) => isOwnedByCurrentInvocation(m, input))) {
    return { kind: 'conflict', conflict: idConflict(input.incomingCoordinationId, explicitId) };
  }

  const liveActiveMessages = sameIdMessages.filter((m) => readCoordination(m)?.phase === 'active' && isLiveMessage(m));
  if (anchor.parent && readCoordination(anchor.parent) && !liveActiveMessages.some((m) => m.id === anchor.parent?.id)) {
    const msg = 'Explicit terminal replyTo anchor is not an active outbound coordination message.';
    return { kind: 'conflict', conflict: idConflict(input.incomingCoordinationId, explicitId, msg) };
  }

  const boundActive = liveActiveMessages.at(-1)
    ? readCoordination(liveActiveMessages.at(-1) as StoredMessage)
    : undefined;
  if (!boundActive) return { kind: 'conflict', conflict: idConflict(input.incomingCoordinationId, explicitId) };

  const terminalConflict = validateBoundTerminal(boundActive, sameIdMessages, input);
  if (terminalConflict) return { kind: 'conflict', conflict: terminalConflict };

  return { kind: 'verified', outboundActive: boundActive };
}
