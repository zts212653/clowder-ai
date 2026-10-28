import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { ActionSuccessorKeys } from '../dist/domains/ball-custody/action-successor-keys.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { RedisProposalStore } from '../dist/domains/cats/services/stores/redis/RedisProposalStore.js';
import { approvedTaskFixture, OWNER, TARGET, USER } from './helpers/approved-task-contract-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const SCOPE = {
  featureRef: 'feature:F167',
  phaseKey: 'S',
  workUnitRef: 'feature-phase:F167:S',
  acceptedSourceRef: 'file:docs/features/F167-a2a-chain-quality.md',
  acceptedRevision: 'a'.repeat(40),
};

function entrustedWork(scope) {
  return {
    revision: 1,
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:original'],
      idempotencyKey: 'original',
      receiptRef: 'task:receipt:original:1',
      admittedAt: 1,
    },
    intendedOutcome: 'Original repair',
    time: {},
    artifactRefs: [],
    closure: { condition: 'tested code', expectedSignal: 'terminal_report', state: 'open', evidenceRefs: [] },
    ...(scope ? { developmentScope: scope } : {}),
  };
}

async function assertDeniedWithoutWrites(f, overrides = {}, headers) {
  const before = await f.redis.hgetall(`proposal:${f.proposalId}`);
  const count = (await f.messages.getByThreadAfter(f.childId, undefined, undefined, USER)).length;
  const response = await f.continueTask(overrides, headers);
  assert.notEqual(response.statusCode, 200, response.body);
  assert.deepEqual(await f.redis.hgetall(`proposal:${f.proposalId}`), before);
  assert.equal((await f.messages.getByThreadAfter(f.childId, undefined, undefined, USER)).length, count);
  assert.equal((await f.queue.listAllDurable(f.childId)).length, 0);
  return response;
}

describe('approved Task continuation boundaries', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  test('concurrent requests have one winner and all same-key retries return its permanent receipt', async (t) => {
    const f = await approvedTaskFixture(t);
    const replies = await Promise.all(Array.from({ length: 6 }, () => f.continueTask()));
    const winners = replies.filter((r) => r.json().outcome === 'continued');
    assert.equal(winners.length, 1);
    const receipt = winners[0].json().receipt;
    for (const response of replies)
      assert.ok(
        ['continued', 'replayed', 'concurrent_change'].includes(response.json().reason ?? response.json().outcome),
        response.body,
      );
    for (let i = 0; i < 3; i++) assert.deepEqual((await f.continueTask()).json().receipt, receipt);
    assert.deepEqual((await new RedisProposalStore(f.redis).get(f.proposalId)).taskContractContinuation, receipt);
    assert.equal(await f.redis.ttl(`proposal:${f.proposalId}`), -1);
    await assertDeniedWithoutWrites(f, { clientRequestId: 'different-request' });
    await assertDeniedWithoutWrites(f, { taskId: 'other-task' });
  });

  test('callback auth and exact owner/thread/tenant are required; callers cannot supply authority', async (t) => {
    const f = await approvedTaskFixture(t);
    await assertDeniedWithoutWrites(f, {}, {});
    for (const [user, cat, thread] of [
      [USER, TARGET, f.source.id],
      [USER, OWNER, f.childId],
      ['foreign', OWNER, f.source.id],
    ]) {
      const auth = await f.registry.create(user, cat, thread);
      await assertDeniedWithoutWrites(
        f,
        {},
        { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      );
    }
    await assertDeniedWithoutWrites(f, { contractDigest: 'a'.repeat(64) });
    await assertDeniedWithoutWrites(f, { actor: { userId: USER, catId: OWNER, threadId: f.source.id } });
    await assertDeniedWithoutWrites(f, { developmentScope: SCOPE });
  });

  test('CAS rechecks live Task authority and child relation at receipt commit', async (t) => {
    const f = await approvedTaskFixture(t);
    const duplicate = f.redis.duplicate.bind(f.redis);
    let changed = false;
    f.redis.duplicate = (...args) => {
      const session = duplicate(...args);
      const multi = session.multi.bind(session);
      session.multi = (...multiArgs) => {
        const transaction = multi(...multiArgs);
        const exec = transaction.exec.bind(transaction);
        transaction.exec = async (...execArgs) => {
          if (!changed) {
            changed = true;
            await f.redis.hset(`task:${f.task.id}`, 'ownerCatId', 'new-owner');
          }
          return exec(...execArgs);
        };
        return transaction;
      };
      return session;
    };
    const result = await f.continueTask();
    assert.equal(result.json().reason, 'concurrent_change', result.body);
    assert.equal((await f.proposals.get(f.proposalId)).taskContractContinuation, undefined);
    assert.equal((await f.leases.listActiveTaskLeases()).length, 0);
  });

  test('removing a frozen approval contract cannot downgrade its receipt to a legacy approval', async (t) => {
    const f = await approvedTaskFixture(t, { legacy: false });
    assert.equal((await f.continueTask()).statusCode, 200);
    await f.redis.hdel(`proposal:${f.proposalId}`, 'approvedTaskContract');
    await assertDeniedWithoutWrites(f);
    assert.deepEqual(await f.delegates.getForTask(f.task.id, f.source.id, OWNER, USER, undefined, f.task.title), []);
  });

  test('revocation at native Task commit refuses the request and restart retires its original queued source', async (t) => {
    const f = await approvedTaskFixture(t);
    assert.equal((await f.continueTask()).statusCode, 200);
    const duplicate = f.redis.duplicate.bind(f.redis);
    let changed = false;
    f.redis.duplicate = (...args) => {
      const session = duplicate(...args);
      const multi = session.multi.bind(session);
      session.multi = (...multiArgs) => {
        const transaction = multi(...multiArgs);
        const exec = transaction.exec.bind(transaction);
        transaction.exec = async (...execArgs) => {
          if (!changed) {
            changed = true;
            await f.redis.hset(`task:${f.task.id}`, 'title', 'Changed at native Task CAS');
          }
          return exec(...execArgs);
        };
        return transaction;
      };
      return session;
    };
    const rejected = await f.implement();
    assert.equal(changed, true, 'the barrier must reach the actual Task commit');
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal((await f.leases.listActiveTaskLeases()).length, 0);
    const sourceId = rejected.json().messageId;
    assert.ok(sourceId, 'Message-first recovery keeps the refused request as durable evidence');
    assert.equal((await f.tasks.get(f.task.id)).lastAppliedHandoffMessageRef, undefined);
    let writers = 0;
    const processor = new QueueProcessor({
      queue: f.queue,
      messageStore: f.messages,
      taskStore: f.tasks,
      turnExecutionStore: f.turns,
      ordinaryTaskHandoffs: f.handoffs,
      invocationTracker: new InvocationTracker(),
      invocationRecordStore: {},
      router: {
        async resolveExplicitTargets(targets) {
          return targets;
        },
        async resolveConversationTargetsAtAdmission(targets) {
          return targets;
        },
        async ackCollectedCursors() {},
        async *routeExecution() {
          writers++;
          throw new Error('revoked work must never execute');
        },
      },
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      log: { info() {}, warn() {}, error() {} },
    });
    await processor.processNext(f.childId, USER);
    assert.equal(writers, 0);
    assert.equal(
      (await f.messages.getById(sourceId)).id,
      sourceId,
      'the original source stays readable as audit evidence',
    );
    assert.equal((await f.queue.listAllDurable(f.childId)).length, 0);
    assert.equal(
      (await f.messages.getByThreadAfter(f.childId, undefined, undefined, USER)).length,
      3,
      'the refused original source is retained',
    );
  });

  test('incomplete future generic approvals reject before claiming or creating a child', async (t) => {
    const f = await approvedTaskFixture(t);
    for (const missing of ['subjectTaskTitle', 'initialMessage']) {
      const original = await f.proposals.get(f.proposalId);
      const pending = await f.proposals.create({
        ...original,
        proposalId: `incomplete-${missing}`,
        sourceMessageId: 'source',
      });
      await f.proposals.commitEnvelope(pending.proposalId, {
        ...original.publication.envelope,
        canonicalProposalId: pending.proposalId,
        createdAt: pending.createdAt,
      });
      await f.redis.hdel(`proposal:${pending.proposalId}`, missing);
      const count = (await f.threads.getChildThreads(f.source.id)).length;
      const reply = await f.app.inject({
        method: 'POST',
        url: `/api/proposals/${pending.proposalId}/approve`,
        headers: { 'x-cat-cafe-user': USER },
        payload: {},
      });
      assert.equal(reply.statusCode, 400, reply.body);
      assert.equal((await f.proposals.get(pending.proposalId)).status, 'pending');
      assert.equal((await f.threads.getChildThreads(f.source.id)).length, count);
    }
  });

  const proposalDrifts = {
    title: 'Changed proposal',
    reason: 'Changed scope',
    initialMessage: 'Implement unrelated work',
    subjectTaskTitle: 'Other title',
    subjectTaskId: 'other-task',
    sourceCatId: TARGET,
    createdBy: 'foreign',
    approvedBy: 'foreign',
    approvedAt: '123',
    parentThreadId: 'other-parent',
    projectPath: '/other',
    reportingMode: 'none',
    declaredWorkMode: 'standalone',
    preferredCats: '["kimi"]',
    createdThreadId: 'other-child',
    status: 'withdrawn',
    approvedDevelopmentScope: JSON.stringify(SCOPE),
  };
  for (const [field, value] of Object.entries(proposalDrifts))
    test(`receipt rejects proposal ${field} drift`, async (t) => {
      const f = await approvedTaskFixture(t);
      assert.equal((await f.continueTask()).statusCode, 200);
      await f.redis.hset(`proposal:${f.proposalId}`, field, value);
      await assertDeniedWithoutWrites(f);
      assert.deepEqual(await f.delegates.getForTask(f.task.id, f.source.id, OWNER, USER, undefined, f.task.title), []);
    });

  for (const [field, value] of Object.entries({
    title: 'Changed Task',
    ownerCatId: 'kimi',
    threadId: 'new-owner-thread',
    userId: 'foreign',
    status: 'done',
    entrustedWork: JSON.stringify(entrustedWork(SCOPE)),
  })) {
    test(`receipt rejects current Task ${field} drift`, async (t) => {
      const f = await approvedTaskFixture(t);
      assert.equal((await f.continueTask()).statusCode, 200);
      await f.redis.hset(`task:${f.task.id}`, field, value);
      await assertDeniedWithoutWrites(f);
      const task = await f.tasks.get(f.task.id);
      if (task.status !== 'done')
        assert.deepEqual(
          await f.delegates.getForTask(
            task.id,
            task.threadId,
            task.ownerCatId,
            task.userId,
            task.entrustedWork?.developmentScope,
            task.title,
          ),
          [],
        );
    });
  }

  for (const [field, value] of Object.entries({
    createdFromProposalId: 'other-proposal',
    parentThreadId: 'other-parent',
    createdBy: 'foreign',
    deletedAt: '123',
    projectPath: '/other',
  }))
    test(`receipt rejects child ${field} drift`, async (t) => {
      const f = await approvedTaskFixture(t);
      assert.equal((await f.continueTask()).statusCode, 200);
      await f.redis.hset(`thread:${f.childId}`, field, value);
      await assertDeniedWithoutWrites(f);
      assert.deepEqual(await f.delegates.getForTask(f.task.id, f.source.id, OWNER, USER, undefined, f.task.title), []);
    });

  for (const [field, value] of Object.entries({
    approvedDevelopmentScope: '{broken',
    approvedTaskContract: '{}',
    taskContractContinuation: '{broken',
    preferredCats: '["codex-sol",7]',
    publication: '{broken',
  }))
    test(`corrupt ${field} never becomes a legacy generic approval`, async (t) => {
      const f = await approvedTaskFixture(t);
      await f.redis.hset(`proposal:${f.proposalId}`, field, value);
      await assertDeniedWithoutWrites(f);
      assert.equal(
        await f.redis.hget(`proposal:${f.proposalId}`, 'taskContractContinuation'),
        field === 'taskContractContinuation' ? value : null,
      );
    });

  for (const payload of [undefined, '', '{broken', null])
    test(`indexed implementation history fails closed: ${JSON.stringify(payload)}`, async (t) => {
      const f = await approvedTaskFixture(t);
      const subjectRef = `subject:task:${f.task.id}`;
      const claimed = await f.leases.claim({
        leaseId: 'prior-implementation',
        tenantScope: USER,
        subjectRef,
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        holderCatIds: [TARGET],
        holderThreadId: f.childId,
        dispatchId: 'prior-dispatch',
        claimOrigin: 'structured_transfer',
        predecessorCatId: OWNER,
        predecessorThreadId: f.source.id,
        issuerStandingEvidenceRef: 'message:prior',
        evidenceRefs: [`proposal:${f.proposalId}:approved:thread:${f.childId}:cat:${TARGET}`],
        terminalPredicate: canonicalizeActionTerminalPredicate({
          actionFamily: 'implement',
          subjectRef,
          predicate: { kind: 'task_done' },
        }),
        now: Date.now(),
      });
      if (payload === null) await f.redis.del(ActionSuccessorKeys.detail(claimed.lease.leaseId));
      else if (payload !== undefined) await f.redis.set(ActionSuccessorKeys.detail(claimed.lease.leaseId), payload);
      await assertDeniedWithoutWrites(f);
      // An old generation remains canonical history even if a later runtime no longer indexes it as current.
      await f.redis.del(ActionSuccessorKeys.identity(claimed.lease));
      await assertDeniedWithoutWrites(f);
    });
});
