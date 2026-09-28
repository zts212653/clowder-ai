import type { PawFeelDispositionEvent, PawFeelDispositionProjection, PawFeelDispositionState } from '@cat-cafe/shared';
import { buildPawFeelSignalId } from '../../friction/paw-feel-source.js';

function fail(message: string): never {
  throw new Error(`paw-feel projection: ${message}`);
}

export function requireDispositionActor(
  event: PawFeelDispositionEvent,
): Extract<PawFeelDispositionEvent['actor'], { kind: 'cat' | 'cvo' }> {
  if (event.actor.kind === 'automation') fail(`automation cannot append ${event.type}`);
  if (event.actor.kind !== 'cat' && event.actor.kind !== 'cvo') {
    fail(`${event.type} requires a cat or operator actor`);
  }
  return event.actor;
}

export function assertRoutePendingEvidence(event: Extract<PawFeelDispositionEvent, { type: 'route_pending' }>): void {
  const exactOwner = event.targetThreadId !== undefined && event.ownerEvidenceRef !== undefined;
  if (!exactOwner && event.proposalId === undefined) {
    fail('route_pending requires exact owner evidence or an F128 proposal');
  }
}

export function assertSourceIdentity(event: Extract<PawFeelDispositionEvent, { type: 'discovered' }>): void {
  const expected = buildPawFeelSignalId(
    event.source.sourceMessageId,
    event.source.markerDigest,
    event.source.sameDigestOrdinal,
  );
  if (event.signalId !== expected) fail(`signal identity mismatch: expected ${expected}, got ${event.signalId}`);
}

function isSignedFinalDisposition(state: PawFeelDispositionState): boolean {
  return state === 'closed' || state === 'duplicate' || state === 'no_action' || state === 'fix';
}

export function inferLegacyOwner(
  next: PawFeelDispositionProjection,
  event: PawFeelDispositionEvent,
  actor: Extract<PawFeelDispositionEvent['actor'], { kind: 'cat' | 'cvo' }>,
): string | undefined {
  return isSignedFinalDisposition(next.state) &&
    (event.type === 'duplicate' || event.type === 'no_action') &&
    !next.ownerCatId &&
    actor.kind === 'cat'
    ? actor.id
    : undefined;
}

export function assertTerminalSigner(
  projection: PawFeelDispositionProjection,
  next: PawFeelDispositionProjection,
  actor: Extract<PawFeelDispositionEvent['actor'], { kind: 'cat' | 'cvo' }>,
): void {
  if (isSignedFinalDisposition(next.state) && actor.kind === 'cat' && actor.id === projection.sourceCatId) {
    fail('source cat cannot sign its own terminal disposition');
  }
}
