import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { ScheduleMutationProposalStore } from '../../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { templateRegistry } from '../../dist/infrastructure/scheduler/templates/registry.js';
import { scheduleRoutes } from '../../dist/routes/schedule.js';

const OWNER = 'owner-user';

describe('schedule mutation principal routing', () => {
  let app;
  let db;
  let dynamicStore;
  let proposalStore;
  let runner;
  let published;
  let previousOwnerUserId;

  beforeEach(async () => {
    previousOwnerUserId = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER;
    db = new Database(':memory:');
    applyMigrations(db);
    dynamicStore = new DynamicTaskStore(db);
    proposalStore = new ScheduleMutationProposalStore(db);
    runner = new TaskRunnerV2({
      logger: { info() {}, error() {} },
      ledger: new RunLedger(db),
      dynamicTaskStore: dynamicStore,
    });
    published = [];
    const approvalIngress = {
      async publish(draft, store) {
        published.push(draft);
        assert.equal(draft.producerId, 'F139');
        assert.ok(draft.cardBlock.id.includes(draft.canonicalProposalId));
        const envelope = {
          canonicalProposalId: draft.canonicalProposalId,
          sourceFeatureId: draft.producerId,
          ownerUserId: draft.ownerUserId,
          requesterCatId: draft.requesterCatId,
          originRef: draft.originRef,
          approvalCardRef: { threadId: draft.cardThreadId, messageId: `card-${draft.canonicalProposalId}` },
          createdAt: draft.createdAt,
        };
        store.commitEnvelope(draft.canonicalProposalId, envelope);
        return envelope;
      },
    };

    app = Fastify({ logger: false });
    app.decorateRequest('sessionUserId', undefined);
    app.decorateRequest('callbackPrincipal', undefined);
    app.decorateRequest('callbackAuth', undefined);
    app.addHook('preHandler', async (request) => {
      const principal = request.headers['x-test-principal'];
      if (principal === 'cvo') request.sessionUserId = OWNER;
      if (principal === 'cat') {
        const invocation = {
          kind: 'invocation',
          invocationId: 'inv-schedule-1',
          threadId: 'thread-owner',
          userId: OWNER,
          catId: 'codex-sol',
        };
        request.callbackPrincipal = invocation;
        request.callbackAuth = invocation;
      }
    });
    await app.register(scheduleRoutes, {
      taskRunner: runner,
      dynamicTaskStore: dynamicStore,
      templateRegistry,
      ownerUserId: OWNER,
      scheduleMutationProposalStore: proposalStore,
      approvalIngress,
    });
    await app.ready();
  });

  afterEach(async () => {
    runner.stop();
    await app.close();
    db.close();
    if (previousOwnerUserId === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwnerUserId;
  });

  it('rejects an unauthenticated create before any task or proposal write', async () => {
    const response = await createReminder();
    assert.equal(response.statusCode, 401);
    assert.equal(dynamicStore.getAll().length, 0);
    assert.equal(proposalStore.listPending(OWNER).length, 0);
    assert.equal(published.length, 0);
  });

  it('lets an authenticated operator create immediately and writes a direct audit', async () => {
    const response = await createReminder('cvo');
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.success, true);
    assert.equal(body.proposed, false);
    assert.equal(dynamicStore.getAll().length, 1);
    assert.equal(proposalStore.listPending(OWNER).length, 0);
    assert.equal(published.length, 0);
    assert.deepEqual(
      proposalStore.listAudit(OWNER).map(({ actorKind, actorId, action, taskId }) => ({
        actorKind,
        actorId,
        action,
        taskId,
      })),
      [{ actorKind: 'cvo', actorId: OWNER, action: 'create', taskId: body.task.id }],
    );
  });

  it('rejects a remote bootstrap session before a direct operator schedule mutation', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;

    const response = await app.inject({
      method: 'POST',
      url: '/api/schedule/tasks',
      headers: { 'x-test-principal': 'cvo' },
      remoteAddress: '203.0.113.10',
      payload: {
        templateId: 'reminder',
        trigger: { type: 'once', fireAt: Date.now() + 60_000 },
        params: { message: 'stretch' },
        deliveryThreadId: 'thread-owner',
      },
    });

    assert.equal(response.statusCode, 403);
    assert.match(response.json().error, /non-localhost.*DEFAULT_OWNER_USER_ID/);
    assert.equal(dynamicStore.getAll().length, 0);
    assert.equal(proposalStore.listAudit(OWNER).length, 0);
  });

  it('turns a verified cat create into an anchored proposal with zero scheduler effects', async () => {
    const response = await createReminder('cat');
    assert.equal(response.statusCode, 202);
    const body = response.json();
    assert.equal(body.success, true);
    assert.equal(body.proposed, true);
    assert.equal(dynamicStore.getAll().length, 0);
    assert.equal(runner.getTaskSummaries().length, 0);
    assert.equal(published.length, 1);

    const proposal = proposalStore.getById(body.proposalId);
    assert.equal(proposal?.status, 'pending');
    assert.equal(proposal?.publication.state, 'anchored');
    assert.equal(proposal?.mutation.kind, 'create');
    assert.equal(published[0].originRef.kind, 'event');
    assert.equal(published[0].originRef.threadId, 'thread-owner');
  });

  it('preserves a relative once delay on a cat proposal for approval-time rebasing', async () => {
    const response = await createReminder('cat', { type: 'once', delayMs: 600_000 });

    assert.equal(response.statusCode, 202);
    const proposal = proposalStore.getById(response.json().proposalId);
    assert.equal(proposal?.mutation.kind, 'create');
    assert.equal(proposal?.mutation.relativeOnceDelayMs, 600_000);
  });

  it('turns a verified cat delete into a fingerprint-bound proposal and preserves the task', async () => {
    const created = (await createReminder('cvo')).json();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/schedule/tasks/${created.task.id}`,
      headers: { 'x-test-principal': 'cat' },
    });

    assert.equal(response.statusCode, 202);
    const body = response.json();
    assert.equal(body.proposed, true);
    assert.ok(dynamicStore.getById(created.task.id));
    assert.equal(runner.getTaskSummaries().length, 1);
    const proposal = proposalStore.getById(body.proposalId);
    assert.equal(proposal?.mutation.kind, 'delete');
    assert.match(proposal?.mutation.expectedFingerprint ?? '', /^[a-f0-9]{64}$/);
  });

  it('lets an authenticated operator permanently delete immediately and writes a direct audit', async () => {
    const created = (await createReminder('cvo')).json();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/schedule/tasks/${created.task.id}`,
      headers: { 'x-test-principal': 'cvo' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().proposed, false);
    assert.equal(dynamicStore.getById(created.task.id), null);
    assert.equal(
      runner.getTaskSummaries().some((task) => task.id === created.task.id),
      false,
    );
    assert.deepEqual(
      proposalStore.listAudit(OWNER).map(({ actorKind, actorId, action, taskId }) => ({
        actorKind,
        actorId,
        action,
        taskId,
      })),
      [
        { actorKind: 'cvo', actorId: OWNER, action: 'create', taskId: created.task.id },
        { actorKind: 'cvo', actorId: OWNER, action: 'delete', taskId: created.task.id },
      ],
    );
  });

  it('keeps cat pause/resume direct under the strict principal and audits both effects', async () => {
    const created = (await createReminder('cvo')).json();
    for (const enabled of [false, true]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/schedule/tasks/${created.task.id}`,
        headers: { 'x-test-principal': 'cat' },
        payload: { enabled },
      });
      assert.equal(response.statusCode, 200);
    }
    assert.deepEqual(
      proposalStore.listAudit(OWNER).map((entry) => entry.action),
      ['create', 'pause', 'resume'],
    );
  });

  function createReminder(principal, trigger = { type: 'once', fireAt: Date.now() + 60_000 }) {
    return app.inject({
      method: 'POST',
      url: '/api/schedule/tasks',
      ...(principal ? { headers: { 'x-test-principal': principal } } : {}),
      payload: {
        templateId: 'reminder',
        trigger,
        params: { message: 'stretch' },
        deliveryThreadId: 'thread-owner',
      },
    });
  }
});
