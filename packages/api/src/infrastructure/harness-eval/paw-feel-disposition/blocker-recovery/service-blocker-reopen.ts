import type { PawFeelDispositionEvent, PawFeelDispositionProjection } from '@cat-cafe/shared';
import { projectPawFeelDisposition } from '../projector.js';
import { parsePawFeelDispositionEvent } from '../schema.js';
import { PawFeelDispositionServiceError } from '../service-guards.js';
import { deriveLegacyPawFeelBlockerReopenEventId, digestLegacyPawFeelBlockerEvent } from './blocker-reopen-identity.js';
import {
  derivePawFeelBlockerReopenEventId,
  derivePawFeelResumeVersion,
  digestPawFeelResumeSnapshot,
  type PawFeelResumeConditionResolver,
  resolvePawFeelResumeSnapshot,
} from './resume-condition.js';

type PawFeelBlockerReopen = Extract<PawFeelDispositionEvent, { type: 'blocker_reopened' }>['reopen'];
type PawFeelBlockerReopenedEvent = Extract<PawFeelDispositionEvent, { type: 'blocker_reopened' }>;
type PawFeelLegacyBlockerReopen = Extract<PawFeelBlockerReopen, { kind: 'legacy_unbound' }>;

interface PawFeelBlockerReopenCommandBase {
  eventId: string;
  signalId: string;
  expectedSequence: number;
  occurredAt: string;
}

export type PawFeelBlockerReopenCommand = PawFeelBlockerReopenCommandBase & {
  reopen: PawFeelLegacyBlockerReopen;
  productionDataAuthorizationRef: string;
};

export type PawFeelBlockerReconcilePlan =
  | { outcome: 'ignored' | 'stable' | 'deferred' }
  | { outcome: 'write'; attempted: PawFeelBlockerReopenedEvent; nextProjection: PawFeelDispositionProjection };

export function preparePawFeelBlockerReopen(command: PawFeelBlockerReopenCommand): PawFeelBlockerReopenedEvent {
  if ((command as { reopen?: { kind?: unknown } }).reopen?.kind !== 'legacy_unbound') {
    throw new PawFeelDispositionServiceError(
      'invalid_command',
      'condition reopen must be derived by the disposition service',
    );
  }
  if (!Number.isSafeInteger(command.expectedSequence) || command.expectedSequence < 0) {
    throw new PawFeelDispositionServiceError('invalid_command', 'expectedSequence must be non-negative');
  }
  const attempted = parsePawFeelDispositionEvent({
    eventId: command.eventId,
    signalId: command.signalId,
    type: 'blocker_reopened',
    actor: { kind: 'migration', id: 'f313-phase-d-legacy-blocker-recovery' },
    occurredAt: command.occurredAt,
    reopen: command.reopen,
  });
  if (attempted.type !== 'blocker_reopened') {
    throw new PawFeelDispositionServiceError('invalid_command', 'blocker reopen command produced the wrong event');
  }
  if (attempted.reopen.kind !== 'legacy_unbound') {
    throw new PawFeelDispositionServiceError('invalid_command', 'legacy reopen command produced a condition event');
  }
  const expectedEventId = deriveLegacyPawFeelBlockerReopenEventId({
    signalId: attempted.signalId,
    blockingSequence: attempted.reopen.blockingSequence,
    blockerEventDigest: attempted.reopen.blockerEventDigest,
    manifestDigest: attempted.reopen.manifestDigest,
  });
  if (attempted.eventId !== expectedEventId) {
    throw new PawFeelDispositionServiceError('invalid_command', 'blocker reopen event identity is invalid');
  }
  if (!command.productionDataAuthorizationRef?.trim()) {
    throw new PawFeelDispositionServiceError(
      'invalid_command',
      'legacy blocker reopen requires explicit production-data authorization',
    );
  }
  return attempted;
}

export async function planPawFeelConditionBlockerReopen(input: {
  signalId: string;
  currentEvents: readonly PawFeelDispositionEvent[];
  resolver: PawFeelResumeConditionResolver | undefined;
  occurredAt: string;
  mayWrite: boolean;
}): Promise<PawFeelBlockerReconcilePlan> {
  const projection = projectPawFeelDisposition(input.currentEvents);
  const condition = projection.state === 'blocked' ? projection.blocker?.resumeCondition : undefined;
  if (!condition) return { outcome: 'ignored' };
  if (!input.resolver) {
    throw new PawFeelDispositionServiceError(
      'resume_condition_invalid',
      'condition reopen requires the disposition service resume resolver',
    );
  }
  const nowMs = Date.parse(input.occurredAt);
  if (!Number.isFinite(nowMs)) {
    throw new PawFeelDispositionServiceError('resume_condition_invalid', 'blocker reconciliation time is invalid');
  }
  const snapshot = await resolvePawFeelResumeSnapshot(condition.selector, input.resolver).catch((error: unknown) => {
    throw new PawFeelDispositionServiceError(
      'resume_condition_invalid',
      `resume condition is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const currentVersion = digestPawFeelResumeSnapshot(snapshot);
  const due = condition.selector.kind === 'bounded_time' && Date.parse(condition.selector.recheckAt) <= nowMs;
  if (!due && currentVersion === condition.blockedVersion) return { outcome: 'stable' };
  if (!input.mayWrite) return { outcome: 'deferred' };

  const resumeVersion = derivePawFeelResumeVersion(
    snapshot,
    due && condition.selector.kind === 'bounded_time' ? condition.selector.recheckAt : undefined,
  );
  const attempted = parsePawFeelDispositionEvent({
    eventId: derivePawFeelBlockerReopenEventId({
      signalId: input.signalId,
      conditionId: condition.conditionId,
      blockedVersion: condition.blockedVersion,
      resumeVersion,
    }),
    signalId: input.signalId,
    type: 'blocker_reopened',
    actor: { kind: 'automation', id: 'paw-feel-blocker-reconciler' },
    occurredAt: input.occurredAt,
    reopen: {
      kind: 'condition',
      conditionId: condition.conditionId,
      blockedVersion: condition.blockedVersion,
      resumeVersion,
      reason: due ? 'bounded_time_due' : 'condition_changed',
      evidenceRefs: snapshot.evidenceRefs,
    },
  });
  if (attempted.type !== 'blocker_reopened') {
    throw new PawFeelDispositionServiceError('invalid_command', 'condition reopen produced the wrong event');
  }
  return {
    outcome: 'write',
    attempted,
    nextProjection: projectPawFeelBlockerReopen(attempted, input.currentEvents),
  };
}

export function projectPawFeelBlockerReopen(
  attempted: PawFeelBlockerReopenedEvent,
  currentEvents: readonly PawFeelDispositionEvent[],
): PawFeelDispositionProjection {
  if (attempted.reopen.kind === 'legacy_unbound') {
    const blockingEvent = currentEvents[attempted.reopen.blockingSequence - 1];
    if (!blockingEvent || digestLegacyPawFeelBlockerEvent(blockingEvent) !== attempted.reopen.blockerEventDigest) {
      throw new PawFeelDispositionServiceError('invalid_command', 'legacy blocker event digest is invalid');
    }
  }
  return projectPawFeelDisposition([...currentEvents, attempted]);
}
