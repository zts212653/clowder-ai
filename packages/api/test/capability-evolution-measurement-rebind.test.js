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

  async listProgramIds() {
    return [...this.events.keys()];
  }

  async ttl() {
    return -1;
  }
}

const owner = (ownerFeatureId, ownerStateRef) => ({ ownerFeatureId, ownerStateRef });
const oldMeasurement = owner('F267', 'measurement-certificate:proof-v1');
const valueOwner = owner('F311', 'user:operator');
const evidenceProofRef = owner('F267', 'measurement-proof:proof-v2');
const binding = {
  sourceRef: owner('F100', 'capability-evolution-measurement-source:evolution-program-test'),
  measurementCertificateRef: owner('F267', 'measurement-certificate:proof-v2'),
  measurementRoleRefs: {
    observer: owner('F267', 'measurement-role:proof-v2:observer'),
    domainOwner: owner('F267', 'measurement-role:proof-v2:domain_owner'),
    consumer: owner('F267', 'measurement-role:proof-v2:consumer'),
    calibrator: owner('F267', 'measurement-role:proof-v2:calibrator'),
  },
};

async function instrumentingProgram({ resolver } = {}) {
  const eventLog = new MemoryEventLog();
  const service = new EvolutionProgramService({
    eventLog,
    ...(resolver === undefined ? {} : { measurementConstitutionResolver: resolver }),
  });
  const created = await service.create({
    workspaceId: 'user:operator',
    targetRef: owner('F100', 'capability:development-process-harness-effectiveness'),
    clientMessageId: 'create-program',
    actorRef: 'cat:codex-sol',
    originRef: 'thread:f267:create-program',
  });
  const programId = created.projection.program.programId;
  const constituted = await service.linkCertificates({
    programId,
    expectedSequence: 1,
    clientMessageId: 'constitute-program',
    actorRef: 'cat:codex-sol',
    originRef: 'thread:f267:constitute-program',
    certificates: {
      goal: owner('F311', 'goal:program'),
      measurement: oldMeasurement,
      economic: owner('F311', 'economic:program'),
    },
    valueOwnerRef: valueOwner,
    measurementRoleRefs: {
      observer: owner('F267', 'measurement-role:proof-v1:observer'),
      domainOwner: owner('F267', 'measurement-role:proof-v1:domain_owner'),
      consumer: owner('F267', 'measurement-role:proof-v1:consumer'),
      calibrator: owner('F267', 'measurement-role:proof-v1:calibrator'),
    },
  });
  assert.equal(constituted.outcome, 'appended');
  return { eventLog, programId, service };
}

const rebind = (service, programId, overrides = {}) =>
  service.rebindMeasurementConstitution({
    programId,
    expectedSequence: 2,
    clientMessageId: 'rebind-measurement-v2',
    actorRef: 'cat:codex-sol',
    originRef: 'thread:f267:rebind-measurement-v2',
    ownerUserId: 'operator',
    evidenceProofRef,
    ...overrides,
  });

describe('F311 measurement constitution rebind', () => {
  it('derives one atomic certificate and four-role rebind from F267 owner truth', async () => {
    const requests = [];
    const { eventLog, programId, service } = await instrumentingProgram({
      resolver: {
        resolveMeasurementConstitution: async (input) => {
          requests.push(input);
          return { status: 'ready', binding };
        },
      },
    });

    const before = await service.get(programId);
    const result = await rebind(service, programId);

    assert.equal(result.outcome, 'appended');
    assert.equal(result.projection.program.sequence, 3);
    assert.equal(result.projection.program.stage, 'instrumenting');
    assert.equal(result.projection.program.cycle, before.program.cycle);
    assert.deepEqual(result.projection.program.valueOwnerRef, valueOwner);
    assert.deepEqual(result.projection.program.certificates, {
      ...before.program.certificates,
      measurement: binding.measurementCertificateRef,
    });
    assert.deepEqual(result.projection.program.measurementRoleRefs, binding.measurementRoleRefs);
    assert.deepEqual(requests, [{ ownerUserId: 'operator', program: before, evidenceProofRef }]);

    const events = await eventLog.read(programId);
    assert.deepEqual(events.at(-1).event, {
      type: 'measurement_constitution_rebound',
      sourceRef: binding.sourceRef,
      decisionProofRef: evidenceProofRef,
      measurementCertificateRef: binding.measurementCertificateRef,
      measurementRoleRefs: binding.measurementRoleRefs,
    });
  });

  it('fails closed without an owner resolver and does not append', async () => {
    const { eventLog, programId, service } = await instrumentingProgram();

    await assert.rejects(() => rebind(service, programId), /measurement constitution owner contract is not available/);
    assert.equal((await eventLog.read(programId)).length, 2);
  });

  it('rejects value-owner drift and a non-instrumenting Program before owner resolution', async () => {
    let calls = 0;
    const resolver = {
      resolveMeasurementConstitution: async () => {
        calls += 1;
        return { status: 'ready', binding };
      },
    };
    const { eventLog, programId, service } = await instrumentingProgram({ resolver });

    await assert.rejects(() => rebind(service, programId, { ownerUserId: 'other' }), /value owner mismatch/);
    assert.equal(calls, 0);

    await eventLog.append({
      schemaVersion: 1,
      eventId: 'event-observing',
      programId,
      expectedSequence: 2,
      clientMessageId: 'observe-program',
      actorRef: 'cat:codex-sol',
      originRef: 'thread:f267:observe-program',
      occurredAt: '2026-09-15T10:00:00.000Z',
      event: {
        type: 'sources_and_triggers_linked',
        sourceRefs: [owner('F100', 'source:one')],
        triggerRef: owner('F192', 'trigger:one'),
        namedConsumerRef: owner('F100', 'cat:opus'),
      },
    });
    await assert.rejects(
      () => rebind(service, programId, { expectedSequence: 3, clientMessageId: 'late-rebind' }),
      /active\/instrumenting/,
    );
    assert.equal(calls, 0);
    assert.equal((await eventLog.read(programId)).length, 3);
  });

  it('preserves exact idempotency and rejects one client id with different proof identity', async () => {
    const { programId, service } = await instrumentingProgram({
      resolver: {
        resolveMeasurementConstitution: async ({ evidenceProofRef: requestedProof }) => ({
          status: 'ready',
          binding:
            requestedProof.ownerStateRef === evidenceProofRef.ownerStateRef
              ? binding
              : {
                  ...binding,
                  measurementCertificateRef: owner('F267', 'measurement-certificate:other'),
                },
        }),
      },
    });
    assert.equal((await rebind(service, programId)).outcome, 'appended');
    assert.equal((await rebind(service, programId)).outcome, 'duplicate');
    await assert.rejects(
      () =>
        rebind(service, programId, {
          evidenceProofRef: owner('F267', 'measurement-proof:other'),
        }),
      /event identity was reused for different content/,
    );
  });
});
