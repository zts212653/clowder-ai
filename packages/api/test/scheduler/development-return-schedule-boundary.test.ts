import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVELOPMENT_RETURN_TEMPLATE_ID } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../../src/infrastructure/scheduler/RunLedger.js';
import { ScheduleMutationProposalStore } from '../../src/infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { TaskRunnerV2 } from '../../src/infrastructure/scheduler/TaskRunnerV2.js';
import { scheduleRoutes } from '../../src/routes/schedule.js';

test('internal owner return is absent from public Schedule and cannot be forged, triggered, deleted or resumed there', async (t) => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  const db = new Database(':memory:');
  applyMigrations(db);
  const definitions = new DynamicTaskStore(db),
    runner = new TaskRunnerV2({
      ledger: new RunLedger(db),
      dynamicTaskStore: definitions,
      logger: { info() {}, error() {} },
    });
  const app = Fastify();
  t.after(async () => {
    runner.stop();
    await app.close();
    db.close();
  });
  const state = {
    v: 1,
    registrationId: 'private-return',
    ownerUserId: 'owner',
    ownerThreadId: 'original',
    ownerCatId: 'codex-sol',
    taskRef: 'task:work:private-task',
    observedRevision: 1,
    proposalId: 'proposal',
    executionThreadId: 'child',
    reporterCatIds: ['codex-sol'],
    sourceActionRef: 'message:source',
    sourceMessageRevision: `sha256:${'a'.repeat(64)}`,
    expectedSignal: 'terminal_report',
    registeredAt: Date.now(),
    slaUntil: Date.now() + 60000,
    status: 'waiting',
  };
  definitions.insert(
    {
      id: state.registrationId,
      templateId: DEVELOPMENT_RETURN_TEMPLATE_ID,
      trigger: { type: 'once', fireAt: state.slaUntil },
      params: {},
      display: { label: 'Private', category: 'system' },
      deliveryThreadId: state.ownerThreadId,
      createdBy: state.ownerCatId,
      createdAt: new Date().toISOString(),
      enabled: true,
    },
    'strict',
    state,
  );
  const spec = {
    id: state.registrationId,
    profile: 'awareness',
    trigger: { type: 'once', fireAt: state.slaUntil },
    admission: { gate: async () => ({ run: false, reason: 'not public' }) },
    run: {
      overlap: 'skip',
      timeoutMs: 1000,
      execute: async () => {
        throw new Error('Must not run through public Schedule');
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
  };
  runner.registerDynamic(spec, state.registrationId);
  const template = {
    templateId: DEVELOPMENT_RETURN_TEMPLATE_ID,
    label: 'Private',
    category: 'system',
    description: 'Private owner continuation',
    subjectKind: 'none',
    defaultTrigger: spec.trigger,
    paramSchema: {},
    createSpec: () => spec,
  };
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'owner';
  });
  await app.register(scheduleRoutes, {
    taskRunner: runner,
    dynamicTaskStore: definitions,
    templateRegistry: { get: () => template, list: () => [template] },
    ownerUserId: 'owner',
    scheduleMutationProposalStore: new ScheduleMutationProposalStore(db),
    approvalIngress: {
      async publish() {
        throw new Error('Private return cannot create a public mutation proposal');
      },
    },
  });
  assert.deepEqual((await app.inject('/api/schedule/tasks')).json().tasks, []);
  assert.deepEqual((await app.inject('/api/schedule/templates')).json().templates, []);
  assert.equal((await app.inject(`/api/schedule/tasks/${state.registrationId}/runs`)).statusCode, 404);
  for (const [method, suffix, payload] of [
    ['POST', '/trigger', {}],
    ['DELETE', '', undefined],
    ['PATCH', '', { enabled: true }],
  ]) {
    assert.equal(
      (await app.inject({ method, url: `/api/schedule/tasks/${state.registrationId}${suffix}`, payload })).statusCode,
      404,
    );
  }
  for (const url of ['/api/schedule/tasks', '/api/schedule/tasks/preview']) {
    assert.equal(
      (await app.inject({ method: 'POST', url, payload: { templateId: DEVELOPMENT_RETURN_TEMPLATE_ID } })).statusCode,
      409,
    );
  }
  assert.deepEqual(definitions.getPrivateExecutionReturn(state.registrationId), state);
});
