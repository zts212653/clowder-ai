import { describe, expect, it } from 'vitest';
import {
  evolutionProgramEventEnvelopeV1Schema,
  evolutionProgramStateV1Schema,
  evolutionProgramV1Schema,
  ownerTruthRefV1Schema,
  reduceEvolutionProgramEvent,
  replayEvolutionProgramEvents,
} from '../types/capability-evolution.js';
import {
  activeCycleEvents,
  assetRef,
  decidingEvents,
  envelope,
  expectReducerCode,
  ref,
  rotatedCycle,
  terminalEvents,
} from './capability-evolution.fixtures.js';

describe('capability evolution contracts', () => {
  it('INV-1 keeps exactly one object and one claim for a Program', () => {
    const created = activeCycleEvents()[0];
    const state = replayEvolutionProgramEvents([created]);
    expect(state?.program.objectRef).toEqual(ref('skill:video-forge', 'v1'));
    expect(state?.program.claimRef).toEqual(ref('claim:reduce-decorative-noise', 'v1'));
    expect(
      evolutionProgramEventEnvelopeV1Schema.safeParse({
        ...created,
        event: {
          ...created.event,
          claimRefs: [ref('claim:first'), ref('claim:second')],
        },
      }).success,
    ).toBe(false);
  });

  it('permits only one intervention layer in a Cycle', () => {
    const events = activeCycleEvents();
    const state = replayEvolutionProgramEvents(events);
    expect(state?.cycles).toHaveLength(1);
    expect(state?.cycles[0].interventionLayerRef).toEqual(ref('intervention-layer:harness'));
    expectReducerCode(
      () =>
        reduceEvolutionProgramEvent(
          state,
          envelope(
            7,
            {
              type: 'intervention_linked',
              interventionCardRef: ref('intervention-card:2'),
              interventionLayerRef: ref('intervention-layer:skill'),
              gateReceiptRef: ref('intervention-gate:2'),
            },
            'second-intervention',
          ),
        ),
      'invalid_transition',
    );
  });

  it.each([
    'tune',
    'rollback',
  ] as const)('INV-13 closes the old Cycle before opening a clean Cycle for %s', (decision) => {
    const next = rotatedCycle(decision);
    expect(next.program).toMatchObject({ cycle: 2, stage: 'instrumenting', lifecycle: 'active' });
    expect(next.cycles).toHaveLength(2);
    expect(next.cycles[0]).toMatchObject({
      decision,
      closedAt: '2026-08-31T05:11:00.000Z',
    });
    expect(next.cycles[1]).toMatchObject({
      cycle: 2,
      stage: 'instrumenting',
      lineageRefIds: [],
      openedAt: '2026-08-31T05:11:00.000Z',
    });
    expect(next.cycles[1].interventionLayerRef).toBeUndefined();
    const inheritedBoundary = structuredClone(next);
    inheritedBoundary.cycles[1].interventionLayerRef = ref('intervention-layer:inherited');
    inheritedBoundary.cycles[1].lineageRefIds = ['intervention-layer:inherited'];
    expect(evolutionProgramStateV1Schema.safeParse(inheritedBoundary).success).toBe(false);
  });

  it.each([
    ['program_paused', { type: 'program_paused', reasonRef: ref('reason:pause') }, { lifecycle: 'paused' }],
    [
      'program_withdrawn',
      { type: 'program_withdrawn', decisionRef: ref('decision:withdraw') },
      { lifecycle: 'terminal', terminalDisposition: 'withdrawn' },
    ],
    [
      'expert_required',
      { type: 'expert_required', missingRole: 'calibrator', blockerRef: ref('blocker:calibrator') },
      { lifecycle: 'needs_expert' },
    ],
  ] as const)('allows %s on a rotated Cycle before sources are linked', (name, event, expected) => {
    const next = reduceEvolutionProgramEvent(rotatedCycle(), envelope(12, event, `rotated-${name}`));
    expect(next.program).toMatchObject(expected);
    expect(next.cycles[1].lineageRefIds).not.toHaveLength(0);
  });

  it('INV-13 never revives a terminal Program', () => {
    const terminal = replayEvolutionProgramEvents(terminalEvents());
    expect(terminal?.program.lifecycle).toBe('terminal');
    expectReducerCode(
      () =>
        reduceEvolutionProgramEvent(
          terminal,
          envelope(12, { type: 'program_resumed', resumeRef: ref('resume:forbidden') }, 'terminal-resume'),
        ),
      'program_terminal',
    );
    const retained = reduceEvolutionProgramEvent(
      terminal,
      envelope(
        12,
        {
          type: 'retention_opted_in',
          retention: {
            mode: 'forget_after',
            optedInBy: 'user:operator',
            optedInAt: '2026-08-31T06:00:00.000Z',
            ttlSeconds: 86_400,
          },
          retentionActionRef: ref('retention-action:1'),
        },
        'terminal-retention',
      ),
    );
    expect(retained.program.lifecycle).toBe('terminal');
    expect(retained.program.terminalDisposition).toBe('kept');
  });

  it('deterministically replays the same event stream without mutating it', () => {
    const events = terminalEvents();
    const snapshot = structuredClone(events);
    const first = replayEvolutionProgramEvents(events);
    const second = replayEvolutionProgramEvents(structuredClone(events));
    expect(first).toEqual(second);
    expect(events).toEqual(snapshot);
    expect(first?.program.sequence).toBe(events.length);
    expect(first?.cycles[0]).toMatchObject({ decision: 'keep', closedAt: events.at(-1)?.occurredAt });
  });

  it('keeps same-named assets from different canonical owners as distinct versions', () => {
    const pending = replayEvolutionProgramEvents([
      ...activeCycleEvents(),
      envelope(7, {
        type: 'change_cycle_linked',
        caseRef: ref('case:1'),
        proposalRef: ref('proposal:1'),
        ownerAuthorizationRef: ref('authorization:1'),
        targetVersionRef: {
          ownerFeatureId: 'F267',
          ownerStateRef: 'asset-version:video-forge-v1',
          version: 'v1',
          assetKind: 'skill',
          assetId: 'video-forge',
        },
      }),
      envelope(8, {
        type: 'approval_linked',
        approvalRef: ref('approval:1'),
        targetVersionRef: {
          ownerFeatureId: 'F267',
          ownerStateRef: 'asset-version:video-forge-v1',
          version: 'v1',
          assetKind: 'skill',
          assetId: 'video-forge',
        },
      }),
    ]);
    if (!pending) throw new Error('expected pending Program');
    pending.program.currentAssetVersionRefs = [
      ...pending.program.currentAssetVersionRefs,
      {
        ownerFeatureId: 'F202',
        ownerStateRef: 'asset-version:video-forge-external-v7',
        version: 'v7',
        assetKind: 'skill',
        assetId: 'video-forge',
      },
    ];

    const mutated = reduceEvolutionProgramEvent(
      pending,
      envelope(9, {
        type: 'intervention_receipt_linked',
        result: 'changed',
        interventionReceiptRef: ref('mutation:1'),
        assetVersionRef: {
          ownerFeatureId: 'F267',
          ownerStateRef: 'asset-version:video-forge-v2',
          version: 'v2',
          assetKind: 'skill',
          assetId: 'video-forge',
        },
        loadedRuntimeRef: ref('runtime:loaded-v2'),
      }),
    );

    expect(mutated.program.currentAssetVersionRefs).toHaveLength(2);
    expect(mutated.program.currentAssetVersionRefs.map((value) => value.ownerFeatureId).sort()).toEqual([
      'F202',
      'F267',
    ]);
  });

  it('rejects a no_change event that moves the exact asset version', () => {
    expectReducerCode(
      () =>
        reduceEvolutionProgramEvent(
          replayEvolutionProgramEvents(decidingEvents()),
          envelope(11, {
            type: 'decision_recorded',
            decision: 'no_change',
            decisionRef: ref('decision:no-change-drift'),
            executionReceiptRef: ref('no-change-receipt:drift'),
            assetVersionRef: assetRef('asset-version:video-forge-v3', 'skill', 'video-forge', 'v3'),
          }),
        ),
      'invalid_transition',
    );
  });

  it.each([
    { result: 'changed' as const },
    { result: 'no_change' as const, loadedRuntimeRef: ref('runtime:invented') },
  ])('requires loaded runtime truth only for changed interventions ($result)', (intervention) => {
    expect(
      evolutionProgramEventEnvelopeV1Schema.safeParse(
        envelope(9, {
          type: 'intervention_receipt_linked',
          interventionReceiptRef: ref('intervention-receipt:1'),
          assetVersionRef: assetRef('asset-version:video-forge-v2', 'skill', 'video-forge', 'v2'),
          ...intervention,
        }),
      ).success,
    ).toBe(false);
  });

  it.each([
    assetRef('asset-version:video-forge-v2', 'skill', 'video-forge', 'v2'),
    assetRef('asset-version:other-v1', 'skill', 'other', 'v1'),
  ])('rejects a rollback event without a different version of the same current asset', (assetVersionRef) => {
    expectReducerCode(
      () =>
        reduceEvolutionProgramEvent(
          replayEvolutionProgramEvents(decidingEvents()),
          envelope(11, {
            type: 'decision_recorded',
            decision: 'rollback',
            decisionRef: ref('decision:rollback-invalid'),
            executionReceiptRef: ref('rollback-receipt:invalid'),
            assetVersionRef,
          }),
        ),
      'invalid_transition',
    );
  });

  it('INV-2 rejects owner payloads instead of accepting them as owner refs', () => {
    expect(ownerTruthRefV1Schema.safeParse(ref('owner:valid-ref')).success).toBe(true);
    expect(ownerTruthRefV1Schema.safeParse(ref('{"transcript":"private"}')).success).toBe(false);
    expect(ownerTruthRefV1Schema.safeParse(ref('payload:{"transcript":"private"}')).success).toBe(false);
    expect(ownerTruthRefV1Schema.safeParse(ref('owner ref with spaces')).success).toBe(false);
  });

  it('INV-15 rejects object-specific fields and hidden payload keys at every boundary', () => {
    const created = activeCycleEvents()[0];
    for (const forbidden of [
      { objectKind: 'skill' },
      { skillId: 'video-forge' },
      { rubricText: 'Prefer fewer decorations.' },
      { trajectoryPayload: { transcript: 'private' } },
      { payload: { approvalDecision: 'approved' } },
      { metadata: { mutationBytes: 'secret' } },
    ]) {
      expect(
        evolutionProgramEventEnvelopeV1Schema.safeParse({
          ...created,
          event: { ...created.event, ...forbidden },
        }).success,
      ).toBe(false);
    }
    expect(ownerTruthRefV1Schema.safeParse({ ...ref('owner:1'), data: { raw: true } }).success).toBe(false);
    const projected = replayEvolutionProgramEvents([created]);
    expect(evolutionProgramV1Schema.safeParse({ ...projected?.program, objectType: 'skill' }).success).toBe(false);
  });

  it('INV-7 fails closed with a typed blocker instead of inventing missing role truth', () => {
    const created = replayEvolutionProgramEvents([activeCycleEvents()[0]]);
    const blocked = reduceEvolutionProgramEvent(
      created,
      envelope(1, {
        type: 'expert_required',
        missingRole: 'calibrator',
        blockerRef: ref('blocker:missing-calibrator'),
      }),
    );
    expect(blocked.program).toMatchObject({ lifecycle: 'needs_expert', stage: 'constituting' });
    expect(blocked.cycles[0].stage).toBe('constituting');
    const forgedReadiness = structuredClone(created);
    if (forgedReadiness === undefined) throw new Error('expected created Program');
    forgedReadiness.program.stage = 'instrumenting';
    forgedReadiness.program.certificates = {
      goal: ref('certificate:goal-1'),
      measurement: ref('certificate:measurement-1'),
    };
    forgedReadiness.program.valueOwnerRef = ref('owner:operator');
    forgedReadiness.program.measurementRoleRefs = {
      observer: ref('role:observer'),
      domainOwner: ref('role:domain-owner'),
      consumer: ref('role:consumer'),
    };
    forgedReadiness.cycles[0].stage = 'instrumenting';
    const forged = evolutionProgramStateV1Schema.safeParse(forgedReadiness);
    expect(!forged.success && forged.error.issues[0]?.message).toBe(
      'ready stages require complete certificates, value owner, and measurement roles',
    );
  });

  it.each([
    'eventId',
    'clientMessageId',
  ] as const)('rejects duplicate %s identities while replaying a canonical stream', (identity) => {
    const events = activeCycleEvents().slice(0, 2);
    events[1] = { ...events[1], [identity]: events[0][identity] };
    expectReducerCode(() => replayEvolutionProgramEvents(events), 'invalid_transition');
  });

  it('exports the runtime contracts from both shared barrels', async () => {
    const [root, types] = await Promise.all([import('../index.js'), import('../types/index.js')]);
    expect(root.evolutionProgramEventEnvelopeV1Schema).toBe(evolutionProgramEventEnvelopeV1Schema);
    expect(types.evolutionProgramEventEnvelopeV1Schema).toBe(evolutionProgramEventEnvelopeV1Schema);
    expect(root.replayEvolutionProgramEvents).toBe(replayEvolutionProgramEvents);
    expect(types.reduceEvolutionProgramEvent).toBe(reduceEvolutionProgramEvent);
  });
});
