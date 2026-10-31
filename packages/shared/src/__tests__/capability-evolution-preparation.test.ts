import { describe, expect, it } from 'vitest';
import {
  type EvolutionProgramEventEnvelopeV1,
  evolutionPreparationSubmissionV1Schema,
  evolutionProgramEventEnvelopeV1Schema,
  reduceEvolutionProgramEvent,
} from '../types/capability-evolution.js';

const PROGRAM_ID = 'evolution-program:0123456789abcdef0123456789abcdef';
const revision = (character: string) => `sha256:${character.repeat(64)}`;
const ref = (kind: string, version?: string) => ({
  ownerFeatureId: 'F311',
  ownerStateRef: `${kind}:fixture`,
  ...(version ? { version } : {}),
});
const submissionRef = (section: string, version: string) => ({
  ownerFeatureId: 'F311',
  ownerStateRef: `preparation-submission:${PROGRAM_ID}:${section}`,
  version,
});
const modifiability = {
  state: 'not_modifiable_this_round' as const,
  reason: 'The production environment is fixed for this comparison.',
  basisRefs: [ref('source', 'v1')],
};

const criteria = [
  'delivery_effectiveness',
  'professional_judgment',
  'necessary_escalation',
  'autonomous_closure',
  'human_burden',
  'state_integrity',
].map((criterionId, index) => ({
  criterionId,
  label: `Criterion ${index + 1}`,
  utilityClaim: 'A better result means the PM advances the project without hiding necessary human decisions.',
  observationUnit: 'One project decision or advancement opportunity, including silence.',
  estimator: 'Report numerator, denominator, exclusions, unknowns, and raw counts separately.',
  counterexample: 'Fewer messages while a required escalation is silently missed.',
  gtDomain:
    index === 5 ? ('verifiable' as const) : index === 1 ? ('semi_verifiable' as const) : ('open_value' as const),
  judge: index === 5 ? ('verifier' as const) : index === 1 ? ('calibrated_judge' as const) : ('value_owner' as const),
  payer: {
    kind: index === 5 ? ('engineering_maintenance' as const) : ('human_attention' as const),
    detail: 'The accountable owner funds the bounded review or maintenance work.',
  },
  gtSourceKeys: ['business-facts', 'domain-precedents', 'real-use-outcomes'],
  validityBounds: ['Project scope, policy, permissions, and judge version must remain applicable.'],
  unknowns: ['No customer baseline or threshold is connected.'],
  nextAction: 'Calibrate on complete cases before choosing an intervention.',
}));

const successSubmission = {
  schemaVersion: 1 as const,
  programId: PROGRAM_ID,
  section: 'success_contract' as const,
  title: 'PM effectiveness yardstick draft',
  authorCatId: 'codex-sol',
  revision: revision('b'),
  dependsOn: [submissionRef('object_map', revision('a'))],
  body: {
    kind: 'success_contract' as const,
    summary: 'Keep project outcome, necessary escalation, autonomy, burden, and truthfulness separate.',
    criteria,
    unknowns: ['Value owner, calibrator, baseline, and acceptable loss remain unknown.'],
    nextAction: 'Connect the three GT source classes and run blind calibration.',
  },
};

describe('F311 production preparation contract', () => {
  it('accepts six multidimensional criteria with explicit E0 GT, judge, payer and source links', () => {
    const parsed = evolutionPreparationSubmissionV1Schema.parse(successSubmission);
    expect(parsed.body.kind).toBe('success_contract');
    if (parsed.body.kind !== 'success_contract') throw new Error('wrong body');
    expect(parsed.body.criteria).toHaveLength(6);
    expect(parsed.body.criteria.map((criterion) => criterion.gtDomain)).toContain('open_value');
    expect(parsed.body.criteria.every((criterion) => criterion.payer.detail.length > 0)).toBe(true);
  });

  it('keeps collection and validity independent for all three GT source classes', () => {
    const measurement = {
      schemaVersion: 1,
      programId: PROGRAM_ID,
      section: 'measurement_plan',
      title: 'GT and experiment preparation',
      authorCatId: 'codex-sol',
      revision: revision('c'),
      dependsOn: [submissionRef('object_map', revision('a')), submissionRef('success_contract', revision('b'))],
      body: {
        kind: 'measurement_plan',
        summary: 'Collection success is not validity.',
        gtSources: [
          {
            sourceKey: 'business-facts',
            category: 'business_fact',
            label: 'Original commitments, approvals and terminal state',
            collection: { state: 'not_connected', method: 'Connect owner records by project slice and rule version.' },
            validity: { state: 'unknown', detail: 'No owner records have been inspected.' },
            missingOrDisputed: ['Failure and duplicate receipt coverage is unknown.'],
            cost: {
              payer: 'Product and engineering owners',
              detail: 'Integration and business verification cost unknown.',
            },
          },
          {
            sourceKey: 'domain-precedents',
            category: 'domain_precedent',
            label: 'Blind domain-PM calibration cases',
            collection: {
              state: 'collected',
              method: 'Freeze facts and hide candidate identity.',
              sourceRef: ref('case-set', 'v1'),
            },
            validity: { state: 'needs_review', detail: 'Collected examples are not yet calibrated.' },
            missingOrDisputed: ['Domain owner and disagreement policy are unknown.'],
            cost: { payer: 'Domain expert', detail: 'Expert hours and recurring calibration budget unknown.' },
          },
          {
            sourceKey: 'real-use-outcomes',
            category: 'real_world_outcome',
            label: 'Acceptance, takeover, repair and bounded follow-up',
            collection: {
              state: 'collected',
              method: 'Use natural outcomes and bounded follow-up.',
              sourceRef: ref('outcomes', 'v2'),
            },
            validity: {
              state: 'bounded',
              detail: 'Only acceptance and explicit takeover are currently interpretable.',
              validFor: 'Explicit acceptance/takeover events in the frozen project window.',
              proofRefs: [ref('validity-proof', 'v2')],
            },
            missingOrDisputed: ['Silence is not satisfaction.'],
            cost: { payer: 'Value owner', detail: 'User attention budget is bounded and not yet priced.' },
          },
        ],
        conditions: [
          {
            itemId: 'environment',
            label: 'Comparison environment',
            scope: 'Same project inputs, permissions, tools and time window.',
            why: 'Avoid attributing environment drift to the PM policy.',
            modifiability,
            sourceRefs: [ref('environment-check', 'v1')],
            nextAction: 'Freeze the environment ref for paired replay.',
          },
        ],
        comparison: {
          unit: 'One complete project opportunity episode.',
          primaryVariable: 'Unknown until baseline diagnosis distinguishes competing explanations.',
          controls: ['Task slice', 'environment', 'yardstick version'],
          developmentEvidence: 'Cases used to discover and choose changes remain in the development set.',
          independentHoldout: 'Independent cases are sealed from candidate and rubric selection.',
          repeatability: 'Repeat paired runs and report raw counts, uncertainty and instability.',
        },
        unknowns: ['No production data, roles, authorization, baseline or measurement service is connected.'],
        nextAction: 'Connect owner sources, then trial collection without claiming validity.',
      },
    };

    const parsed = evolutionPreparationSubmissionV1Schema.parse(measurement);
    if (parsed.body.kind !== 'measurement_plan') throw new Error('wrong body');
    expect(parsed.body.gtSources.map((source) => source.category)).toEqual([
      'business_fact',
      'domain_precedent',
      'real_world_outcome',
    ]);
    expect(parsed.body.gtSources[1].collection.state).toBe('collected');
    expect(parsed.body.gtSources[1].validity.state).toBe('needs_review');
  });

  it('rejects claims that collected data is bounded-valid without an owner proof and scope', () => {
    const measurement = {
      ...successSubmission,
      section: 'measurement_plan',
      body: {
        kind: 'measurement_plan',
        summary: 'Invalid shortcut',
        gtSources: [
          {
            sourceKey: 'facts',
            category: 'business_fact',
            label: 'Facts',
            collection: { state: 'collected', method: 'Collected', sourceRef: ref('facts', 'v1') },
            validity: { state: 'bounded', detail: 'Trust it', proofRefs: [] },
            missingOrDisputed: [],
            cost: { payer: 'nobody', detail: 'none' },
          },
        ],
        conditions: [],
        comparison: {
          unit: 'episode',
          primaryVariable: 'prompt',
          controls: [],
          developmentEvidence: 'same',
          independentHoldout: 'none',
          repeatability: 'once',
        },
        unknowns: [],
        nextAction: 'continue',
      },
    };
    expect(evolutionPreparationSubmissionV1Schema.safeParse(measurement).success).toBe(false);
  });

  it('rejects a section/body mismatch, a self dependency and a dependency from another Program', () => {
    expect(
      evolutionPreparationSubmissionV1Schema.safeParse({ ...successSubmission, section: 'object_map' }).success,
    ).toBe(false);
    expect(
      evolutionPreparationSubmissionV1Schema.safeParse({
        ...successSubmission,
        dependsOn: [submissionRef('success_contract', revision('a'))],
      }).success,
    ).toBe(false);
    expect(
      evolutionPreparationSubmissionV1Schema.safeParse({
        ...successSubmission,
        dependsOn: [
          {
            ...submissionRef('object_map', revision('a')),
            ownerStateRef: 'preparation-submission:evolution-program:ffffffffffffffffffffffffffffffff:object_map',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('adds refs-only preparation events without changing the canonical target, stage or cycle', () => {
    const created = evolutionProgramEventEnvelopeV1Schema.parse({
      schemaVersion: 1,
      eventId: 'event-create',
      programId: PROGRAM_ID,
      expectedSequence: 0,
      clientMessageId: 'source:create',
      actorRef: 'cat:codex-sol',
      originRef: 'thread:thread-prep:invocation:inv-create:message:source',
      occurredAt: '2026-09-09T06:59:00.000Z',
      event: {
        type: 'program_created',
        workspaceId: 'user:operator',
        objectRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:pm-agent' },
        claimRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-claim:${PROGRAM_ID}` },
        displayName: '让 PM Agent 专业地推进项目，只在必要时请人介入',
      },
    });
    const initial = reduceEvolutionProgramEvent(undefined, created);
    const work = evolutionProgramEventEnvelopeV1Schema.parse({
      schemaVersion: 1,
      eventId: 'event-work',
      programId: PROGRAM_ID,
      expectedSequence: 1,
      clientMessageId: 'source:prep-work',
      actorRef: 'cat:codex-sol',
      originRef: 'thread:thread-prep:invocation:inv-work:message:source',
      occurredAt: '2026-09-09T07:00:00.000Z',
      event: {
        type: 'preparation_work_registered',
        section: 'measurement_plan',
        itemId: 'data-feedback',
        focus: 'Connect GT collection conditions.',
        activityRef: { ownerFeatureId: 'F167', ownerStateRef: 'invocation:inv-work' },
      },
    }) as EvolutionProgramEventEnvelopeV1;
    const working = reduceEvolutionProgramEvent(initial, work);
    const committed = evolutionProgramEventEnvelopeV1Schema.parse({
      schemaVersion: 1,
      eventId: 'event-submit',
      programId: PROGRAM_ID,
      expectedSequence: 2,
      clientMessageId: 'source:prep-submit',
      actorRef: 'cat:codex-sol',
      originRef: 'thread:thread-prep:invocation:inv-work:message:source',
      occurredAt: '2026-09-09T07:01:00.000Z',
      event: {
        type: 'preparation_submission_committed',
        section: 'measurement_plan',
        submissionRef: submissionRef('measurement_plan', revision('c')),
        dependencies: [submissionRef('object_map', revision('a')), submissionRef('success_contract', revision('b'))],
      },
    }) as EvolutionProgramEventEnvelopeV1;
    const submitted = reduceEvolutionProgramEvent(working, committed);

    expect(submitted.program.objectRef).toEqual(initial.program.objectRef);
    expect(submitted.program.claimRef).toEqual(initial.program.claimRef);
    expect(submitted.program.stage).toBe(initial.program.stage);
    expect(submitted.program.cycle).toBe(initial.program.cycle);
    expect(submitted.program.currentAssetVersionRefs).toEqual(initial.program.currentAssetVersionRefs);
    expect(submitted.program.sequence).toBe(3);
    expect(submitted.cycles[0].lineageRefIds).toContain(submissionRef('measurement_plan', revision('c')).ownerStateRef);
  });
});
