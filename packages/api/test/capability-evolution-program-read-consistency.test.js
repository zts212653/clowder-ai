import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { EvolutionProgramPreparationService } from '../dist/infrastructure/capability-evolution/program-preparation-service.js';
import { capabilityEvolutionProgramRoutes } from '../dist/routes/capability-evolution-program-routes.js';
import { EvolutionProgramService, MemoryEventLog } from './capability-evolution-evaluation.helper.mjs';

const registration = {
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
  nextEvaluationAt: '2026-09-13T03:00:00.000Z',
};

async function fixture(t, triggerRegistration) {
  const eventLog = new MemoryEventLog();
  const service = new EvolutionProgramService({ eventLog, triggerRegistration });
  const preparationService = new EvolutionProgramPreparationService({
    eventLog,
    projectProgram: (events) => service.project(events),
    dependencies: {
      messageStore: {},
      threadStore: {},
      invocationReader: { peekRecord: async () => null },
    },
  });
  const created = await service.create({
    workspaceId: 'user:operator',
    targetRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:read-consistency' },
    clientMessageId: 'read-consistency-create',
    actorRef: 'cat:codex-astra',
    originRef: 'thread:read-consistency:message:create',
  });
  const programId = created.projection.program.programId;
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'operator';
  });
  await app.register(capabilityEvolutionProgramRoutes, { service, preparationService });
  t.after(() => app.close());
  return {
    eventLog,
    programId,
    async read() {
      const list = await app.inject('/api/capability-evolution/programs');
      const detail = await app.inject(`/api/capability-evolution/programs/${encodeURIComponent(programId)}`);
      assert.equal(list.statusCode, 200);
      assert.equal(detail.statusCode, 200);
      return { summary: list.json().programs[0], detail: detail.json() };
    },
  };
}

test('exact preparation reads preserve the registered trigger and next evaluation from the canonical Program', async (t) => {
  const { read, eventLog, programId } = await fixture(t, () => registration);
  const before = await eventLog.read(programId);
  const { summary, detail } = await read();
  assert.equal(summary.preparation, undefined, 'the list remains lightweight');
  assert.equal(detail.preparation.sections.object_map.current, null);
  assert.deepEqual(detail.program, summary.program);
  assert.deepEqual(detail.observation, summary.observation);
  assert.equal(detail.observation.nextEvaluationAt, registration.nextEvaluationAt);
  assert.deepEqual(await eventLog.read(programId), before, 'reads must not append Program events');
});

test('both readers follow live trigger changes without requiring a new Program sequence', async (t) => {
  let current = registration;
  const { read } = await fixture(t, () => current);
  const initial = await read();
  current = { ...registration, nextEvaluationAt: '2026-09-14T03:00:00.000Z' };
  const changed = await read();
  assert.equal(changed.detail.program.sequence, initial.detail.program.sequence);
  assert.deepEqual(changed.detail.observation, changed.summary.observation);
  assert.equal(changed.detail.observation.nextEvaluationAt, current.nextEvaluationAt);
  current = undefined;
  const unavailable = await read();
  assert.deepEqual(unavailable.detail.observation, unavailable.summary.observation);
  assert.equal(unavailable.detail.observation.trigger, undefined);
  assert.ok(unavailable.detail.observation.gaps.some((gap) => gap.code === 'trigger_registration_missing'));
});

test('preparation does not invent a registered trigger when the canonical reader has none', async (t) => {
  const { read } = await fixture(t, () => undefined);
  const { summary, detail } = await read();
  assert.deepEqual(detail.observation, summary.observation);
  assert.equal(detail.observation.nextEvaluationAt, undefined);
  assert.ok(detail.observation.gaps.some((gap) => gap.code === 'trigger_registration_missing'));
});
