import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ProgramJoinInputError,
  ProgramJoinValidator,
} from '../dist/infrastructure/capability-evolution/program-join-validator.js';
import {
  createEvolutionProgramTriggerRegistrationProvider,
  dispatchEvolutionProgramThresholdTrigger,
  loadEvolutionProgramTriggerRegistration,
} from '../dist/infrastructure/capability-evolution/program-trigger-bridge.js';

const harnessFeedbackRoot = fileURLToPath(new URL('../../../docs/harness-feedback', import.meta.url));

const consumerRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-consumer:evolution-program:test',
};

const completeEvidence = {
  decisionProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:proof-1' },
  evidenceRoleRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-role:observer-1' },
  consumptionProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-consumption:receipt-1' },
  optimizerExposureProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'optimizer-exposure:proof-1' },
  promotionHoldoutRef: { ownerFeatureId: 'F267', ownerStateRef: 'promotion-holdout:holdout-1' },
};

function sourceBindings() {
  return [
    {
      sourceKind: 'paw-feel-disposition',
      ownerSurfaceRef: { ownerFeatureId: 'F278', ownerStateRef: 'paw-feel:signal-1' },
      joinKey: 'message:message-1',
      namedConsumerRef: consumerRef,
      instrumentationRef: { ownerFeatureId: 'F278', ownerStateRef: 'instrumentation:paw-feel-v1' },
    },
    {
      sourceKind: 'human-disposition',
      ownerSurfaceRef: { ownerFeatureId: 'F281', ownerStateRef: 'human-disposition:decision-1' },
      joinKey: 'subject:proposal-1',
      namedConsumerRef: consumerRef,
      instrumentationRef: { ownerFeatureId: 'F281', ownerStateRef: 'instrumentation:human-disposition-v1' },
    },
  ];
}

function validator({ evidence = { status: 'verified', proofRefs: completeEvidence } } = {}) {
  return new ProgramJoinValidator({
    trajectoryResolver: async ({ invocationId }) => ({
      status: 'resolved',
      invocationId,
      threadId: 'thread-owner',
      sessionId: 'session-owner',
    }),
    sourceResolvers: {
      'paw-feel-disposition': async ({ ownerSurfaceRef, joinKey }) => ({
        status:
          ownerSurfaceRef.ownerStateRef === 'paw-feel:signal-1' && joinKey === 'message:message-1'
            ? 'resolved'
            : 'missing',
      }),
      'human-disposition': async ({ ownerSurfaceRef, joinKey }) => ({
        status:
          ownerSurfaceRef.ownerStateRef === 'human-disposition:decision-1' && joinKey === 'subject:proposal-1'
            ? 'resolved'
            : 'missing',
      }),
    },
    evidenceProofResolver: async () => evidence,
  });
}

function input(overrides = {}) {
  return {
    programId: 'evolution-program:test',
    ownerUserId: 'operator',
    trajectoryRef: { ownerFeatureId: 'F299', ownerStateRef: 'inv:invocation-1' },
    sourceBindings: sourceBindings(),
    evidenceProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:proof-1' },
    ...overrides,
  };
}

describe('F311 owner-backed observation joins', () => {
  it('accepts only the canonical F299 inv:<id> trajectory ref', async () => {
    for (const trajectoryRef of [
      { ownerFeatureId: 'F299', ownerStateRef: 'trajectory:invocation-1' },
      { ownerFeatureId: 'F311', ownerStateRef: 'inv:invocation-1' },
      { ownerFeatureId: 'F299', ownerStateRef: 'inv:' },
    ]) {
      await assert.rejects(
        () => validator().validate(input({ trajectoryRef })),
        (error) => error instanceof ProgramJoinInputError && error.code === 'trajectory_ref_invalid',
      );
    }
  });

  it('links two heterogeneous canonical owner surfaces without carrying owner payloads', async () => {
    const result = await validator().validate(input());

    assert.equal(result.status, 'ready');
    assert.equal(result.setup.trajectory.ref.ownerStateRef, 'inv:invocation-1');
    assert.equal(result.setup.trajectory.joinKey, 'thread:thread-owner');
    assert.deepEqual(
      result.setup.sourceBindings.map(({ sourceKind }) => sourceKind),
      ['paw-feel-disposition', 'human-disposition'],
    );
    assert.ok(
      result.setup.sourceBindings.every(
        (binding) => binding.namedConsumerRef.ownerStateRef === consumerRef.ownerStateRef,
      ),
    );
    const encoded = JSON.stringify(result.setup);
    for (const forbidden of ['payload', 'episode', 'projection', 'sourceMessageBody', 'decisionBody']) {
      assert.equal(encoded.includes(forbidden), false, `setup must not copy ${forbidden}`);
    }
  });

  it('returns typed insufficient when heterogeneous surfaces or canonical owner joins are missing', async () => {
    const oneSurface = await validator().validate(input({ sourceBindings: sourceBindings().slice(0, 1) }));
    assert.equal(oneSurface.status, 'insufficient');
    assert.ok(oneSurface.blockers.some((blocker) => blocker.code === 'heterogeneous_owner_surfaces_missing'));

    const missingJoin = await validator().validate(
      input({
        sourceBindings: sourceBindings().map((binding, index) =>
          index === 0 ? { ...binding, joinKey: 'message:not-canonical' } : binding,
        ),
      }),
    );
    assert.equal(missingJoin.status, 'insufficient');
    assert.ok(missingJoin.blockers.some((blocker) => blocker.code === 'owner_surface_unresolved'));

    const duplicateOwner = sourceBindings();
    duplicateOwner[1] = {
      ...duplicateOwner[1],
      ownerSurfaceRef: duplicateOwner[0].ownerSurfaceRef,
      joinKey: duplicateOwner[0].joinKey,
    };
    const duplicate = await validator().validate(input({ sourceBindings: duplicateOwner }));
    assert.ok(duplicate.blockers.some((blocker) => blocker.code === 'heterogeneous_owner_surfaces_missing'));

    const unnamed = sourceBindings();
    unnamed[0] = {
      ...unnamed[0],
      namedConsumerRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-consumer:anonymous' },
    };
    const missingConsumer = await validator().validate(input({ sourceBindings: unnamed }));
    assert.ok(missingConsumer.blockers.some((blocker) => blocker.code === 'named_consumer_missing'));

    const wrongProgram = sourceBindings();
    wrongProgram[0] = {
      ...wrongProgram[0],
      namedConsumerRef: {
        ownerFeatureId: 'F311',
        ownerStateRef: 'evolution-consumer:evolution-program:other',
      },
    };
    const crossProgramConsumer = await validator().validate(input({ sourceBindings: wrongProgram }));
    assert.ok(crossProgramConsumer.blockers.some((blocker) => blocker.code === 'named_consumer_missing'));

    const wrongInstrumentationOwner = sourceBindings();
    wrongInstrumentationOwner[0] = {
      ...wrongInstrumentationOwner[0],
      instrumentationRef: {
        ownerFeatureId: 'F311',
        ownerStateRef: 'instrumentation:local-fallback',
      },
    };
    const invalidInstrumentation = await validator().validate(input({ sourceBindings: wrongInstrumentationOwner }));
    assert.ok(invalidInstrumentation.blockers.some((blocker) => blocker.code === 'instrumentation_proposal_invalid'));
  });

  it('fails closed as typed insufficient for missing consumption, exposure, or independent holdout proof', async () => {
    for (const code of [
      'evidence_role_missing',
      'consumption_proof_missing',
      'optimizer_exposure_proof_missing',
      'promotion_holdout_missing',
      'promotion_holdout_reuses_evaluation_cohort',
      'promotion_holdout_optimizer_exposed',
      'promotion_holdout_not_sealed',
      'promotion_holdout_not_time_fresh',
    ]) {
      const result = await validator({
        evidence: {
          status: 'insufficient',
          blockers: [{ code, ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:proof-1' }],
        },
      }).validate(input());
      assert.equal(result.status, 'insufficient');
      assert.deepEqual(
        result.blockers.map((blocker) => blocker.code),
        [code],
      );
    }
  });

  it('registers event, quota, and time triggers in the canonical F192 domain', () => {
    const registration = loadEvolutionProgramTriggerRegistration({
      harnessFeedbackRoot,
      now: new Date('2026-08-31T22:00:00.000Z'),
    });

    assert.equal(registration.status, 'registered');
    assert.equal(registration.registrationRef.ownerFeatureId, 'F192');
    assert.equal(registration.domainId, 'eval:capability-evolution');
    assert.deepEqual(registration.channels, ['event', 'quota', 'time']);
    assert.equal(registration.policy.mode, 'threshold_or_time');
    assert.equal(registration.policy.eventSource, 'evolution-program-stream');
    assert.deepEqual(registration.policy.threshold, { counter: 'connectedOwnerSurfaces', crossingAt: 2 });
    assert.equal(registration.nextEvaluationAt, '2026-09-06T03:00:00.000Z');
  });

  it('turns an unavailable F192 registration artifact into an honest missing-registration projection', () => {
    const registration = loadEvolutionProgramTriggerRegistration({
      harnessFeedbackRoot: '/definitely/not/a/cat-cafe-harness-root',
      now: new Date('2026-08-31T22:00:00.000Z'),
    });

    assert.equal(registration, undefined);
  });

  it('keeps the next F192 evaluation time fresh across cron boundaries without reloading the domain', () => {
    let now = new Date('2026-08-31T22:00:00.000Z');
    const registration = createEvolutionProgramTriggerRegistrationProvider({
      harnessFeedbackRoot,
      now: () => now,
    });

    assert.equal(registration()?.nextEvaluationAt, '2026-09-06T03:00:00.000Z');
    now = new Date('2026-09-06T04:00:00.000Z');
    assert.equal(registration()?.nextEvaluationAt, '2026-09-13T03:00:00.000Z');
  });

  it('delegates a linked Program event to F192 threshold dispatch without an F311 scheduler or ledger', async () => {
    const claims = new Set();
    const delivered = [];
    const result = await dispatchEvolutionProgramThresholdTrigger({
      harnessFeedbackRoot,
      programEventId: 'evolution-event:observe-1',
      previousConnectedOwnerSurfaces: 0,
      currentConnectedOwnerSurfaces: 2,
      nowMs: Date.parse('2026-08-31T22:00:00.000Z'),
      store: {
        async claim(receipt) {
          const key = [receipt.kind, receipt.domainId, receipt.receiptId].join(':');
          if (claims.has(key)) return { outcome: 'deduped' };
          claims.add(key);
          return { outcome: 'claimed' };
        },
        async complete() {
          return true;
        },
        async release() {},
      },
      deliver: async (message) => {
        delivered.push(message);
        return 'message-eval-1';
      },
    });

    assert.equal(result.outcome, 'dispatched');
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].idempotencyKey, /^eval-domain-trigger:eval:capability-evolution:/);
  });
});
