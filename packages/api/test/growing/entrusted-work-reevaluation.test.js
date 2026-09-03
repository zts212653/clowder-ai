import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { producerAttentionReevaluationLinkV1Schema } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { NeedsMeProducerCatalog } from '../../dist/domains/growing/NeedsMeProducerCatalog.js';
import {
  createProducerAttentionReevaluationTaskSpec,
  createProducerAttentionReevaluationTemplate,
  ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID,
  producerAttentionReevaluationTaskId,
} from '../../dist/domains/growing/ProducerAttentionReevaluationTaskSpec.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { ScheduleMutationProposalStore } from '../../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { scheduleRoutes } from '../../dist/routes/schedule.js';
import '../helpers/setup-cat-registry.js';

const now = 1_788_220_000_000;

function link(overrides = {}) {
  return {
    version: 1,
    ownerUserId: 'owner-1',
    taskRef: { subjectRef: 'task:work:ppt-1', observedRevision: 3 },
    producer: {
      producerId: 'f306.runtime_interaction',
      subjectRef: 'interaction-1',
      observedRevision: 17,
    },
    reEvaluateActionRef: 'interaction-1#reevaluate',
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    eligible: true,
    producer: {
      producerId: 'f306.runtime_interaction',
      ownerRef: 'interaction-1',
      subjectRef: 'interaction-1',
      revision: 17,
    },
    taskRef: { subjectRef: 'task:work:ppt-1', observedRevision: 3 },
    kind: 'judgment',
    reasonCode: 'runtime_interaction:question',
    recommendation: 'Choose the final visual direction',
    salience: 'normal',
    action: { actionRef: 'message:thread-1:card-1#question', expectedProducerRevision: 17 },
    reEvaluateActionRef: 'interaction-1#reevaluate',
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: 'ppt-1',
    kind: 'work',
    threadId: 'thread-1',
    subjectKey: 'entrusted:ppt-1',
    title: 'Prepare the real presentation',
    ownerCatId: 'codex-sol',
    status: 'doing',
    why: 'The user entrusted this work',
    createdBy: 'codex-sol',
    createdAt: now,
    updatedAt: now,
    userId: 'owner-1',
    entrustedWork: {
      revision: 3,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:source-1'],
        idempotencyKey: 'entrusted:source-1',
        receiptRef: 'task:receipt:ppt-1:1',
        admittedAt: now,
      },
      intendedOutcome: 'A reviewable presentation is ready',
      time: {
        businessDeadline: { value: now + 86_400_000, sourceRef: 'message:source-1' },
      },
      artifactRefs: ['artifact:ppt-1'],
      closure: {
        state: 'open',
        condition: 'The presentation is reviewable',
        expectedSignal: 'artifact:ppt-1:reviewable',
        evidenceRefs: [],
      },
    },
    ...overrides,
  };
}

function passiveAdapter(producerId) {
  return {
    producerId,
    async listCurrentReceipts() {
      return [];
    },
    async readCurrentReceipt() {
      return null;
    },
    async reEvaluate() {
      return { state: 'retired', producerRevision: null };
    },
  };
}

function catalogWith(primary) {
  const adapters = {
    'f246.approval': passiveAdapter('f246.approval'),
    'f292.repair': passiveAdapter('f292.repair'),
    'f306.runtime_interaction': passiveAdapter('f306.runtime_interaction'),
    [primary.producerId]: primary,
  };
  return new NeedsMeProducerCatalog(Object.values(adapters));
}

function definition(reevaluation) {
  return {
    id: producerAttentionReevaluationTaskId(reevaluation),
    templateId: ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID,
    trigger: { type: 'once', fireAt: now + 30_000 },
    params: {},
    entrustedWorkReevaluation: reevaluation,
    display: { label: 'Re-evaluate entrusted work', category: 'system' },
    deliveryThreadId: null,
    enabled: true,
    createdBy: 'codex-sol',
    createdAt: new Date(now).toISOString(),
  };
}

describe('F310 typed F139 producer re-evaluation', () => {
  test('the trigger persists exact Task and producer revisions with its canonical action', () => {
    const canonical = producerAttentionReevaluationLinkV1Schema.parse(link());
    assert.throws(
      () =>
        producerAttentionReevaluationLinkV1Schema.parse({
          ...link(),
          reEvaluateActionRef: 'interaction-other#reevaluate',
        }),
      /canonical producer action/u,
    );

    const db = new Database(':memory:');
    applyMigrations(db);
    const store = new DynamicTaskStore(db);
    store.insert(definition(canonical));
    assert.deepEqual(
      store.getById(producerAttentionReevaluationTaskId(canonical))?.entrustedWorkReevaluation,
      canonical,
    );
    db.close();
  });

  test('definition identity coalesces one producer-subject and Task pair while preserving distinct producers', () => {
    assert.equal(
      producerAttentionReevaluationTaskId(link()),
      producerAttentionReevaluationTaskId(
        link({
          taskRef: { subjectRef: 'task:work:ppt-1', observedRevision: 4 },
          producer: {
            producerId: 'f306.runtime_interaction',
            subjectRef: 'interaction-1',
            observedRevision: 18,
          },
        }),
      ),
    );
    assert.notEqual(
      producerAttentionReevaluationTaskId(link()),
      producerAttentionReevaluationTaskId(
        link({
          producer: {
            producerId: 'f292.repair',
            subjectRef: 'interaction-1',
            observedRevision: 17,
          },
        }),
      ),
    );
  });

  test('fire re-reads Task truth and invokes only the exact producer action before invalidating projections', async () => {
    const calls = [];
    const invalidations = [];
    const currentReceipt = receipt();
    const primary = {
      producerId: 'f306.runtime_interaction',
      async listCurrentReceipts() {
        return [currentReceipt];
      },
      async readCurrentReceipt() {
        return currentReceipt;
      },
      async reEvaluate(input) {
        calls.push(input);
        return { state: 'refreshed', producerRevision: 18 };
      },
    };
    const spec = createProducerAttentionReevaluationTaskSpec('reeval-1', {
      trigger: { type: 'once', fireAt: now + 30_000 },
      link: link(),
      tasks: { get: async () => task() },
      producerCatalog: catalogWith(primary),
      invalidateProjection: (ownerUserId) => invalidations.push(ownerUserId),
    });

    const admitted = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(admitted.run, true);
    assert.equal(admitted.workItems?.length, 1);
    await spec.run.execute(admitted.workItems[0].signal, admitted.workItems[0].subjectKey, {
      signal: new AbortController().signal,
      assignedCatId: null,
    });

    assert.deepEqual(calls, [
      {
        ownerUserId: 'owner-1',
        producerSubjectRef: 'interaction-1',
        expectedProducerRevision: 17,
        taskRef: { subjectRef: 'task:work:ppt-1', observedRevision: 3 },
        reEvaluateActionRef: 'interaction-1#reevaluate',
      },
    ]);
    assert.deepEqual(invalidations, ['owner-1']);
  });

  test('stale Task or producer revisions and terminal Task truth stay effect-inert', async () => {
    let actionCount = 0;
    const primary = {
      producerId: 'f306.runtime_interaction',
      async listCurrentReceipts() {
        return [receipt()];
      },
      async readCurrentReceipt() {
        return receipt();
      },
      async reEvaluate() {
        actionCount += 1;
        return { state: 'unchanged', producerRevision: 17 };
      },
    };

    for (const [name, taskValue, triggerLink] of [
      ['stale Task', task({ entrustedWork: { ...task().entrustedWork, revision: 4 } }), link()],
      ['stale producer', task(), link({ producer: { ...link().producer, observedRevision: 16 } })],
      [
        'terminal Task',
        task({
          status: 'done',
          entrustedWork: {
            ...task().entrustedWork,
            revision: 4,
            closure: { ...task().entrustedWork.closure, state: 'satisfied', evidenceRefs: ['artifact:ppt-1'] },
          },
        }),
        link(),
      ],
    ]) {
      const spec = createProducerAttentionReevaluationTaskSpec(`reeval-${name}`, {
        trigger: { type: 'once', fireAt: now + 30_000 },
        link: triggerLink,
        tasks: { get: async () => taskValue },
        producerCatalog: catalogWith(primary),
        invalidateProjection: () => assert.fail(`${name} must not invalidate projections`),
      });
      const admitted = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
      assert.deepEqual(admitted.run, false, name);
    }
    assert.equal(actionCount, 0);
  });

  test('the schedule boundary admits only the typed one-shot link and coalesces the same owner pair', async () => {
    const previousOwnerUserId = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
    const db = new Database(':memory:');
    applyMigrations(db);
    const dynamicTaskStore = new DynamicTaskStore(db);
    const registered = [];
    const template = createProducerAttentionReevaluationTemplate({
      tasks: { get: async () => task() },
      producerCatalog: catalogWith({
        producerId: 'f306.runtime_interaction',
        async listCurrentReceipts() {
          return [receipt()];
        },
        async readCurrentReceipt() {
          return receipt();
        },
        async reEvaluate() {
          return { state: 'unchanged', producerRevision: 17 };
        },
      }),
    });
    const app = Fastify();
    app.decorateRequest('sessionUserId', undefined);
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = 'owner-1';
    });
    await app.register(scheduleRoutes, {
      ownerUserId: 'owner-1',
      dynamicTaskStore,
      templateRegistry: {
        get: (id) => (id === template.templateId ? template : null),
        list: () => [template],
      },
      scheduleMutationProposalStore: new ScheduleMutationProposalStore(db),
      approvalIngress: { publish: async () => assert.fail('direct owner mutation must not publish approval') },
      taskRunner: {
        registerDynamic(spec) {
          registered.push(spec.id);
        },
        getRegisteredTasks: () => registered,
        getTaskSummaries: () => [],
        getLedger: () => ({ query: () => [], stats: () => ({ total: 0, delivered: 0, failed: 0, skipped: 0 }) }),
      },
    });

    const basePayload = {
      templateId: ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID,
      trigger: { type: 'once', fireAt: now + 30_000 },
      params: {},
    };
    const missing = await app.inject({ method: 'POST', url: '/api/schedule/tasks', payload: basePayload });
    assert.equal(missing.statusCode, 400);

    const opaqueBusinessTime = await app.inject({
      method: 'POST',
      url: '/api/schedule/tasks',
      payload: { ...basePayload, params: { reviewBy: now + 20_000 }, entrustedWorkReevaluation: link() },
    });
    assert.equal(opaqueBusinessTime.statusCode, 400);

    const first = await app.inject({
      method: 'POST',
      url: '/api/schedule/tasks',
      payload: { ...basePayload, entrustedWorkReevaluation: link() },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(dynamicTaskStore.getAll().length, 1);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/schedule/tasks',
      payload: {
        ...basePayload,
        trigger: { type: 'once', fireAt: now + 60_000 },
        entrustedWorkReevaluation: link({
          producer: { ...link().producer, observedRevision: 18 },
          taskRef: { ...link().taskRef, observedRevision: 4 },
        }),
      },
    });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().coalesced, true);
    assert.equal(dynamicTaskStore.getAll().length, 1);
    assert.equal(registered.length, 1);

    await app.close();
    db.close();
    if (previousOwnerUserId === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwnerUserId;
  });
});
