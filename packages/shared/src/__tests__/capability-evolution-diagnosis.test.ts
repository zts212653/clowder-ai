import { describe, expect, it } from 'vitest';
import {
  type EvolutionProgramEventV1,
  EvolutionProgramReducerError,
  reduceEvolutionProgramEvent,
  replayEvolutionProgramEvents,
} from '../types/capability-evolution.js';
import {
  attributionDiagnosisV1Schema,
  attributionLinkedEventV1Schema,
  observeOrInsufficientEventV1Schema,
} from '../types/capability-evolution-diagnosis.js';

const ref = (ownerStateRef: string) => ({ ownerFeatureId: 'F267', ownerStateRef });

const diagnosis = (overrides: Record<string, unknown> = {}) => ({
  verdict: 'attributed',
  primaryLayer: 'execution',
  assessedLayers: ['execution', 'harness'],
  competingLayers: ['execution'],
  evidenceRefs: [ref('measurement-result:evolve-video-skill:w7')],
  uncertaintyBasis: 'interval',
  comparabilityMode: 'unchanged',
  comparabilityStatus: 'comparable',
  reasonCodes: [],
  ...overrides,
});

describe('F311 attribution diagnosis snapshot', () => {
  it('accepts a coherent attributed diagnosis', () => {
    expect(attributionDiagnosisV1Schema.parse(diagnosis())).toMatchObject({ verdict: 'attributed' });
  });

  it('accepts unresolved / insufficient / incomparable without a primary layer', () => {
    for (const verdict of ['unresolved', 'insufficient', 'incomparable']) {
      const parsed = attributionDiagnosisV1Schema.parse(
        diagnosis({
          verdict,
          primaryLayer: undefined,
          competingLayers: [],
          ...(verdict === 'incomparable' ? { comparabilityStatus: 'incomparable' } : {}),
        }),
      );
      expect(parsed.primaryLayer).toBeUndefined();
    }
  });

  it('requires a primary layer exactly when the verdict is attributed', () => {
    expect(() => attributionDiagnosisV1Schema.parse(diagnosis({ primaryLayer: undefined }))).toThrow();
    expect(() =>
      attributionDiagnosisV1Schema.parse(diagnosis({ verdict: 'unresolved', competingLayers: [] })),
    ).toThrow();
  });

  it('keeps the primary and competing layers inside the assessed set', () => {
    expect(() => attributionDiagnosisV1Schema.parse(diagnosis({ primaryLayer: 'rubric' }))).toThrow();
    expect(() =>
      attributionDiagnosisV1Schema.parse(diagnosis({ competingLayers: ['execution', 'observation'] })),
    ).toThrow();
  });

  it('rejects duplicate layers and duplicate reason codes', () => {
    expect(() =>
      attributionDiagnosisV1Schema.parse(diagnosis({ assessedLayers: ['execution', 'execution'] })),
    ).toThrow();
    expect(() =>
      attributionDiagnosisV1Schema.parse(
        diagnosis({ reasonCodes: ['measurement_insufficient', 'measurement_insufficient'] }),
      ),
    ).toThrow();
  });

  it('requires at least one owner evidence ref and refuses owner payload', () => {
    expect(() => attributionDiagnosisV1Schema.parse(diagnosis({ evidenceRefs: [] }))).toThrow();
    expect(() =>
      attributionDiagnosisV1Schema.parse(diagnosis({ evidenceRefs: [{ ...ref('rubric:x'), rubricText: 'be nice' }] })),
    ).toThrow();
  });

  it('carries the diagnosis on the attribution event and stays payload-free', () => {
    const event = attributionLinkedEventV1Schema.parse({
      type: 'attribution_linked',
      attributionRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-attribution:prog-1:1' },
      disposition: 'intervention_candidate',
      diagnosis: diagnosis(),
    });
    expect(event.diagnosis.assessedLayers).toEqual(['execution', 'harness']);
    expect(() =>
      attributionLinkedEventV1Schema.parse({
        type: 'attribution_linked',
        attributionRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-attribution:prog-1:1' },
        disposition: 'intervention_candidate',
        diagnosis: diagnosis(),
        rubricText: 'smuggled',
      }),
    ).toThrow();
  });

  it('refuses to open Change Review on a diagnosis that is not attributed, and keeps evidence in lineage', () => {
    const owner = (ownerFeatureId: string, ownerStateRef: string) => ({ ownerFeatureId, ownerStateRef });
    const certificates = {
      goal: owner('F311', 'evolution-goal:prog-1'),
      measurement: owner('F267', 'measurement-certificate:prog-1'),
      economic: owner('F311', 'evolution-economics:prog-1'),
    };
    const roles = {
      observer: owner('F267', 'role:observer'),
      domainOwner: owner('F267', 'role:domain-owner'),
      consumer: owner('F267', 'role:consumer'),
      calibrator: owner('F267', 'role:calibrator'),
    };
    const envelope = (expectedSequence: number, event: EvolutionProgramEventV1) => ({
      schemaVersion: 1 as const,
      eventId: `event-${expectedSequence}`,
      programId: 'prog-1',
      expectedSequence,
      clientMessageId: `client-${expectedSequence}`,
      actorRef: 'cat:opus5',
      originRef: 'thread:t1',
      occurredAt: '2026-08-31T22:00:00.000Z',
      event,
    });
    const upTo = [
      envelope(0, {
        type: 'program_created',
        workspaceId: 'user:operator',
        objectRef: owner('F202', 'skill:video-forge'),
        claimRef: owner('F311', 'evolution-claim:prog-1'),
      }),
      envelope(1, {
        type: 'certificates_linked',
        certificates,
        valueOwnerRef: owner('F311', 'value-owner:operator'),
        measurementRoleRefs: roles,
      }),
      envelope(2, {
        type: 'sources_and_triggers_linked',
        sourceRefs: [owner('F299', 'inv:abc')],
        triggerRef: owner('F192', 'eval-trigger:prog-1'),
        namedConsumerRef: owner('F267', 'consumer:prog-1'),
      }),
      envelope(3, {
        type: 'evaluation_triggered',
        triggerReceiptRef: owner('F192', 'eval-trigger-receipt:prog-1'),
        exposureProofRef: owner('F267', 'exposure-proof:prog-1'),
      }),
      envelope(4, {
        type: 'measurement_linked',
        measurementResultRef: owner('F267', 'measurement-result:prog-1:w7'),
        validity: 'valid',
        reasonCodes: [],
        evidenceRefs: [],
        uncertaintyBasis: 'interval',
      }),
    ];
    const attributing = replayEvolutionProgramEvents(upTo);
    expect(attributing?.program.stage).toBe('attributing');

    const incoherent = envelope(5, {
      type: 'attribution_linked',
      attributionRef: owner('F311', 'evolution-attribution:prog-1:1'),
      disposition: 'intervention_candidate',
      diagnosis: attributionDiagnosisV1Schema.parse(
        diagnosis({ verdict: 'unresolved', primaryLayer: undefined, competingLayers: [] }),
      ),
    });
    expect(() => reduceEvolutionProgramEvent(attributing, incoherent)).toThrow(EvolutionProgramReducerError);

    const coherent = envelope(5, {
      type: 'attribution_linked',
      attributionRef: owner('F311', 'evolution-attribution:prog-1:1'),
      disposition: 'intervention_candidate',
      diagnosis: attributionDiagnosisV1Schema.parse(diagnosis()),
    });
    const next = reduceEvolutionProgramEvent(attributing, coherent);
    expect(next.program.stage).toBe('awaiting_intervention');
    expect(next.cycles.at(-1)?.lineageRefIds).toContain('measurement-result:evolve-video-skill:w7');
  });

  it('records why the zero-approval lane was taken', () => {
    const event = observeOrInsufficientEventV1Schema.parse({
      type: 'observe_or_insufficient_recorded',
      result: 'observe',
      autoRecheckRef: { ownerFeatureId: 'F192', ownerStateRef: 'eval-trigger:evolve-video-skill' },
      gateBlockers: [{ code: 'intervention_card_missing', ownerFeatureId: 'F267' }],
    });
    expect(event.gateBlockers).toEqual([{ code: 'intervention_card_missing', ownerFeatureId: 'F267' }]);
    expect(() =>
      observeOrInsufficientEventV1Schema.parse({
        type: 'observe_or_insufficient_recorded',
        result: 'observe',
        autoRecheckRef: { ownerFeatureId: 'F192', ownerStateRef: 'eval-trigger:evolve-video-skill' },
        gateBlockers: [],
      }),
    ).toThrow();
  });
});
