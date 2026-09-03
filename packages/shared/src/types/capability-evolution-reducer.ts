import {
  type EvolutionCycleV1,
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramEventV1,
  type EvolutionProgramStage,
  type EvolutionProgramStateV1,
  type EvolutionProgramV1,
  evolutionProgramEventEnvelopeV1Schema,
  evolutionProgramStateV1Schema,
} from './capability-evolution.js';
import type { OwnerTruthRefV1 } from './capability-evolution-refs.js';

/**
 * The Program's pure reducer, kept apart from the schemas it folds over.
 *
 * Every state transition a Program can make is here and nowhere else, so "can this event happen from
 * this stage" is one file to read. The schemas next door say what an event looks like; this says what
 * it means.
 */

export type EvolutionProgramReducerErrorCode =
  | 'event_before_creation'
  | 'program_already_exists'
  | 'program_mismatch'
  | 'sequence_conflict'
  | 'program_terminal'
  | 'invalid_transition';
export class EvolutionProgramReducerError extends Error {
  constructor(
    readonly code: EvolutionProgramReducerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvolutionProgramReducerError';
  }
}
const reject = (code: EvolutionProgramReducerErrorCode, message: string): never => {
  throw new EvolutionProgramReducerError(code, message);
};
const refs = (...values: OwnerTruthRefV1[]) => values.map((value) => value.ownerStateRef);

interface ReducerContext {
  program: EvolutionProgramV1;
  cycles: EvolutionCycleV1[];
  cycle: EvolutionCycleV1;
  occurredAt: string;
}

function addRefs(ctx: ReducerContext, ...values: OwnerTruthRefV1[]): void {
  ctx.cycle.lineageRefIds = [...new Set([...ctx.cycle.lineageRefIds, ...refs(...values)])];
}

function setStage(ctx: ReducerContext, next: EvolutionProgramStage): void {
  ctx.program.stage = next;
  ctx.cycle.stage = next;
}

function requireActiveAt(ctx: ReducerContext, expected: EvolutionProgramStage): void {
  if (ctx.program.lifecycle !== 'active' || ctx.program.stage !== expected)
    reject('invalid_transition', `expected active/${expected}`);
}

function applyLifecycleEvent(ctx: ReducerContext, event: EvolutionProgramEventV1): boolean {
  switch (event.type) {
    case 'program_paused':
      if (ctx.program.lifecycle !== 'active') reject('invalid_transition', 'only active Programs can pause');
      ctx.program.lifecycle = 'paused';
      addRefs(ctx, event.reasonRef);
      return true;
    case 'program_resumed':
      if (ctx.program.lifecycle !== 'paused') reject('invalid_transition', 'only paused Programs can resume');
      ctx.program.lifecycle = 'active';
      addRefs(ctx, event.resumeRef);
      return true;
    case 'expert_required':
      if (ctx.program.lifecycle !== 'active')
        reject('invalid_transition', 'only active Programs can require an expert');
      ctx.program.lifecycle = 'needs_expert';
      addRefs(ctx, event.blockerRef);
      return true;
    case 'expert_bound':
      if (ctx.program.lifecycle !== 'needs_expert')
        reject('invalid_transition', 'only needs_expert Programs can bind an expert');
      ctx.program.lifecycle = 'active';
      addRefs(ctx, event.roleOwnerRef);
      return true;
    case 'program_withdrawn':
      addRefs(ctx, event.decisionRef);
      ctx.program.lifecycle = 'terminal';
      ctx.program.terminalDisposition = 'withdrawn';
      ctx.cycle.closedAt = ctx.occurredAt;
      return true;
    case 'retention_opted_in':
      if (ctx.program.lifecycle !== 'terminal') reject('invalid_transition', 'retention requires a terminal Program');
      ctx.program.retention = event.retention;
      addRefs(ctx, event.retentionActionRef);
      return true;
    default:
      return false;
  }
}

function applyEvidenceEvent(ctx: ReducerContext, event: EvolutionProgramEventV1): boolean {
  switch (event.type) {
    case 'certificates_linked':
      requireActiveAt(ctx, 'constituting');
      ctx.program.certificates = event.certificates;
      ctx.program.valueOwnerRef = event.valueOwnerRef;
      ctx.program.measurementRoleRefs = event.measurementRoleRefs;
      addRefs(
        ctx,
        event.certificates.goal,
        event.certificates.measurement,
        event.certificates.economic,
        event.valueOwnerRef,
      );
      setStage(ctx, 'instrumenting');
      return true;
    case 'sources_and_triggers_linked':
      requireActiveAt(ctx, 'instrumenting');
      addRefs(ctx, ...event.sourceRefs, event.triggerRef, event.namedConsumerRef);
      setStage(ctx, 'observing');
      return true;
    case 'observation_setup_linked': {
      requireActiveAt(ctx, 'instrumenting');
      const s = event.setup;
      addRefs(
        ctx,
        s.trajectory.ref,
        ...s.sourceBindings.flatMap((b) => [b.ownerSurfaceRef, b.namedConsumerRef, b.instrumentationRef]),
        ...Object.values(s.evidenceProofRefs),
        s.triggerRef,
      );
      setStage(ctx, 'observing');
      return true;
    }
    case 'evaluation_triggered':
      requireActiveAt(ctx, 'observing');
      addRefs(ctx, event.triggerReceiptRef, event.exposureProofRef);
      setStage(ctx, 'evaluating');
      return true;
    case 'measurement_linked':
      requireActiveAt(ctx, 'evaluating');
      addRefs(ctx, event.measurementResultRef, ...event.evidenceRefs);
      setStage(ctx, event.validity === 'valid' ? 'attributing' : 'observing');
      return true;
    case 'attribution_linked':
      requireActiveAt(ctx, 'attributing');
      addRefs(ctx, event.attributionRef, ...event.diagnosis.evidenceRefs);
      if ((event.diagnosis.verdict === 'attributed') !== (event.disposition === 'intervention_candidate'))
        reject('invalid_transition', 'only an attributed diagnosis may become an intervention candidate');
      setStage(ctx, event.disposition === 'intervention_candidate' ? 'awaiting_intervention' : 'deciding');
      return true;
    default:
      return false;
  }
}

function applyChangeEvent(ctx: ReducerContext, event: EvolutionProgramEventV1): boolean {
  switch (event.type) {
    case 'intervention_linked':
      requireActiveAt(ctx, 'awaiting_intervention');
      if (ctx.cycle.interventionLayerRef !== undefined)
        reject('invalid_transition', 'a Cycle has only one intervention layer');
      ctx.cycle.interventionLayerRef = event.interventionLayerRef;
      addRefs(ctx, event.interventionCardRef, event.interventionLayerRef, event.gateReceiptRef);
      setStage(ctx, 'awaiting_approval');
      return true;
    case 'observe_or_insufficient_recorded':
      requireActiveAt(ctx, 'awaiting_intervention');
      addRefs(ctx, event.autoRecheckRef);
      setStage(ctx, 'observing');
      return true;
    case 'approval_linked':
      requireActiveAt(ctx, 'awaiting_approval');
      addRefs(ctx, event.approvalRef, event.targetVersionRef);
      setStage(ctx, 'writing_back');
      return true;
    case 'approval_rejected_or_superseded':
      requireActiveAt(ctx, 'awaiting_approval');
      addRefs(ctx, event.decisionRef);
      setStage(ctx, event.result === 'rejected' ? 'deciding' : 'awaiting_approval');
      return true;
    case 'mutation_linked':
      requireActiveAt(ctx, 'writing_back');
      addRefs(ctx, event.mutationReceiptRef, event.assetVersionRef);
      ctx.program.currentAssetVersionRefs = [
        ...ctx.program.currentAssetVersionRefs.filter(
          (value) =>
            value.assetKind !== event.assetVersionRef.assetKind || value.assetId !== event.assetVersionRef.assetId,
        ),
        event.assetVersionRef,
      ];
      setStage(ctx, 'revalidating');
      return true;
    case 'outcome_linked':
      requireActiveAt(ctx, 'revalidating');
      addRefs(ctx, event.outcomeRef, event.loadedRuntimeRef, event.freshnessProofRef);
      setStage(ctx, 'deciding');
      return true;
    case 'decision_recorded':
      requireActiveAt(ctx, 'deciding');
      addRefs(ctx, event.decisionRef);
      ctx.cycle.decision = event.decision;
      ctx.cycle.closedAt = ctx.occurredAt;
      if (event.decision === 'tune' || event.decision === 'rollback') {
        ctx.program.cycle += 1;
        ctx.program.stage = 'instrumenting';
        ctx.cycle = {
          programId: ctx.program.programId,
          cycle: ctx.program.cycle,
          stage: 'instrumenting',
          lineageRefIds: [],
          openedAt: ctx.occurredAt,
        };
        ctx.cycles.push(ctx.cycle);
      } else {
        ctx.program.lifecycle = 'terminal';
        ctx.program.terminalDisposition = event.decision === 'keep' ? 'kept' : event.decision;
      }
      return true;
    default:
      return false;
  }
}

export function reduceEvolutionProgramEvent(
  rawState: EvolutionProgramStateV1 | null | undefined,
  rawEnvelope: EvolutionProgramEventEnvelopeV1,
): EvolutionProgramStateV1 {
  const envelope = evolutionProgramEventEnvelopeV1Schema.parse(rawEnvelope);
  if (rawState == null) {
    const creation = envelope.event;
    if (creation.type === 'program_created') {
      if (envelope.expectedSequence !== 0) reject('sequence_conflict', 'Program creation expects sequence zero');
      const program: EvolutionProgramV1 = {
        schemaVersion: 1,
        programId: envelope.programId,
        workspaceId: creation.workspaceId,
        objectRef: creation.objectRef,
        claimRef: creation.claimRef,
        certificates: {},
        measurementRoleRefs: {},
        lifecycle: 'active',
        stage: 'constituting',
        cycle: 1,
        sequence: 1,
        currentAssetVersionRefs: [],
        createdAt: envelope.occurredAt,
        updatedAt: envelope.occurredAt,
      };
      return evolutionProgramStateV1Schema.parse({
        program,
        cycles: [
          {
            programId: envelope.programId,
            cycle: 1,
            stage: 'constituting',
            lineageRefIds: refs(creation.objectRef, creation.claimRef),
            openedAt: envelope.occurredAt,
          },
        ],
      });
    }
    return reject('event_before_creation', 'the first event must create the Program');
  }
  const current = evolutionProgramStateV1Schema.parse(rawState);
  if (envelope.event.type === 'program_created') reject('program_already_exists', 'a Program has already been created');
  if (envelope.programId !== current.program.programId) reject('program_mismatch', 'event belongs to another Program');
  if (envelope.expectedSequence !== current.program.sequence)
    reject('sequence_conflict', 'event sequence does not follow the projection');
  if (current.program.lifecycle === 'terminal' && envelope.event.type !== 'retention_opted_in')
    reject('program_terminal', 'terminal Programs cannot accept business events');

  const cycles = current.cycles.map((cycle) => ({ ...cycle, lineageRefIds: [...cycle.lineageRefIds] }));
  const cycle = cycles.at(-1);
  if (cycle === undefined) return reject('invalid_transition', 'Program projection has no current Cycle');
  const ctx: ReducerContext = {
    program: { ...current.program, sequence: current.program.sequence + 1, updatedAt: envelope.occurredAt },
    cycles,
    cycle,
    occurredAt: envelope.occurredAt,
  };
  const event = envelope.event;
  if (!applyLifecycleEvent(ctx, event) && !applyEvidenceEvent(ctx, event) && !applyChangeEvent(ctx, event)) {
    return reject('invalid_transition', `event ${event.type} is not applicable`);
  }
  return evolutionProgramStateV1Schema.parse({ program: ctx.program, cycles: ctx.cycles });
}

/** Canonical replay owns identity de-duplication; the single-step reducer has no event-id history. */
export function replayEvolutionProgramEvents(
  events: readonly EvolutionProgramEventEnvelopeV1[],
): EvolutionProgramStateV1 | undefined {
  const eventIds = new Set<string>();
  const clientMessageIds = new Set<string>();
  let state: EvolutionProgramStateV1 | undefined;
  for (const rawEvent of events) {
    const event = evolutionProgramEventEnvelopeV1Schema.parse(rawEvent);
    if (eventIds.has(event.eventId) || clientMessageIds.has(event.clientMessageId))
      reject('invalid_transition', 'canonical event streams cannot contain duplicate identities');
    eventIds.add(event.eventId);
    clientMessageIds.add(event.clientMessageId);
    state = reduceEvolutionProgramEvent(state, event);
  }
  return state;
}
