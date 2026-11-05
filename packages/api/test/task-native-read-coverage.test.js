import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { taskReadCoverageFixture } from './helpers/task-read-coverage-fixture.js';

const owned = ownedRedisFixture('task-read-coverage');

async function assertTaskPending(f) {
  assert.deepEqual(
    (await f.queue.getDurableEntry(f.child.id, f.entry.id))?.targets,
    ['sonnet'],
    'full-body exposure must not retire the Task target before native admission',
  );
  assert.equal((await f.messages.getById(f.sourceId)).lifecycle?.dispatchRefs?.length ?? 0, 0);
  assert.equal((await f.tasks.get(f.task.id)).executionRef, undefined);
}

for (const backend of ['memory', 'redis']) {
  for (const surface of ['get-message', 'thread-context', 'prompt']) {
    test(`${backend}: ${surface} leaves Task pending for independent native start and lawful callback`, async (t) => {
      const f = await taskReadCoverageFixture(t, backend === 'redis' ? owned.client(`${randomUUID()}:`) : undefined);
      const ordinary = await f.addOrdinary();
      if (surface === 'prompt') {
        await f.processor.markPromptMessagesSeen({
          threadId: f.child.id,
          userId: 'native-user',
          catId: 'sonnet',
          invocationId: f.seed.invocationId,
          messageIds: [f.sourceId, ordinary.message.id],
          seenAt: Date.now(),
        });
      } else {
        const url =
          surface === 'get-message'
            ? `/api/callbacks/get-message?messageId=${f.sourceId}&mode=full&contextCount=10`
            : '/api/callbacks/thread-context?responseMode=full';
        const read = await f.readApp.inject({ method: 'GET', url, headers: f.headers });
        assert.equal(read.statusCode, 200, read.body);
        const body = read.json();
        const returned =
          surface === 'get-message' ? body.message : body.messages.find((item) => item.id === f.sourceId);
        assert.equal(returned.content, (await f.messages.getById(f.sourceId)).content);
      }
      await assertTaskPending(f);
      assert.deepEqual(
        (await f.messages.getById(f.response.id)).lifecycle.inputMessageIds,
        [ordinary.message.id],
        'ordinary public context still belongs to the reading seed',
      );
      const refused = await f.readApp.inject({
        method: 'POST',
        url: '/api/callbacks/update-task',
        headers: f.headers,
        payload: { taskId: f.task.id, status: 'doing', expectedOwnerRevision: 0 },
      });
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(
        (await f.processor.processNext(f.child.id, 'native-user')).started,
        false,
        'the still-live seed cannot overlap a Task writer',
      );
      await f.finishSeed();
      const restarted = await f.restart();
      assert.equal((await restarted.processor.processNext(f.child.id, 'native-user')).started, true);
      let timer;
      try {
        await Promise.race([
          f.providerEntered,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(JSON.stringify(f.errors))), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(f.executions.length, 1);
      const execution = f.executions[0];
      assert.equal(execution.statusCode, 200, execution.body);
      const native = await f.registry.getRecord(execution.binding.invocationId);
      assert.deepEqual(execution.binding, {
        invocationId: native.invocationId,
        parentInvocationId: native.parentInvocationId,
        catId: 'sonnet',
        threadId: f.child.id,
        sourceMessageId: f.sourceId,
      });
      assert.equal(native.a2aTriggerMessageId, f.sourceId);
      assert.notEqual(execution.binding.invocationId, f.seed.invocationId);
      assert.notEqual(execution.binding.parentInvocationId, 'seed-parent');
      assert.equal((await f.tasks.get(f.task.id)).status, 'doing');
      assert.equal(await restarted.queue.getDurableEntry(f.child.id, f.entry.id), null);
      assert.equal((await restarted.processor.processNext(f.child.id, 'native-user')).started, false);
      assert.deepEqual(f.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
      f.releaseProvider();
      await f.waitForIdle();
      assert.ok((await f.turns.get(execution.binding.invocationId)).providerTeardownAt);
    });
  }

  test(`${backend}: direct coverage and adoption cannot bypass Task admission; ordinary sibling stays pending`, async (t) => {
    const f = await taskReadCoverageFixture(t, backend === 'redis' ? owned.client(`${randomUUID()}:`) : undefined);
    const ordinary = await f.addOrdinary(['sonnet', 'gemini']);
    const input = {
      threadId: f.child.id,
      userId: 'native-user',
      targetId: 'sonnet',
      invocationId: f.seed.invocationId,
      responseMessageId: f.response.id,
      entries: [{ entryId: f.entry.id, messageId: f.sourceId }],
      at: Date.now(),
    };
    assert.equal((await f.queue.commitProjectedWakeCoverage(f.messages, input)).kind, 'conflict');
    assert.equal((await f.processor.adoptExposedQueuedEntries({ ...input, catId: 'sonnet' })).outcome, 'rejected');
    await assertTaskPending(f);
    const read = await f.readApp.inject({
      method: 'GET',
      url: '/api/callbacks/thread-context?responseMode=full',
      headers: f.headers,
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual((await f.queue.getDurableEntry(f.child.id, ordinary.entry.id)).targets, ['gemini']);
    assert.deepEqual((await f.queue.getDurableEntry(f.child.id, f.entry.id)).targets, ['sonnet']);
  });

  for (const condition of ['invalid', 'withdrawn', 'superseded']) {
    test(`${backend}: ${condition} Task source gains no execution authority from full reads`, async (t) => {
      const f = await taskReadCoverageFixture(t, backend === 'redis' ? owned.client(`${randomUUID()}:`) : undefined);
      if (condition === 'invalid') await f.messages.updateExtra(f.sourceId, { taskHandoffInvalid: true });
      if (condition === 'withdrawn') await f.messages.softDelete(f.sourceId, 'native-user');
      if (condition === 'superseded') {
        const successor = await f.send({ threadId: f.child.id, clientMessageId: 'superseding-task-source' });
        assert.equal(successor.statusCode, 200, successor.body);
      }
      const read = await f.readApp.inject({
        method: 'GET',
        url: '/api/callbacks/thread-context?responseMode=full',
        headers: f.headers,
      });
      assert.equal(read.statusCode, 200, read.body);
      await assertTaskPending(f);
      await assert.rejects(
        f.handoffs.start(
          f.sourceId,
          {
            userId: 'native-user',
            catId: 'sonnet',
            threadId: f.child.id,
            invocationId: 'unadmitted-reader',
          },
          'unadmitted-parent',
        ),
        /task_handoff_source_invalid|task_handoff_source_mismatch|task_assignment_changed/,
      );
      const review = await f.registry.create('native-user', 'sonnet', f.child.id, 'review-parent');
      await f.turns.createRunning({
        ...review,
        parentInvocationId: 'review-parent',
        userId: 'native-user',
        threadId: f.child.id,
        catId: 'sonnet',
        executionKind: 'ordinary',
        startedAt: Date.now(),
      });
      const denied = await f.readApp.inject({
        method: 'POST',
        url: '/api/callbacks/update-task',
        headers: { 'x-invocation-id': review.invocationId, 'x-callback-token': review.callbackToken },
        payload: { taskId: f.task.id, status: 'doing', expectedOwnerRevision: 0 },
      });
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal((await f.tasks.get(f.task.id)).executionRef, undefined);
    });
  }
}
