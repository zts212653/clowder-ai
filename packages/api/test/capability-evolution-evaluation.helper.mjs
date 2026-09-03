/**
 * Shared fixtures for the F311 Phase 3 evaluation ingress suites.
 *
 * `observingProgram()` drives a real EvolutionProgramService through constitution, observation setup
 * and trigger, so both the happy-path suite and the negative-contract suite start from a Program
 * that actually reached `evaluating` rather than from a synthetic event array. It lives here because
 * the two suites were maintaining byte-identical copies, which is exactly how a fixture starts
 * meaning two different things.
 */

import assert from 'node:assert/strict';

const { EvolutionProgramService } = await import('../dist/infrastructure/capability-evolution/program-service.js');
const { projectEvolutionAttribution } = await import(
  '../dist/infrastructure/capability-evolution/program-attribution-projection.js'
);

export { EvolutionProgramService, projectEvolutionAttribution };

export class MemoryEventLog {
  events = new Map();
  async append(envelope) {
    const events = this.events.get(envelope.programId) ?? [];
    if (events.length !== envelope.expectedSequence) return { outcome: 'conflict', actualSequence: events.length };
    events.push(envelope);
    this.events.set(envelope.programId, events);
    return { outcome: 'appended', sequence: events.length };
  }
  async appendActiveForget() {
    throw new Error('not used');
  }
  async read(programId) {
    return [...(this.events.get(programId) ?? [])];
  }
  async readWithTtl(programId) {
    return { events: await this.read(programId), ttl: -1 };
  }
  async listProgramIds() {
    return [...this.events.keys()];
  }
  async ttl() {
    return -1;
  }
}

export const owner = (ownerFeatureId, ownerStateRef, version) =>
  version === undefined ? { ownerFeatureId, ownerStateRef } : { ownerFeatureId, ownerStateRef, version };

export const COHORT = owner('F267', 'frozen-cohort:w7');
export const rubric = (version) => ({
  ownerFeatureId: 'F192',
  ownerStateRef: 'rubric:evolve-video-skill',
  version,
  assetKind: 'rubric',
  assetId: 'evolve-video-skill',
});

// Identity only; every verdict field now comes from the owner stub below.
export const measurementRefs = (proofId = 'proof-1') => ({
  evidenceProofRef: owner('F267', `measurement-proof:${proofId}`),
});

/**
 * Stands in for F267 AFTER the owner-contract repair: it publishes canonical certificate/result
 * owner refs. The certificate is late-bound to the Program under test, because the proof must
 * belong to this Program's constitution — a proof for another certificate is rejected.
 */
export const ownerResolver = (bundle = {}, certificate = { ref: undefined }) => ({
  // Distinct proofs address distinct results, exactly as the repaired owner contract would.
  resolveMeasurement: async ({ evidenceProofRef }) =>
    // The real F267 resolver only answers for `measurement-proof:<id>` refs; anything else is
    // `invalid_proof_ref`. Mirrored here so a caller-invented ref cannot quietly resolve in tests.
    !evidenceProofRef.ownerStateRef.startsWith('measurement-proof:')
      ? { status: 'unavailable', reason: 'invalid_proof_ref' }
      : {
          status: 'ready',
          bundle: {
            certificateRef: certificate.ref,
            resultRef: owner('F267', `measurement-result:${evidenceProofRef.ownerStateRef.split(':')[1]}`),
            ownerDecisionStatus: 'usable',
            frozenCohortRef: COHORT,
            // The ruler is owner truth. This stub moves it on `proof-2` so a test can exercise a real
            // version move without ever stating the rubric from the caller side.
            rubricRef: rubric(evidenceProofRef.ownerStateRef.endsWith('proof-2') ? 'v4' : 'v3'),
            baselineRef: owner('F267', 'measurement-baseline:w0'),
            exposureProofRef: owner('F267', 'exposure-proof:w7'),
            uncertainty: { evidenceRef: owner('F267', 'uncertainty-evidence:w7'), basis: 'interval' },
            discriminatingLayers: ['execution'],
            // The card is owner-published too. A test that wants a blocked gate removes an element
            // from what the OWNER publishes, because nothing about it can come from the request.
            interventionCard: completeCard(),
            // Owner-held, like every other element of the card: F311 minting its own gate receipt would
            // be authorising its own change, which the gate refuses.
            gateReceiptRef: owner('F267', 'intervention-gate-receipt:c1'),
            holdoutOptimizerExposed: false,
            ...bundle,
          },
        },
});

// Evidence must be a surface this Program actually connected in Phase 2, not an invented ref.
export const TRAJECTORY = owner('F299', 'inv:invocation-1');
export const EYE = owner('F278', 'paw-feel:signal-1');
export const candidate = (layer) => ({ layer, evidenceRefs: [layer === 'execution' ? TRAJECTORY : EYE] });

export const completeCard = (overrides = {}) => ({
  cardRef: owner('F267', 'intervention-card:c1'),
  competingAttributionRefs: [
    owner('F267', 'competing-attribution:harness'),
    owner('F267', 'competing-attribution:rubric'),
  ],
  causalHypothesisRef: owner('F267', 'causal-hypothesis:c1'),
  expectedDeltaRef: owner('F267', 'expected-delta:c1'),
  guardrailRefs: [owner('F267', 'guardrail-metric:latency')],
  replayCohortRef: COHORT,
  promotionHoldoutRef: owner('F267', 'sealed-holdout:h1'),
  holdoutExposureProofRef: owner('F267', 'exposure-proof:holdout-h1'),
  holdoutOptimizerExposed: false,
  interventionFalsifierRef: owner('F267', 'intervention-falsifier:c1'),
  rubricReopenTriggerRef: owner('F267', 'rubric-reopen-trigger:c1'),
  costRef: owner('F311', 'evolution-economics:evolve'),
  rollbackRef: owner('F202', 'rollback-plan:skill:video-forge'),
  ...overrides,
});

/**
 * Drives a Program from `create()` all the way to `evaluating` THROUGH THE SERVICE.
 *
 * An earlier version appended `certificates_linked`, `observation_setup_linked` and
 * `evaluation_triggered` straight into the event log. That proved the reducer accepts those
 * transitions; it proved nothing about whether the product can perform them — and it hid the fact
 * that two of the three had no public producer at all. Every step below goes through a method a real
 * caller can reach, so if the ingress regresses, these tests go red instead of staying green on a
 * stream no user could ever produce.
 */
export const TRIGGER_REGISTRATION = {
  status: 'registered',
  registrationRef: { ownerFeatureId: 'F192', ownerStateRef: 'eval-domain:eval:capability-evolution' },
  domainId: 'eval:capability-evolution',
  channels: ['event', 'quota', 'time'],
  policy: { mode: 'threshold_or_time' },
  nextEvaluationAt: '2026-09-08T00:00:00.000Z',
};

export async function observingProgram(options = {}) {
  const eventLog = new MemoryEventLog();
  const certificate = { ref: undefined };
  const dispatchedRounds = [];
  const setupResolver = ownerResolver(options.bundle, certificate);
  const activeResolver = { current: setupResolver };
  const service = new EvolutionProgramService({
    eventLog,
    joinValidator: {
      validate: async () => ({
        status: 'ready',
        setup: {
          trajectory: { ref: TRAJECTORY, joinKey: 'thread:thread-owner' },
          sourceBindings: [
            {
              sourceKind: 'paw-feel-disposition',
              ownerSurfaceRef: EYE,
              joinKey: 'message:message-1',
              namedConsumerRef: owner('F311', 'evolution-consumer:program'),
              instrumentationRef: owner('F278', 'instrumentation:paw-feel-v1'),
            },
            {
              sourceKind: 'human-disposition',
              ownerSurfaceRef: owner('F281', 'human-disposition:decision-1'),
              joinKey: 'subject:proposal-1',
              namedConsumerRef: owner('F311', 'evolution-consumer:program'),
              instrumentationRef: owner('F281', 'instrumentation:human-disposition-v1'),
            },
          ],
          evidenceProofRefs: {
            decisionProofRef: owner('F267', 'measurement-proof:proof-1'),
            evidenceRoleRef: owner('F267', 'measurement-role:observer-1'),
            consumptionProofRef: owner('F267', 'measurement-consumption:receipt-1'),
            optimizerExposureProofRef: owner('F267', 'optimizer-exposure:proof-1'),
            promotionHoldoutRef: owner('F267', 'promotion-holdout:holdout-1'),
          },
          triggerRef: owner('F192', 'eval-trigger:program'),
        },
      }),
    },
    triggerRegistration: () => TRIGGER_REGISTRATION,
    dispatchObservationTrigger: async () => ({ outcome: 'dispatched' }),
    dispatchEvaluationTrigger: async (context) => {
      dispatchedRounds.push(context);
      return options.roundDispatch ?? { outcome: 'dispatched', dedupeKey: 'round-1' };
    },
    // The owner is reachable while the Program is constituted and the round opens — it has to be,
    // or no round could open at all. `options.evaluationOwnerResolver` then takes over for the
    // measurement itself, which is how the real hazard looks: the owner goes away BETWEEN steps.
    ...(options.ownerContract === 'absent'
      ? {}
      : {
          evaluationOwnerResolver: {
            resolveMeasurement: (request) => activeResolver.current.resolveMeasurement(request),
          },
        }),
  });

  const created = await service.create({
    workspaceId: 'user:operator',
    targetRef: owner('F202', 'skill:video-forge'),
    clientMessageId: 'create',
    actorRef: 'cat:opus5',
    originRef: 'thread:f311:create',
  });
  const programId = created.projection.program.programId;
  const ref = (kind) => owner(kind === 'goal' || kind === 'economic' ? 'F311' : 'F267', `${kind}:${programId}`);
  certificate.ref = ref('measurement');

  const step = async (label, result) => {
    assert.equal(result.outcome, 'appended', `${label}: ${JSON.stringify(result)}`);
    return result;
  };

  await step(
    'constitution',
    await service.linkCertificates({
      ...base(programId, 1, 'constitution'),
      certificates: { goal: ref('goal'), measurement: ref('measurement'), economic: ref('economic') },
      valueOwnerRef: ref('value-owner'),
      measurementRoleRefs: {
        observer: ref('observer'),
        domainOwner: ref('domain-owner'),
        consumer: ref('consumer'),
        calibrator: ref('calibrator'),
      },
    }),
  );
  await step(
    'observation',
    await service.linkObservation({
      ...base(programId, 2, 'observe'),
      ownerUserId: 'operator',
      trajectoryRef: TRAJECTORY,
      sourceBindings: [],
      evidenceProofRef: owner('F267', 'measurement-proof:proof-1'),
    }),
  );
  if (options.stopBeforeTrigger !== true) {
    await step(
      'trigger',
      await service.triggerEvaluation({
        ...base(programId, 3, 'triggered'),
        ownerUserId: 'operator',
        evidenceProofRef: owner('F267', 'measurement-proof:proof-1'),
      }),
    );
  }
  if ('evaluationOwnerResolver' in options) {
    activeResolver.current = options.evaluationOwnerResolver ?? {
      resolveMeasurement: async () => ({ status: 'unavailable', reason: 'owner contract not wired' }),
    };
  }
  return { eventLog, service, programId, dispatchedRounds };
}

export const base = (programId, expectedSequence, clientMessageId) => ({
  programId,
  expectedSequence,
  clientMessageId,
  actorRef: 'cat:opus5',
  originRef: `thread:f311:${clientMessageId}`,
});
