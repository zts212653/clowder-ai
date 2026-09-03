import {
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramEventV1,
  ownerTruthRefV1Schema,
  reduceEvolutionProgramEvent,
  replayEvolutionProgramEvents,
} from '@cat-cafe/shared';
import {
  type EvolutionProgramCommandAction,
  EvolutionProgramServiceError,
  type EvolutionProgramServiceResult,
  requirePositiveTtl,
} from './program-command-contract.js';
import { type EvolutionProgramAppendResult, evolutionEventIdentityDigest } from './program-event-log.js';
import type { EvolutionProgramProjectionV1 } from './program-projection.js';

/**
 * "Forget an active Program" is the one operation that must withdraw and set retention atomically:
 * any interleaving that leaves the Program active WITH a TTL would silently schedule the deletion
 * of user-visible state (LL-048). It lives on its own so that invariant is readable in one screen.
 */

export interface ForgetCommandInput {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  actorRef: string;
  originRef: string;
  action: Extract<EvolutionProgramCommandAction, { type: 'forget' }>;
}

export interface ProgramForgetDependencies {
  eventLog: {
    read(programId: string): Promise<EvolutionProgramEventEnvelopeV1[]>;
    appendActiveForget(
      withdrawal: EvolutionProgramEventEnvelopeV1,
      retention: EvolutionProgramEventEnvelopeV1,
      ttlSeconds: number,
    ): Promise<EvolutionProgramAppendResult>;
  };
  now(): string;
  project(events: readonly EvolutionProgramEventEnvelopeV1[]): EvolutionProgramProjectionV1;
  envelope(
    programId: string,
    expectedSequence: number,
    clientMessageId: string,
    actorRef: string,
    originRef: string,
    event: EvolutionProgramEventV1,
    occurredAt?: string,
  ): EvolutionProgramEventEnvelopeV1;
  command(input: ForgetCommandInput | Record<string, unknown>): Promise<EvolutionProgramServiceResult>;
  resolveAppend(
    append: EvolutionProgramAppendResult,
    previousEvents: EvolutionProgramEventEnvelopeV1[],
    appendedEvents: EvolutionProgramEventEnvelopeV1[],
  ): Promise<EvolutionProgramServiceResult>;
  stableId(prefix: string, ...parts: string[]): string;
}

export async function forgetEvolutionProgram(
  input: ForgetCommandInput,
  deps: ProgramForgetDependencies,
): Promise<EvolutionProgramServiceResult> {
  const ttlSeconds = requirePositiveTtl(input.action.ttlSeconds);
  const events = await deps.eventLog.read(input.programId);
  const projection = deps.project(events);
  const occurredAt = deps.now();
  const withdrawal = deps.envelope(
    input.programId,
    input.expectedSequence,
    input.clientMessageId,
    input.actorRef,
    input.originRef,
    { type: 'program_withdrawn', decisionRef: ownerTruthRefV1Schema.parse(input.action.decisionRef) },
    occurredAt,
  );
  const retentionClientMessageId = deps.stableId('forget-retention', input.clientMessageId);
  const retention = deps.envelope(
    input.programId,
    input.expectedSequence + 1,
    retentionClientMessageId,
    input.actorRef,
    input.originRef,
    {
      type: 'retention_opted_in',
      retention: { mode: 'forget_after', optedInBy: input.actorRef, optedInAt: occurredAt, ttlSeconds },
      retentionActionRef: ownerTruthRefV1Schema.parse(input.action.retentionActionRef),
    },
    occurredAt,
  );
  const existingPair = events.filter(
    (candidate) =>
      candidate.clientMessageId === withdrawal.clientMessageId ||
      candidate.clientMessageId === retention.clientMessageId ||
      candidate.eventId === withdrawal.eventId ||
      candidate.eventId === retention.eventId,
  );
  const originalCommand = events.find((candidate) => candidate.clientMessageId === input.clientMessageId);
  if (projection.program.lifecycle === 'terminal' && originalCommand?.event.type !== 'program_withdrawn') {
    return deps.command({
      ...input,
      action: {
        type: 'retention',
        mode: 'forget_after',
        ttlSeconds,
        retentionActionRef: input.action.retentionActionRef,
      },
    });
  }
  if (existingPair.length > 0) {
    const exact = [withdrawal, retention].every((candidate) =>
      events.some((existing) => evolutionEventIdentityDigest(existing) === evolutionEventIdentityDigest(candidate)),
    );
    if (exact) return { outcome: 'duplicate' as const, projection };
    throw new EvolutionProgramServiceError('idempotency_collision', 'forget identity was reused for different content');
  }
  if (input.expectedSequence !== projection.program.sequence) {
    return {
      outcome: 'conflict',
      actualSequence: projection.program.sequence,
      projection,
    };
  }
  if (projection.program.lifecycle === 'terminal') {
    throw new EvolutionProgramServiceError(
      'idempotency_collision',
      'terminal forget retry is missing its retention pair',
    );
  }

  const state = replayEvolutionProgramEvents(events);
  const withdrawn = reduceEvolutionProgramEvent(state, withdrawal);
  reduceEvolutionProgramEvent(withdrawn, retention);
  const append = await deps.eventLog.appendActiveForget(withdrawal, retention, ttlSeconds);
  return deps.resolveAppend(append, events, [withdrawal, retention]);
}
