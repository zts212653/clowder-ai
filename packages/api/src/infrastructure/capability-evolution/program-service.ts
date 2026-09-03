import {
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramEventV1,
  evolutionProgramEventEnvelopeV1Schema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  reduceEvolutionProgramEvent,
  replayEvolutionProgramEvents,
} from '@cat-cafe/shared';
import {
  type EvolutionProgramCommandAction,
  EvolutionProgramServiceError,
  type EvolutionProgramServiceResult,
  eventForAction,
  requirePositiveTtl,
} from './program-command-contract.js';
import {
  type EvaluationOwnerResolver,
  landedDecisionProofRef,
  latestAttributionGateView,
  linkEvolutionProgramAttribution,
  linkEvolutionProgramIntervention,
  linkEvolutionProgramMeasurement,
  type ProgramAttributionLinkInput,
  type ProgramEvaluationDependencies,
  type ProgramInterventionLinkInput,
  type ProgramMeasurementLinkInput,
} from './program-evaluation-linker.js';
import {
  buildEvolutionProgramEnvelope,
  type EvolutionProgramAppendOptions,
  type EvolutionProgramAppendResult,
  evolutionEventIdentityDigest,
  type IEvolutionProgramEventLog,
} from './program-event-log.js';
import { forgetEvolutionProgram } from './program-forget.js';
import type { ProgramJoinValidator, ProgramObservationBlocker } from './program-join-validator.js';
import {
  type EvolutionTriggerDispatch,
  linkEvolutionProgramCertificates,
  type ProgramCertificatesLinkInput,
  type ProgramEvaluationTriggerInput,
  triggerEvolutionProgramEvaluation,
} from './program-lifecycle-linker.js';
import {
  type EvolutionProgramObservationResult,
  linkEvolutionProgramObservation,
  type ProgramObservationLinkInput,
} from './program-observation-linker.js';
import type { EvolutionTriggerRegistrationProjection } from './program-observation-projection.js';
import { type EvolutionProgramProjectionV1, projectEvolutionProgram } from './program-projection.js';
import { type CommandBase, type EvolutionProgramServiceOptions, stableId } from './program-service-options.js';

export class EvolutionProgramService {
  private readonly eventLog: IEvolutionProgramEventLog;
  private readonly now: () => string;
  private readonly joinValidator?: Pick<ProgramJoinValidator, 'validate'>;
  private readonly triggerRegistration?: () => EvolutionTriggerRegistrationProjection | undefined;
  private readonly evaluationOwnerResolver?: EvaluationOwnerResolver;
  private readonly dispatchObservationTrigger?: EvolutionProgramServiceOptions['dispatchObservationTrigger'];
  private readonly dispatchEvaluationTrigger?: EvolutionProgramServiceOptions['dispatchEvaluationTrigger'];

  constructor(options: EvolutionProgramServiceOptions) {
    this.eventLog = options.eventLog;
    this.now = options.now ?? (() => new Date().toISOString());
    this.joinValidator = options.joinValidator;
    this.triggerRegistration = options.triggerRegistration;
    this.evaluationOwnerResolver = options.evaluationOwnerResolver;
    this.dispatchObservationTrigger = options.dispatchObservationTrigger;
    this.dispatchEvaluationTrigger = options.dispatchEvaluationTrigger;
  }

  async create(input: {
    workspaceId: string;
    targetRef: OwnerTruthRefV1;
    clientMessageId: string;
    actorRef: string;
    originRef: string;
  }): Promise<EvolutionProgramServiceResult> {
    const programId = stableId('evolution-program', input.workspaceId, input.clientMessageId);
    const targetRef = ownerTruthRefV1Schema.parse(input.targetRef);
    const envelope = this.envelope(programId, 0, input.clientMessageId, input.actorRef, input.originRef, {
      type: 'program_created',
      workspaceId: input.workspaceId,
      objectRef: targetRef,
      claimRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-claim:${programId}` },
    });
    return this.appendValidated(envelope);
  }

  async get(programId: string): Promise<EvolutionProgramProjectionV1> {
    return this.project(await this.eventLog.read(programId));
  }

  async list(workspaceId: string): Promise<EvolutionProgramProjectionV1[]> {
    const programIds = await this.eventLog.listProgramIds(workspaceId);
    const projections = await Promise.all(
      programIds.map(async (programId) => {
        const events = await this.eventLog.read(programId);
        return events.length === 0 ? undefined : this.project(events);
      }),
    );
    return projections.filter(
      (projection): projection is EvolutionProgramProjectionV1 =>
        projection !== undefined && projection.program.workspaceId === workspaceId,
    );
  }

  async command(
    input: CommandBase & { action: EvolutionProgramCommandAction },
  ): Promise<EvolutionProgramServiceResult> {
    if (input.action.type === 'forget') {
      return this.forget({
        programId: input.programId,
        expectedSequence: input.expectedSequence,
        clientMessageId: input.clientMessageId,
        actorRef: input.actorRef,
        originRef: input.originRef,
        action: input.action,
      });
    }
    const occurredAt = this.now();
    const event = eventForAction(input.action, input.actorRef, occurredAt);
    const envelope = this.envelope(
      input.programId,
      input.expectedSequence,
      input.clientMessageId,
      input.actorRef,
      input.originRef,
      event,
      occurredAt,
    );
    const appendOptions: EvolutionProgramAppendOptions =
      input.action.type === 'retention' && input.action.mode === 'forget_after'
        ? { ttlSeconds: requirePositiveTtl(input.action.ttlSeconds) }
        : input.action.type === 'retention' && input.action.mode === 'keep_forever'
          ? { persist: true }
          : {};
    return this.appendValidated(envelope, appendOptions);
  }

  async linkObservation(input: ProgramObservationLinkInput): Promise<EvolutionProgramObservationResult> {
    return linkEvolutionProgramObservation(input, {
      read: (programId) => this.eventLog.read(programId),
      project: (events, blockers) => this.project(events, blockers),
      joinValidator: this.joinValidator,
      triggerRegistration: this.triggerRegistration,
      envelope: (command, event) =>
        this.envelope(
          command.programId,
          command.expectedSequence,
          command.clientMessageId,
          command.actorRef,
          command.originRef,
          event,
        ),
      append: (envelope) => this.appendValidated(envelope),
      dispatch: this.dispatchObservationTrigger,
    });
  }

  /**
   * F311 Phase 3 ingress. The Program — not the caller — runs the measurement join, the four-layer
   * diagnosis and the intervention gate, then appends the canonical event. Callers pass identities
   * only; every owner verdict is resolved from F267, and a missing owner contract fails closed.
   */
  /** Constitutes a Program: the transition out of `constituting` that had no public producer. */
  async linkCertificates(input: ProgramCertificatesLinkInput): Promise<EvolutionProgramServiceResult> {
    return linkEvolutionProgramCertificates(input, this.evaluationDependencies());
  }

  /** Opens an evaluation round, but only if F192's dispatch says one opened. */
  async triggerEvaluation(input: ProgramEvaluationTriggerInput): Promise<EvolutionProgramServiceResult> {
    return triggerEvolutionProgramEvaluation(input, {
      ...this.evaluationDependencies(),
      ...(this.dispatchEvaluationTrigger === undefined
        ? {}
        : { dispatchEvaluationTrigger: this.dispatchEvaluationTrigger }),
    });
  }

  async linkMeasurement(input: ProgramMeasurementLinkInput): Promise<EvolutionProgramServiceResult> {
    return linkEvolutionProgramMeasurement(input, this.evaluationDependencies());
  }

  async linkAttribution(input: ProgramAttributionLinkInput): Promise<EvolutionProgramServiceResult> {
    return linkEvolutionProgramAttribution(input, this.evaluationDependencies());
  }

  /**
   * The only door into Change Review. The attribution is read from the Program's own stream, so a
   * caller cannot declare itself actionable; a blocked gate appends the zero-approval event instead.
   */
  async linkIntervention(
    input: Omit<ProgramInterventionLinkInput, 'attribution' | 'decisionProofRef'>,
  ): Promise<EvolutionProgramServiceResult> {
    const events = await this.eventLog.read(input.programId);
    const attribution = latestAttributionGateView(events);
    if (!attribution) {
      throw new EvolutionProgramServiceError(
        'invalid_command',
        'the intervention gate needs a durable attribution on this Cycle',
      );
    }
    // The card is resolved from the proof THIS round landed on, read out of the Program's own
    // lineage. A caller cannot point the gate at some other round's evidence.
    const decisionProofRef = landedDecisionProofRef(events);
    if (!decisionProofRef) {
      throw new EvolutionProgramServiceError(
        'invalid_command',
        'this Cycle has no landed decision proof, so there is no owner card to gate on',
      );
    }
    return linkEvolutionProgramIntervention({ ...input, attribution, decisionProofRef }, this.evaluationDependencies());
  }

  private evaluationDependencies(): ProgramEvaluationDependencies {
    return {
      read: (programId) => this.eventLog.read(programId),
      project: (events) => this.project(events),
      envelope: (command, event, commandDigest) =>
        this.envelope(
          command.programId,
          command.expectedSequence,
          command.clientMessageId,
          command.actorRef,
          command.originRef,
          event,
          this.now(),
          commandDigest,
        ),
      append: (envelope) => this.appendValidated(envelope),
      ...(this.evaluationOwnerResolver === undefined ? {} : { ownerResolver: this.evaluationOwnerResolver }),
    };
  }

  private envelope(
    programId: string,
    expectedSequence: number,
    clientMessageId: string,
    actorRef: string,
    originRef: string,
    event: EvolutionProgramEventV1,
    occurredAt = this.now(),
    commandDigest?: string,
  ): EvolutionProgramEventEnvelopeV1 {
    return buildEvolutionProgramEnvelope({
      programId,
      expectedSequence,
      clientMessageId,
      actorRef,
      originRef,
      event,
      occurredAt,
      eventId: stableId('evolution-event', programId, clientMessageId, event.type),
      ...(commandDigest === undefined ? {} : { commandDigest }),
    });
  }

  private async appendValidated(
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

  private async forget(input: CommandBase & { action: Extract<EvolutionProgramCommandAction, { type: 'forget' }> }) {
    return forgetEvolutionProgram(input, {
      eventLog: this.eventLog,
      now: this.now,
      project: (events) => this.project(events),
      envelope: (programId, expectedSequence, clientMessageId, actorRef, originRef, event, occurredAt) =>
        this.envelope(programId, expectedSequence, clientMessageId, actorRef, originRef, event, occurredAt),
      command: (command) => this.command(command as CommandBase & { action: EvolutionProgramCommandAction }),
      resolveAppend: (append, previousEvents, appendedEvents) =>
        this.resolveAppend(append, previousEvents, appendedEvents),
      stableId,
    });
  }

  private async resolveAppend(
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
        projection: await this.get(appendedEvents[0].programId),
      };
    }
    if (append.outcome === 'duplicate') {
      return { outcome: 'duplicate', projection: await this.get(appendedEvents[0].programId) };
    }
    return { outcome: 'appended', projection: this.project([...previousEvents, ...appendedEvents]) };
  }

  private project(
    events: readonly EvolutionProgramEventEnvelopeV1[],
    observationBlockers?: readonly ProgramObservationBlocker[],
  ): EvolutionProgramProjectionV1 {
    const projection = projectEvolutionProgram(events, {
      ...(this.triggerRegistration ? { triggerRegistration: this.triggerRegistration() } : {}),
      ...(observationBlockers ? { observationBlockers } : {}),
    });
    if (!projection) throw new EvolutionProgramServiceError('program_not_found', 'Evolution Program not found');
    return projection;
  }
}
