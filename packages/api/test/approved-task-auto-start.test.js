import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ordinaryTaskExpectation } from '../dist/domains/cats/services/stores/ports/OrdinaryTaskMutation.js';
import { approvedTaskFixture, OWNER, TARGET, USER } from './helpers/approved-task-contract-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

test(
  'approving a new ordinary execution child queues its first native handoff and binds only at admission',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    const f = await approvedTaskFixture(t, { autoStart: true, legacy: false });
    const proposal = await f.proposals.get(f.proposalId);
    assert.ok(proposal.taskContractContinuation, 'approval must persist the continuation itself');
    assert.equal((await f.implement()).statusCode, 409, 'the approval owns its only first handoff');
    const entries = await f.queue.listAllDurable(f.childId);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    const seed = await f.messages.getById(entry.payload.messageId);
    assert.ok(seed.extra?.taskHandoff, 'the initial message must be the native handoff');
    assert.deepEqual(entry.targets, [TARGET]);
    assert.equal(seed.extra.taskHandoff.issuer.approval.proposalId, f.proposalId);
    assert.equal(seed.extra.taskHandoff.issuer.invocationId, undefined);
    assert.equal((await f.tasks.get(f.task.id)).executionRef, undefined);
    let binding;
    const parentInvocationId = 'admitted-parent';
    for await (const _event of invokeSingleCat(
      {
        registry: f.registry,
        messageStore: f.messages,
        turnExecutionStore: f.turns,
        ordinaryTaskHandoffs: f.handoffs,
        apiUrl: 'http://fixture.invalid',
        threadStore: null,
        sessionManager: {
          async get() {},
          async getOrCreate() {
            return {};
          },
          async store() {},
          async delete() {},
          resolveWorkingDirectory() {
            return process.cwd();
          },
        },
      },
      {
        catId: TARGET,
        threadId: f.childId,
        userId: USER,
        prompt: seed.content,
        isLastCat: true,
        parentInvocationId,
        executionCausal: { triggerMessageId: seed.id },
        service: {
          async *invoke(_prompt, options) {
            const task = await f.tasks.get(f.task.id);
            assert.equal(task.lastAppliedHandoffMessageRef, `message:${seed.id}`);
            binding = task.executionRef;
            assert.equal(binding.invocationId, options.callbackEnv.CAT_CAFE_INVOCATION_ID);
            yield { type: 'done', catId: TARGET, timestamp: Date.now() };
          },
        },
      },
    )) {
      // The production boundary is driven to provider initialization and terminal teardown.
    }
    assert.deepEqual(binding, {
      invocationId: binding?.invocationId,
      parentInvocationId,
      catId: TARGET,
      threadId: f.childId,
      sourceMessageId: seed.id,
    });
    const task = await f.tasks.get(f.task.id);
    assert.equal(task.threadId, f.source.id);
    assert.equal(task.ownerCatId, OWNER);
    assert.equal(task.lastAppliedHandoffMessageRef, `message:${seed.id}`);
    assert.equal(task.executionRef ?? null, null);
    assert.ok((await f.turns.get(binding.invocationId)).providerTeardownAt);

    const retry = await f.app.inject({
      method: 'POST',
      url: `/api/proposals/${f.proposalId}/approve`,
      headers: { 'x-cat-cafe-user': USER },
      payload: {},
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().threadId, f.childId);
    assert.equal((await f.queue.listAllDurable(f.childId)).length, 1);
    assert.equal(
      (await f.proposals.get(f.proposalId)).taskContractContinuation.receiptId,
      proposal.taskContractContinuation.receiptId,
    );
  },
);

const isolation = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };

test(
  'approval recovery reuses the reserved child and exact first handoff after lost write and admission replies',
  isolation,
  async (t) => {
    const f = await approvedTaskFixture(t, {
      autoStart: true,
      legacy: false,
      preferredCats: [TARGET, 'opus'],
      approvalBody: { pinned: true },
      async beforeApprove({ approve, threads, queue, proposalId, redis }) {
        const create = threads.ensureOwnedThread.bind(threads);
        let childId;
        threads.ensureOwnedThread = async (seed) => {
          const child = await create(seed);
          if (!childId) {
            childId = child.id;
            throw new Error('approval lost its first child write response');
          }
          assert.equal(child.id, childId);
          return child;
        };
        const send = queue.send.bind(queue);
        let failedSend = false;
        queue.send = async (...args) => {
          if (failedSend) return send(...args);
          failedSend = true;
          await send(...args);
          throw new Error('approval lost its first Queue admission response');
        };
        assert.equal((await approve()).statusCode, 500);
        await redis.hset(`proposal:${proposalId}`, 'claimedAt', String(Date.now() - 31_000));
        return approve();
      },
    });
    assert.equal((await f.threads.get(f.childId)).pinned, true);
    const retry = await f.approve();
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().threadId, f.childId);
    const children = await f.threads.getChildThreads(f.source.id);
    assert.deepEqual(
      children.map((thread) => thread.id),
      [f.childId],
    );
    const rows = await f.queue.listAllDurable(f.childId);
    assert.equal(rows.length, 1);
    const seed = await f.messages.getById(rows[0].payload.messageId);
    assert.deepEqual(seed.mentions, [TARGET]);
    assert.ok(seed.extra.taskHandoff);
  },
);

test(
  'a new handoff remains queued until its exact active predecessor has positive provider teardown',
  isolation,
  async (t) => {
    const f = await approvedTaskFixture(t, {
      autoStart: true,
      legacy: false,
      async beforeApprove({ approve, auth, tasks, task, origin, turns }) {
        const predecessor = await tasks.mutateOrdinaryTask({
          kind: 'update',
          taskId: task.id,
          expected: ordinaryTaskExpectation(task),
          actor: { userId: USER, catId: OWNER, threadId: task.threadId, invocationId: auth.invocationId },
          input: { status: 'doing' },
          execution: {
            invocationId: auth.invocationId,
            parentInvocationId: auth.invocationId,
            catId: OWNER,
            threadId: task.threadId,
            sourceMessageId: origin.id,
          },
        });
        assert.equal(predecessor.kind, 'updated');
        await turns.markProviderStarted(auth.invocationId, Date.now());
        return approve();
      },
    });
    const [entry] = await f.queue.listAllDurable(f.childId);
    const seedId = entry.payload.messageId;
    const attempt = await f.handoffs.apply(seedId);
    assert.equal(attempt.kind, 'waiting');
    const old = attempt.executionRef.invocationId;
    await f.turns.transitionTerminal(old, { status: 'succeeded', endedAt: Date.now() });
    assert.equal((await f.handoffs.apply(seedId)).kind, 'waiting');
    const drained = [];
    f.handoffs.deps.onExecutionReleased = async (threadId) => {
      drained.push(threadId);
    };
    await f.turns.recordProviderTeardown(old, Date.now());
    await f.handoffs.finish(f.task.id, old);
    assert.deepEqual(drained, [f.source.id, f.childId]);
    assert.equal((await f.handoffs.apply(seedId)).kind, 'applied');
  },
);

test(
  'ordinary terminal result preserves its evidence on recovery and does not wake the old implementation',
  isolation,
  async (t) => {
    const f = await approvedTaskFixture(t, { autoStart: true, legacy: false });
    const [entry] = await f.queue.listAllDurable(f.childId);
    const seedId = entry.payload.messageId;
    const auth = await f.registry.create(USER, TARGET, f.childId, undefined, seedId);
    const parentId = auth.invocationId;
    await f.turns.createRunning({
      invocationId: auth.invocationId,
      parentInvocationId: parentId,
      userId: USER,
      catId: TARGET,
      threadId: f.childId,
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    const actor = { userId: USER, catId: TARGET, threadId: f.childId, invocationId: auth.invocationId };
    await f.handoffs.start(seedId, actor, parentId);
    const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
    const completion = (resultMessageId) =>
      f.app.inject({
        method: 'POST',
        url: '/api/callbacks/update-task',
        headers,
        payload: { taskId: f.task.id, status: 'done', expectedOwnerRevision: 0, resultMessageId },
      });
    assert.equal((await completion()).statusCode, 409);
    assert.equal((await completion('missing')).statusCode, 409);
    const content = 'Verified on the approved entry point.';
    const attachment = { v: 1, id: 'result-evidence', kind: 'thread', threadId: f.childId, title: 'Verification' };
    const card = {
      v: 1,
      id: 'result-checks',
      kind: 'card',
      title: 'Checks passed',
      bodyMarkdown: 'Review the evidence.',
    };
    const posted = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers,
      payload: {
        content: `${content}\n\n\`\`\`cc_rich\n${JSON.stringify({ v: 1, blocks: [card] })}\n\`\`\``,
        contextAttachments: [attachment],
      },
    });
    assert.equal(posted.statusCode, 200, posted.body);
    const resultId = posted.json().messageId;
    const saved = await f.messages.getById(resultId);
    assert.deepEqual(saved.contentBlocks, [{ type: 'context_attachment', attachment }]);
    assert.deepEqual(saved.extra?.rich, { v: 1, blocks: [card] });
    assert.equal(saved.extra?.stream?.turnInvocationId, auth.invocationId);
    const originalSend = f.queue.send.bind(f.queue);
    let failedOnce = false;
    f.queue.send = async (...args) => {
      if (!failedOnce && args[1].threadId === f.source.id) {
        failedOnce = true;
        throw new Error('home publication interrupted after committing result');
      }
      return originalSend(...args);
    };
    assert.equal((await completion(resultId)).statusCode, 503);
    assert.equal((await f.tasks.get(f.task.id)).status, 'done');
    assert.equal((await f.tasks.get(f.task.id)).ordinaryFinalReport.messageId, resultId);
    const first = await completion(resultId);
    const retry = await completion(resultId);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().terminalReport.messageId, first.json().terminalReport.messageId);
    assert.equal(retry.json().terminalReport.clientMessageId, first.json().terminalReport.clientMessageId);
    const homeQueue = await f.queue.listAllDurable(f.source.id);
    assert.equal(homeQueue.length, 1);
    assert.deepEqual(homeQueue[0].targets, [OWNER]);
    const homeResult = await f.messages.getById(first.json().terminalReport.messageId);
    assert.equal(homeResult.content, content);
    assert.deepEqual(homeResult.contentBlocks, saved.contentBlocks);
    assert.deepEqual(homeResult.extra?.rich, saved.extra.rich);
    assert.deepEqual(homeResult.extra?.crossPost, { sourceThreadId: f.childId, sourceMessageId: resultId });
    assert.equal(homeResult.extra?.stream, undefined);
    const homeMessages = await f.messages.getByThread(f.source.id, 20, USER);
    assert.equal(homeMessages.filter((row) => row.extra?.crossPost?.sourceMessageId === resultId).length, 1);
    await assert.rejects(
      f.handoffs.start(seedId, { ...actor, invocationId: 'late-provider' }, 'late-parent'),
      /ordinary_task_unavailable/,
    );
  },
);

for (const drift of ['source withdrawn', 'owner ABA']) {
  test(`approved seed cannot bind after ${drift}`, isolation, async (t) => {
    const f = await approvedTaskFixture(t, { autoStart: true, legacy: false });
    const [entry] = await f.queue.listAllDurable(f.childId);
    if (drift === 'source withdrawn') {
      await f.messages.softDelete(f.origin.id, USER);
    } else {
      await f.tasks.update(f.task.id, { ownerCatId: TARGET });
      await f.tasks.update(f.task.id, { ownerCatId: OWNER });
      assert.equal((await f.tasks.get(f.task.id)).ownerRevision, 2);
    }
    const applied = await f.handoffs.apply(entry.payload.messageId);
    assert.equal(applied.kind, 'refused');
    assert.equal((await f.tasks.get(f.task.id)).executionRef, undefined);
  });
}

test('changing the execution card to read-only prevents automatic or direct implementation', isolation, async (t) => {
  const f = await approvedTaskFixture(t, {
    autoStart: true,
    legacy: false,
    approvalBody: { declaredWorkMode: 'investigation' },
  });
  const rows = await f.queue.listAllDurable(f.childId);
  const seed = await f.messages.getById(rows[0].payload.messageId);
  assert.equal(seed.extra?.taskHandoff, undefined);
  assert.equal((await f.proposals.get(f.proposalId)).taskContractContinuation, undefined);
  assert.equal((await f.implement()).statusCode, 409);
  assert.equal((await f.continueTask()).statusCode, 409);
  assert.equal((await f.tasks.get(f.task.id)).executionRef, undefined);
});

test('the exact manual issuer can add materials without taking the bound writer slot', isolation, async (t) => {
  const f = await approvedTaskFixture(t, { legacy: false });
  assert.equal((await f.continueTask()).statusCode, 200);
  const sent = await f.implement();
  assert.equal(sent.statusCode, 200);
  const sourceMessageId = sent.json().messageId;
  await f.handoffs.start(
    sourceMessageId,
    {
      userId: USER,
      catId: TARGET,
      threadId: f.childId,
      invocationId: 'current-writer',
    },
    'writer-parent',
  );
  const update = (payload) =>
    f.app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: f.headers,
      payload: { taskId: f.task.id, expectedOwnerRevision: 0, ...payload },
    });
  assert.equal((await update({ status: 'doing' })).statusCode, 409);
  const materials = await update({ why: 'Approved materials are ready in the original conversation.' });
  assert.equal(materials.statusCode, 200, materials.body);
  const { why, executionRef } = await f.tasks.get(f.task.id);
  assert.equal(why, 'Approved materials are ready in the original conversation.');
  assert.equal(executionRef.invocationId, 'current-writer');
});
