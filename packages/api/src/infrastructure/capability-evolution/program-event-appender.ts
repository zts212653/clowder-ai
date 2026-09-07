import {
  type EvolutionProgramEventEnvelopeV1,
  reduceEvolutionProgramEvent,
  replayEvolutionProgramEvents,
} from '@cat-cafe/shared';
import { EvolutionProgramServiceError, type EvolutionProgramServiceResult } from './program-command-contract.js';
import {
  type EvolutionProgramAppendOptions,
  type EvolutionProgramAppendResult,
  evolutionEventIdentityDigest,
  type IEvolutionProgramEventLog,
} from './program-event-log.js';
import type { EvolutionProgramProjectionV1 } from './program-projection.js';

export class EvolutionProgramEventAppender {
  constructor(
    private readonly eventLog: IEvolutionProgramEventLog,
    private readonly project: (events: readonly EvolutionProgramEventEnvelopeV1[]) => EvolutionProgramProjectionV1,
  ) {}

  async appendValidated(
    envelope: EvolutionProgramEventEnvelopeV1,
    options: EvolutionProgramAppendOptions = {},
  ): Promise<EvolutionProgramServiceResult> {
    const events = await this.eventLog.read(envelope.programId);
    const existing = events.find(
      (candidate) => candidate.eventId === envelope.eventId || candidate.clientMessageId === envelope.clientMessageId,
    );
    if (existing) {
      if (
        existing.eventId === envelope.eventId &&
        existing.clientMessageId === envelope.clientMessageId &&
        evolutionEventIdentityDigest(existing) === evolutionEventIdentityDigest(envelope)
      ) {
        return { outcome: 'duplicate', projection: this.project(events) };
      }
      throw new EvolutionProgramServiceError(
        'idempotency_collision',
        'event identity was reused for different content',
      );
    }

    if (events.length > 0) {
      const projection = this.project(events);
      if (envelope.expectedSequence !== projection.program.sequence) {
        return {
          outcome: 'conflict',
          actualSequence: projection.program.sequence,
          projection,
        };
      }
    }

    const state = replayEvolutionProgramEvents(events);
    reduceEvolutionProgramEvent(state, envelope);
    const append = await this.eventLog.append(envelope, options);
    return this.resolveAppend(append, events, [envelope]);
  }

  async resolveAppend(
    append: EvolutionProgramAppendResult,
    previousEvents: EvolutionProgramEventEnvelopeV1[],
    appendedEvents: EvolutionProgramEventEnvelopeV1[],
  ): Promise<EvolutionProgramServiceResult> {
    if (append.outcome === 'idempotency_collision') {
      throw new EvolutionProgramServiceError(
        'idempotency_collision',
        'event identity was reused for different content',
      );
    }
    if (append.outcome === 'conflict') {
      return {
        outcome: 'conflict',
        actualSequence: append.actualSequence,
        projection: this.project(await this.eventLog.read(appendedEvents[0].programId)),
      };
    }
    if (append.outcome === 'duplicate') {
      return {
        outcome: 'duplicate',
        projection: this.project(await this.eventLog.read(appendedEvents[0].programId)),
      };
    }
    return { outcome: 'appended', projection: this.project([...previousEvents, ...appendedEvents]) };
  }
}
