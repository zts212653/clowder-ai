import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let EvolutionProgramService;

before(async () => {
  ({ EvolutionProgramService } = await import('../dist/infrastructure/capability-evolution/program-service.js'));
});

class MemoryEventLog {
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
  async listProgramIds(workspaceId) {
    return [...this.events.entries()]
      .filter(([, events]) => events[0]?.event.workspaceId === workspaceId)
      .map(([programId]) => programId);
  }
  async ttl() {
    return -1;
  }
}

const triggerRegistration = {
  status: 'registered',
  registrationRef: { ownerFeatureId: 'F192', ownerStateRef: 'eval-domain:eval:capability-evolution' },
  domainId: 'eval:capability-evolution',
  channels: ['event', 'quota', 'time'],
  policy: {
    mode: 'threshold_or_time',
    maxDetectionDelayHours: 168,
    cooldownHours: 24,
    eventSource: 'evolution-program-stream',
    threshold: { counter: 'connectedOwnerSurfaces', crossingAt: 2 },
  },
  nextEvaluationAt: '2026-09-06T03:00:00.000Z',
};
const sourceBindings = [
  {
    sourceKind: 'paw-feel-disposition',
    ownerSurfaceRef: { ownerFeatureId: 'F278', ownerStateRef: 'paw-feel:signal-1' },
    joinKey: 'message:message-1',
    namedConsumerRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-consumer:program' },
    instrumentationRef: { ownerFeatureId: 'F278', ownerStateRef: 'instrumentation:paw-feel-v1' },
  },
  {
    sourceKind: 'human-disposition',
    ownerSurfaceRef: { ownerFeatureId: 'F281', ownerStateRef: 'human-disposition:decision-1' },
    joinKey: 'subject:proposal-1',
    namedConsumerRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-consumer:program' },
    instrumentationRef: { ownerFeatureId: 'F281', ownerStateRef: 'instrumentation:human-disposition-v1' },
  },
];
const evidenceProofRefs = {
  decisionProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:proof-1' },
  evidenceRoleRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-role:observer-1' },
  consumptionProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-consumption:receipt-1' },
  optimizerExposureProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'optimizer-exposure:proof-1' },
  promotionHoldoutRef: { ownerFeatureId: 'F267', ownerStateRef: 'promotion-holdout:holdout-1' },
};

async function instrumentProgram(eventLog) {
  const service = new EvolutionProgramService({ eventLog });
  const created = await service.create({
    workspaceId: 'user:operator',
    targetRef: { ownerFeatureId: 'F202', ownerStateRef: 'skill:video-forge' },
    clientMessageId: 'create',
    actorRef: 'cat:codex-sol',
    originRef: 'thread:f311:message:create',
  });
  const programId = created.projection.program.programId;
  const ref = (kind) => ({
    ownerFeatureId: kind === 'goal' || kind === 'economic' ? 'F311' : 'F267',
    ownerStateRef: `${kind}:${programId}`,
  });
  await eventLog.append({
    schemaVersion: 1,
    eventId: 'evolution-event:constitution',
    programId,
    expectedSequence: 1,
    clientMessageId: 'constitution',
    actorRef: 'cat:codex-sol',
    originRef: 'thread:f311:message:constitution',
    occurredAt: '2026-08-31T22:00:00.000Z',
    event: {
      type: 'certificates_linked',
      certificates: { goal: ref('goal'), measurement: ref('measurement'), economic: ref('economic') },
      valueOwnerRef: ref('value-owner'),
      measurementRoleRefs: {
        observer: ref('observer'),
        domainOwner: ref('domain-owner'),
        consumer: ref('consumer'),
        calibrator: ref('calibrator'),
      },
    },
  });
  return programId;
}

function observationInput(programId, overrides = {}) {
  return {
    programId,
    expectedSequence: 2,
    clientMessageId: 'observe',
    actorRef: 'cat:codex-sol',
    originRef: 'thread:f311:message:observe',
    ownerUserId: 'operator',
    trajectoryRef: { ownerFeatureId: 'F299', ownerStateRef: 'inv:invocation-1' },
    sourceBindings,
    evidenceProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:proof-1' },
    ...overrides,
  };
}

async function appendCycleEvent(eventLog, programId, expectedSequence, event) {
  await eventLog.append({
    schemaVersion: 1,
    eventId: `evolution-event:cycle:${expectedSequence}`,
    programId,
    expectedSequence,
    clientMessageId: `cycle:${expectedSequence}`,
    actorRef: 'cat:codex-sol',
    originRef: `thread:f311:message:cycle:${expectedSequence}`,
    occurredAt: `2026-09-01T00:00:0${expectedSequence}.000Z`,
    event,
  });
}

describe('F311 observation service integration', () => {
  it('appends only validated refs, projects owner drilldowns, and dispatches through F192', async () => {
    const eventLog = new MemoryEventLog();
    const programId = await instrumentProgram(eventLog);
    const dispatched = [];
    const service = new EvolutionProgramService({
      eventLog,
      joinValidator: {
        validate: async () => ({
          status: 'ready',
          setup: {
            trajectory: {
              ref: { ownerFeatureId: 'F299', ownerStateRef: 'inv:invocation-1' },
              joinKey: 'thread:thread-owner',
            },
            sourceBindings,
            evidenceProofRefs,
          },
        }),
      },
      triggerRegistration: () => triggerRegistration,
      dispatchObservationTrigger: async (input) => {
        dispatched.push(input);
        return { outcome: 'dispatched' };
      },
    });

    const result = await service.linkObservation(observationInput(programId));
    assert.equal(result.outcome, 'appended');
    assert.equal(result.projection.program.stage, 'observing');
    assert.equal(result.projection.observation.status, 'connected');
    assert.equal(result.projection.observation.connectedEyes.length, 2);
    assert.equal(result.projection.observation.nextEvaluationAt, triggerRegistration.nextEvaluationAt);
    assert.equal(result.projection.observation.trajectory.invocationId, 'invocation-1');
    assert.equal(result.projection.observation.trajectory.threadId, 'thread-owner');
    assert.equal(result.projection.observation.connectedEyes[0].ownerHref, '/api/paw-feel/source/message-1');
    assert.equal(
      result.projection.observation.connectedEyes[1].ownerHref,
      '/api/human-disposition-feedback/episodes?subjectRef=proposal-1',
    );
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].previousConnectedOwnerSurfaces, 0);
    assert.equal(dispatched[0].currentConnectedOwnerSurfaces, 2);
    for (const forbidden of ['payload', 'episode', 'projection', 'decisionBody']) {
      assert.equal(JSON.stringify(await eventLog.read(programId)).includes(forbidden), false);
    }

    const listed = await service.list('user:operator');
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].observation.trigger, triggerRegistration);
    assert.equal(listed[0].observation.nextEvaluationAt, triggerRegistration.nextEvaluationAt);
    assert.equal(
      listed[0].observation.gaps.some((gap) => gap.code === 'trigger_registration_missing'),
      false,
    );
  });

  it('reports the previous connected-eye count when a later cycle links observation again', async () => {
    const eventLog = new MemoryEventLog();
    const programId = await instrumentProgram(eventLog);
    const dispatched = [];
    const service = new EvolutionProgramService({
      eventLog,
      joinValidator: {
        validate: async () => ({
          status: 'ready',
          setup: {
            trajectory: {
              ref: { ownerFeatureId: 'F299', ownerStateRef: 'inv:invocation-1' },
              joinKey: 'thread:thread-owner',
            },
            sourceBindings,
            evidenceProofRefs,
          },
        }),
      },
      triggerRegistration: () => triggerRegistration,
      dispatchObservationTrigger: async (input) => {
        dispatched.push(input);
        return { outcome: 'dispatched' };
      },
    });

    await service.linkObservation(observationInput(programId));
    await appendCycleEvent(eventLog, programId, 3, {
      type: 'evaluation_triggered',
      triggerReceiptRef: { ownerFeatureId: 'F192', ownerStateRef: 'trigger-receipt:1' },
      exposureProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'optimizer-exposure:1' },
    });
    await appendCycleEvent(eventLog, programId, 4, {
      type: 'measurement_linked',
      measurementResultRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-result:1' },
      validity: 'valid',
      reasonCodes: [],
      evidenceRefs: [],
      uncertaintyBasis: 'interval',
    });
    await appendCycleEvent(eventLog, programId, 5, {
      type: 'attribution_linked',
      attributionRef: { ownerFeatureId: 'F267', ownerStateRef: 'attribution:1' },
      disposition: 'no_intervention',
      diagnosis: {
        verdict: 'unresolved',
        assessedLayers: ['execution'],
        competingLayers: [],
        evidenceRefs: [{ ownerFeatureId: 'F267', ownerStateRef: 'measurement-result:1' }],
        uncertaintyBasis: 'interval',
        comparabilityMode: 'unchanged',
        comparabilityStatus: 'comparable',
        reasonCodes: ['no_discriminating_evidence'],
      },
    });
    await appendCycleEvent(eventLog, programId, 6, {
      type: 'decision_recorded',
      decision: 'tune',
      decisionRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-decision:1' },
    });

    const result = await service.linkObservation(
      observationInput(programId, { expectedSequence: 7, clientMessageId: 'observe-cycle-2' }),
    );
    assert.equal(result.outcome, 'appended');
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].previousConnectedOwnerSurfaces, 2);
    assert.equal(dispatched[1].currentConnectedOwnerSurfaces, 2);
  });

  it('returns typed insufficient without appending when the owner proof contract is missing', async () => {
    const eventLog = new MemoryEventLog();
    const programId = await instrumentProgram(eventLog);
    const blocker = {
      code: 'evidence_owner_contract_unavailable',
      ownerFeatureId: 'F267',
      ownerStateRef: 'measurement-proof:proof-1',
    };
    const service = new EvolutionProgramService({
      eventLog,
      joinValidator: { validate: async () => ({ status: 'insufficient', blockers: [blocker] }) },
      triggerRegistration: () => triggerRegistration,
    });

    const result = await service.linkObservation(observationInput(programId));
    assert.equal(result.outcome, 'insufficient');
    assert.deepEqual(result.blockers, [blocker]);
    assert.equal((await eventLog.read(programId)).length, 2);
    assert.equal(result.projection.program.stage, 'instrumenting');
    assert.ok(result.projection.observation.gaps.some((gap) => gap.code === blocker.code));
  });

  it('returns typed insufficient without appending when the F192 runtime trigger lane is unavailable', async () => {
    const eventLog = new MemoryEventLog();
    const programId = await instrumentProgram(eventLog);
    const service = new EvolutionProgramService({
      eventLog,
      joinValidator: {
        validate: async () => {
          throw new Error('join validation must not run without F192 registration');
        },
      },
      triggerRegistration: () => undefined,
    });

    const result = await service.linkObservation(observationInput(programId));
    assert.equal(result.outcome, 'insufficient');
    assert.deepEqual(result.blockers, [{ code: 'trigger_registration_missing', ownerFeatureId: 'F192' }]);
    assert.equal((await eventLog.read(programId)).length, 2);
    assert.equal(result.projection.program.stage, 'instrumenting');
  });
});
