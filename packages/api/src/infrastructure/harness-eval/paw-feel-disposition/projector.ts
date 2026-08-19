import type { PawFeelDispositionEvent, PawFeelDispositionProjection, PawFeelDispositionState } from '@cat-cafe/shared';
import { buildPawFeelSignalId } from '../friction/paw-feel-source.js';
import { parsePawFeelDispositionEvent } from './schema.js';

function fail(message: string): never {
  throw new Error(`paw-feel projection: ${message}`);
}

function requireDispositionActor(
  event: PawFeelDispositionEvent,
): Extract<PawFeelDispositionEvent['actor'], { kind: 'cat' | 'cvo' }> {
  if (event.actor.kind === 'automation') fail(`automation cannot append ${event.type}`);
  if (event.actor.kind !== 'cat' && event.actor.kind !== 'cvo') {
    fail(`${event.type} requires a cat or operator actor`);
  }
  return event.actor;
}

function requireTransition(
  current: PawFeelDispositionState,
  expected: PawFeelDispositionState,
  event: PawFeelDispositionEvent,
): void {
  if (current !== expected) {
    fail(`illegal transition: ${current} --${event.type}--> ?`);
  }
}

function assertRoutePendingEvidence(event: Extract<PawFeelDispositionEvent, { type: 'route_pending' }>): void {
  const exactOwner = event.targetThreadId !== undefined && event.ownerEvidenceRef !== undefined;
  if (!exactOwner && event.proposalId === undefined) {
    fail('route_pending requires exact owner evidence or an F128 proposal');
  }
}

function assertSourceIdentity(event: Extract<PawFeelDispositionEvent, { type: 'discovered' }>): void {
  const expected = buildPawFeelSignalId(
    event.source.sourceMessageId,
    event.source.markerDigest,
    event.source.sameDigestOrdinal,
  );
  if (event.signalId !== expected) {
    fail(`signal identity mismatch: expected ${expected}, got ${event.signalId}`);
  }
}

function transitionSeen(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'seen' }>,
): PawFeelDispositionProjection {
  requireTransition(projection.state, 'new', event);
  return { ...projection, state: 'seen' };
}

function transitionRoutePending(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'route_pending' }>,
): PawFeelDispositionProjection {
  requireTransition(projection.state, 'seen', event);
  assertRoutePendingEvidence(event);
  return {
    ...projection,
    state: 'route_pending',
    ...(event.targetThreadId ? { targetThreadId: event.targetThreadId } : {}),
    ...(event.proposalId ? { proposalId: event.proposalId } : {}),
  };
}

function transitionRouted(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'routed' }>,
): PawFeelDispositionProjection {
  requireTransition(projection.state, 'route_pending', event);
  if (projection.targetThreadId && event.targetThreadId && projection.targetThreadId !== event.targetThreadId) {
    fail('routed target differs from route_pending target');
  }
  if (projection.proposalId && event.proposalId && projection.proposalId !== event.proposalId) {
    fail('routed proposal differs from route_pending proposal');
  }
  return {
    ...projection,
    state: 'routed',
    outcomeRef: event.receiptRef,
    ...(event.targetThreadId ? { targetThreadId: event.targetThreadId } : {}),
    ...(event.proposalId ? { proposalId: event.proposalId } : {}),
  };
}

function transitionReopened(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'route_reopened' }>,
): PawFeelDispositionProjection {
  requireTransition(projection.state, 'route_pending', event);
  const { proposalId: _proposalId, targetThreadId: _targetThreadId, ...reopened } = projection;
  return { ...reopened, state: 'seen', reasonCode: event.reasonCode };
}

function transitionClosed(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'closed' }>,
): PawFeelDispositionProjection {
  requireTransition(projection.state, 'seen', event);
  return { ...projection, state: 'closed', reasonCode: event.reasonCode, outcomeRef: event.outcomeRef };
}

function transitionDuplicate(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'duplicate' }>,
): PawFeelDispositionProjection {
  requireActionableTransition(projection, event);
  if (event.duplicateOf === projection.signalId) fail('duplicate target cannot reference itself');
  return {
    ...clearPriorResponsibility(projection),
    state: 'duplicate',
    duplicateOf: event.duplicateOf,
    ...(event.ownerCatId ? { ownerCatId: event.ownerCatId } : {}),
  };
}

function transitionNoAction(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'no_action' }>,
): PawFeelDispositionProjection {
  requireActionableTransition(projection, event);
  return {
    ...clearPriorResponsibility(projection),
    state: 'no_action',
    reasonCode: event.reasonCode,
    ...(event.ownerCatId ? { ownerCatId: event.ownerCatId } : {}),
  };
}

function transitionFix(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'fix' }>,
): PawFeelDispositionProjection {
  requireActionableTransition(projection, event);
  return {
    ...clearPriorResponsibility(projection),
    state: 'fix',
    ownerCatId: event.ownerCatId,
    taskId: event.taskId,
    actionLeaseRef: { leaseId: event.leaseId, generation: event.leaseGeneration },
    custodyEvidenceRef: event.custodyEvidenceRef,
  };
}

function transitionSignatureRequested(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'signature_requested' }>,
): PawFeelDispositionProjection {
  requireActionableTransition(projection, event);
  if (event.actor.kind !== 'cat') fail('signature request requires a cat reviewer');
  if (event.preferredSignerCatId === projection.sourceCatId) {
    fail('preferred signer must be independent from the source cat');
  }
  return {
    ...clearPriorResponsibility(projection),
    state: 'signature_waiting',
    signatureRequest: {
      requestId: event.eventId,
      requestedByCatId: event.actor.id,
      excludedSignerCatId: projection.sourceCatId,
      ...(event.preferredSignerCatId ? { preferredSignerCatId: event.preferredSignerCatId } : {}),
      action: event.action,
    },
  };
}

function transitionBlocked(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'blocked' }>,
): PawFeelDispositionProjection {
  requireActionableTransition(projection, event);
  return {
    ...clearPriorResponsibility(projection),
    state: 'blocked',
    blocker: { code: event.blockerCode, ref: event.blockerRef },
  };
}

function requireActionableTransition(projection: PawFeelDispositionProjection, event: PawFeelDispositionEvent): void {
  if (
    projection.state !== 'new' &&
    projection.state !== 'seen' &&
    projection.state !== 'route_pending' &&
    projection.state !== 'routed' &&
    projection.state !== 'signature_waiting' &&
    projection.state !== 'blocked' &&
    projection.state !== 'fix'
  ) {
    fail(`illegal transition: ${projection.state} --${event.type}--> ?`);
  }
}

function clearPriorResponsibility(projection: PawFeelDispositionProjection): PawFeelDispositionProjection {
  const {
    proposalId: _proposalId,
    targetThreadId: _targetThreadId,
    signatureRequest: _signatureRequest,
    blocker: _blocker,
    ownerCatId: _ownerCatId,
    taskId: _taskId,
    actionLeaseRef: _actionLeaseRef,
    custodyEvidenceRef: _custodyEvidenceRef,
    duplicateOf: _duplicateOf,
    reasonCode: _reasonCode,
    outcomeRef: _outcomeRef,
    ...clean
  } = projection;
  return clean;
}

function assertRequestedActionMatches(projection: PawFeelDispositionProjection, event: PawFeelDispositionEvent): void {
  const requested = projection.signatureRequest?.action;
  if (!requested) return;
  const matches =
    (requested.type === 'duplicate' && event.type === 'duplicate' && requested.duplicateOf === event.duplicateOf) ||
    (requested.type === 'no_action' && event.type === 'no_action' && requested.reasonCode === event.reasonCode) ||
    (requested.type === 'fix' &&
      event.type === 'fix' &&
      requested.ownerCatId === event.ownerCatId &&
      requested.taskId === event.taskId &&
      requested.leaseId === event.leaseId &&
      requested.leaseGeneration === event.leaseGeneration &&
      requested.custodyEvidenceRef === event.custodyEvidenceRef);
  if (!matches) fail('terminal signature does not match the durable signature request');
}

function applyDispositionEvent(
  projection: PawFeelDispositionProjection,
  event: Exclude<PawFeelDispositionEvent, { type: 'discovered' }>,
): PawFeelDispositionProjection {
  if (
    projection.state === 'signature_waiting' &&
    (event.type === 'duplicate' || event.type === 'no_action' || event.type === 'fix')
  ) {
    assertRequestedActionMatches(projection, event);
  }
  switch (event.type) {
    case 'seen':
      return transitionSeen(projection, event);
    case 'route_pending':
      return transitionRoutePending(projection, event);
    case 'routed':
      return transitionRouted(projection, event);
    case 'route_reopened':
      return transitionReopened(projection, event);
    case 'closed':
      return transitionClosed(projection, event);
    case 'duplicate':
      return transitionDuplicate(projection, event);
    case 'no_action':
      return transitionNoAction(projection, event);
    case 'fix':
      return transitionFix(projection, event);
    case 'signature_requested':
      return transitionSignatureRequested(projection, event);
    case 'blocked':
      return transitionBlocked(projection, event);
  }
}

function isSignedFinalDisposition(state: PawFeelDispositionState): boolean {
  return state === 'closed' || state === 'duplicate' || state === 'no_action' || state === 'fix';
}

function assertTerminalSigner(
  projection: PawFeelDispositionProjection,
  next: PawFeelDispositionProjection,
  actor: Extract<PawFeelDispositionEvent['actor'], { kind: 'cat' | 'cvo' }>,
): void {
  if (isSignedFinalDisposition(next.state) && actor.kind === 'cat' && actor.id === projection.sourceCatId) {
    fail('source cat cannot sign its own terminal disposition');
  }
}

export function projectPawFeelDisposition(rawEvents: readonly PawFeelDispositionEvent[]): PawFeelDispositionProjection {
  if (rawEvents.length === 0) fail('discovered event is required');
  const events = rawEvents.map(parsePawFeelDispositionEvent);
  const opened = events[0];
  if (!opened || opened.type !== 'discovered') fail('discovered event must be the lifecycle prefix');
  if (opened.actor.kind !== 'automation' && opened.actor.kind !== 'migration') {
    fail('discovered event requires automation or migration actor');
  }
  assertSourceIdentity(opened);

  let projection: PawFeelDispositionProjection = {
    signalId: opened.signalId,
    ...opened.source,
    state: 'new',
    sequence: 1,
    discoveredAt: opened.occurredAt,
    lastTransitionAt: opened.occurredAt,
    backfilled: opened.backfilled,
    captureMethod: opened.captureMethod,
    captureAssessment: opened.captureAssessment,
  };
  let priorTimestamp = Date.parse(opened.occurredAt);

  for (const event of events.slice(1)) {
    if (event.signalId !== projection.signalId) fail('event signal identity differs from lifecycle root');
    const eventTimestamp = Date.parse(event.occurredAt);
    if (eventTimestamp < priorTimestamp) fail('event timestamps must be monotonic');
    priorTimestamp = eventTimestamp;
    if (event.type === 'discovered') fail('discovered event may only appear once');
    const actor = requireDispositionActor(event);
    const next = applyDispositionEvent(projection, event);
    const legacyOwner =
      isSignedFinalDisposition(next.state) &&
      (event.type === 'duplicate' || event.type === 'no_action') &&
      !next.ownerCatId &&
      actor.kind === 'cat'
        ? actor.id
        : undefined;
    const nextWithLegacyOwner = legacyOwner ? { ...next, ownerCatId: legacyOwner } : next;
    assertTerminalSigner(projection, nextWithLegacyOwner, actor);
    projection = {
      ...nextWithLegacyOwner,
      sequence: projection.sequence + 1,
      lastTransitionAt: event.occurredAt,
      ...(actor.kind === 'cat' ? { lastActorCatId: actor.id } : {}),
    };
  }

  return projection;
}
