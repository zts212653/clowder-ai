/**
 * Shared fixtures for the capability-evolution contract suite.
 *
 * Building a Program that has legitimately reached a given stage takes a whole event stream, so
 * the builders live here and the suite next door stays a list of invariants rather than a list of
 * setup.
 */

import { expect } from 'vitest';
import {
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramEventV1,
  EvolutionProgramReducerError,
  evolutionProgramEventEnvelopeV1Schema,
  evolutionProgramStateV1Schema,
  evolutionProgramV1Schema,
  ownerTruthRefV1Schema,
  reduceEvolutionProgramEvent,
  replayEvolutionProgramEvents,
} from '../types/capability-evolution.js';

export const ref = (ownerStateRef: string, version?: string) => ({
  ownerFeatureId: 'F267',
  ownerStateRef,
  ...(version === undefined ? {} : { version }),
});
export const assetRef = (ownerStateRef: string, assetKind: string, assetId: string, version: string) => ({
  ownerFeatureId: 'F267',
  ownerStateRef,
  version,
  assetKind,
  assetId,
});

export function envelope(
  expectedSequence: number,
  event: EvolutionProgramEventV1,
  suffix = String(expectedSequence),
): EvolutionProgramEventEnvelopeV1 {
  return {
    schemaVersion: 1,
    eventId: `event-${suffix}`,
    programId: 'program-1',
    expectedSequence,
    clientMessageId: `message-${suffix}`,
    actorRef: 'cat:codex-sol',
    originRef: 'thread:thread_mtgrlaojwbzwmm6u',
    occurredAt: `2026-08-31T05:${String(expectedSequence).padStart(2, '0')}:00.000Z`,
    event,
  };
}

export function activeCycleEvents(): EvolutionProgramEventEnvelopeV1[] {
  return [
    envelope(0, {
      type: 'program_created',
      workspaceId: 'workspace-1',
      objectRef: ref('skill:video-forge', 'v1'),
      claimRef: ref('claim:reduce-decorative-noise', 'v1'),
    }),
    envelope(1, {
      type: 'certificates_linked',
      certificates: {
        goal: ref('certificate:goal-1', 'v1'),
        measurement: ref('certificate:measurement-1', 'v1'),
        economic: ref('certificate:economic-1', 'v1'),
      },
      valueOwnerRef: ref('owner:operator'),
      measurementRoleRefs: {
        observer: ref('role:observer'),
        domainOwner: ref('role:domain-owner'),
        consumer: ref('role:consumer'),
        calibrator: ref('role:calibrator'),
        overlapJustification: 'The observer and calibrator are independently accountable.',
      },
    }),
    envelope(2, {
      type: 'sources_and_triggers_linked',
      sourceRefs: [ref('inv:0001788152099926')],
      triggerRef: ref('trigger:f192:daily'),
      namedConsumerRef: ref('consumer:f311-program-1'),
    }),
    envelope(3, {
      type: 'evaluation_triggered',
      triggerReceiptRef: ref('trigger-receipt:1'),
      exposureProofRef: ref('exposure-proof:1'),
    }),
    envelope(4, {
      type: 'measurement_linked',
      measurementResultRef: ref('measurement-result:1'),
      validity: 'valid',
      reasonCodes: [],
      evidenceRefs: [],
      uncertaintyBasis: 'interval',
    }),
    envelope(5, {
      type: 'attribution_linked',
      attributionRef: ref('attribution:1'),
      disposition: 'intervention_candidate',
      diagnosis: {
        verdict: 'attributed',
        primaryLayer: 'execution',
        assessedLayers: ['execution'],
        competingLayers: ['execution'],
        evidenceRefs: [ref('measurement-result:1')],
        uncertaintyBasis: 'interval',
        comparabilityMode: 'unchanged',
        comparabilityStatus: 'comparable',
        reasonCodes: [],
      },
    }),
    envelope(6, {
      type: 'intervention_linked',
      interventionCardRef: ref('intervention-card:1'),
      interventionLayerRef: ref('intervention-layer:harness'),
      gateReceiptRef: ref('intervention-gate:1'),
    }),
  ];
}

export function terminalEvents(): EvolutionProgramEventEnvelopeV1[] {
  return [
    ...activeCycleEvents(),
    envelope(7, {
      type: 'approval_linked',
      approvalRef: ref('approval:1'),
      targetVersionRef: assetRef('asset-version:video-forge-v2', 'skill', 'video-forge', 'v2'),
    }),
    envelope(8, {
      type: 'mutation_linked',
      mutationReceiptRef: ref('mutation:1'),
      assetVersionRef: assetRef('asset-version:video-forge-v2', 'skill', 'video-forge', 'v2'),
    }),
    envelope(9, {
      type: 'outcome_linked',
      outcomeRef: ref('outcome:1'),
      loadedRuntimeRef: ref('runtime:loaded-v2'),
      freshnessProofRef: ref('freshness:holdout-1'),
    }),
    envelope(10, {
      type: 'decision_recorded',
      decision: 'keep',
      decisionRef: ref('decision:keep-1'),
    }),
  ];
}

export function decidingEvents(): EvolutionProgramEventEnvelopeV1[] {
  return terminalEvents().slice(0, -1);
}

export function rotatedCycle(decision: 'tune' | 'rollback' = 'tune') {
  return reduceEvolutionProgramEvent(
    replayEvolutionProgramEvents(decidingEvents()),
    envelope(10, { type: 'decision_recorded', decision, decisionRef: ref(`decision:${decision}-1`) }),
  );
}

export function expectReducerCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('expected reducer to reject the event');
  } catch (error) {
    expect(error).toBeInstanceOf(EvolutionProgramReducerError);
    expect((error as EvolutionProgramReducerError).code).toBe(code);
  }
}
