import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { ExecutionAdmissionConflict } from '../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';
import { runDispatch, waitFor } from './helpers/issue1862-dispatch-fixture.js';

for (const [label, options] of [
  ['serial A2A', {}],
  ['parallel A2A', { parallel: true }],
  ['non-A2A', { agent: false }],
]) {
  test(`a claimed ${label} admission rejection settles exact History and Queue`, async (t) => {
    const { messages, source, entry, caller, target, sibling, threadId, queue, frames, processor, siblingLaunches } =
      await runDispatch(t, options);
    const failures = (await messages.getByThread(threadId)).filter(
      (message) => message.lifecycle?.kind === 'delivery_failure',
    );
    assert.equal(failures.length, 1, JSON.stringify(frames.filter((frame) => frame.type === 'error')));
    const [failure] = failures;
    assert.equal(failure.lifecycle.inputMessageId, source.id);
    assert.deepEqual(failure.lifecycle.requestedTargets, [target]);
    const refs = (await messages.getById(source.id)).lifecycle.dispatchRefs;
    const ref = refs.find((item) => item.targetId === target);
    assert.equal(ref.phase, 'settled');
    assert.equal(ref.statusMessageId, failure.id);
    if (options.parallel) {
      const response = await messages.getById(refs.find((item) => item.targetId === sibling).statusMessageId);
      assert.equal(response.lifecycle.status, 'completed');
      assert.equal(response.lifecycle.targetId, sibling);
      assert.equal(siblingLaunches, 1);
    }
    assert.equal(frames.filter((frame) => frame.type === 'error').length, 0);
    await processor.requestDrain(threadId);
    const rows = await queue.listAllDurable(threadId);
    assert.equal(
      rows.some((row) => row.id === entry.id),
      false,
    );
    const wakes = rows.filter((row) => row.sourceCategory === 'a2a_failure');
    if (options.agent === false) {
      assert.equal(wakes.length, 0);
      return;
    }
    assert.equal(wakes.length, 1);
    assert.deepEqual(wakes[0].targets, [caller]);
    assert.equal(wakes[0].payload.sourceRecordId, failure.id);
    assert.equal(wakes[0].payload.messageId, undefined, 'control work is not another History input');
    assert.equal(wakes[0].payload.content, '', 'the canonical History row owns the failure text');
  });
}

for (const parallel of [false, true]) {
  test(`a transient binding race keeps the unserved target retryable (parallel=${parallel})`, async (t) => {
    const {
      agents,
      messages,
      queue,
      router,
      processor,
      threadId,
      userId,
      entry,
      target,
      sibling,
      source,
      invocationTracker,
    } = await runDispatch(t, { retryable: true, parallel });
    await waitFor(async () => (await queue.getDurableEntry(threadId, entry.id))?.status === 'queued');
    assert.equal(
      (await messages.getByThread(threadId)).some((message) => message.lifecycle?.kind === 'delivery_failure'),
      false,
    );
    const rows = await queue.listAllDurable(threadId);
    assert.deepEqual(
      rows.map((row) => [row.id, row.status]),
      [[entry.id, 'queued']],
    );
    let launches = 0;
    const service = agents.get(target);
    service.captureInvocationOptions = () => ({});
    service.invoke = async function* () {
      launches++;
      yield { type: 'text', catId: target, content: 'Recovered recipient', timestamp: Date.now() };
      yield { type: 'done', catId: target, timestamp: Date.now() };
    };
    router.refreshFromRegistry(agents);
    await processor.processNext(threadId, userId);
    await waitFor(async () => !(await queue.getDurableEntry(threadId, entry.id)));
    await waitFor(() => !invocationTracker.getActiveSlots(threadId).some((slot) => slot.catId === target));
    assert.equal(launches, 1, 'the exact already-public source must reach its unserved recipient');
    if (parallel) {
      const history = await messages.getByThread(threadId);
      assert.equal(
        history.filter((row) => row.lifecycle?.kind === 'response' && row.lifecycle.targetId === sibling).length,
        1,
      );
      assert.equal(
        history.filter((row) => row.lifecycle?.kind === 'response' && row.lifecycle.inputMessageIds.includes(source.id))
          .length,
        2,
      );
    }
  });
}

test('the caller can retry its still-pending failure wake after a transient refusal', async (t) => {
  const { agents, queue, router, processor, threadId, userId, caller, invocationTracker } = await runDispatch(t);
  const [wake] = await queue.listAllDurable(threadId);
  const service = agents.get(caller);
  let captures = 0;
  let launches = 0;
  service.captureInvocationOptions = () => {
    captures++;
    throw new ExecutionAdmissionConflict('fixture: caller config refreshing', true);
  };
  router.refreshFromRegistry(agents);
  invocationTracker.complete(threadId, caller);
  await processor.processNext(threadId, userId);
  await waitFor(async () => captures === 2 && (await queue.getDurableEntry(threadId, wake.id))?.status === 'queued');
  service.captureInvocationOptions = () => ({});
  service.invoke = async function* () {
    launches++;
    yield { type: 'text', catId: caller, content: 'Caller read the failure', timestamp: Date.now() };
    yield { type: 'done', catId: caller, timestamp: Date.now() };
  };
  await processor.processNext(threadId, userId);
  await waitFor(
    async () => !(await queue.getDurableEntry(threadId, wake.id)) && !invocationTracker.has(threadId, caller),
  );
  assert.equal(launches, 1);
});

test('an A2A target retired after enqueue still settles the exact result and wake', async (t) => {
  const { messages, queue, source, entry, caller, target, threadId } = await runDispatch(t, { unavailable: true });
  const failures = (await messages.getByThread(threadId)).filter((row) => row.lifecycle?.kind === 'delivery_failure');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].lifecycle.reason, 'invalid_explicit_target');
  const ref = (await messages.getById(source.id)).lifecycle.dispatchRefs[0];
  assert.deepEqual([ref.targetId, ref.phase, ref.statusMessageId], [target, 'settled', failures[0].id]);
  assert.equal(await queue.getDurableEntry(threadId, entry.id), null);
  const rows = await queue.listAllDurable(threadId);
  assert.deepEqual(
    rows.map((row) => [row.sourceCategory, row.targets, row.payload.sourceRecordId]),
    [['a2a_failure', [caller], failures[0].id]],
  );
});

test('lost transaction acknowledgement projects the durable caller wake on the same worker', async (t) => {
  const f = await queueHttpFixture(t);
  const commit = f.messages.commitLifecyclePreAdmissionFailure.bind(f.messages);
  let lostAck = false;
  f.messages.commitLifecyclePreAdmissionFailure = (...args) => {
    const result = commit(...args);
    if (result.kind === 'applied' && !lostAck) {
      lostAck = true;
      throw new Error('fixture: transaction applied but acknowledgement lost');
    }
    return result;
  };
  const { queue, threadId, userId, processor, caller, entry } = await runDispatch(t, { f });
  assert.ok(lostAck);
  if (await queue.getDurableEntry(threadId, entry.id)) await processor.processNext(threadId, userId);
  const rows = await queue.listAllDurable(threadId);
  const [wake] = rows.filter((row) => row.sourceCategory === 'a2a_failure');
  assert.deepEqual(wake.targets, [caller]);
  assert.deepEqual(
    queue
      .listPendingAcrossUsers(threadId)
      .filter((row) => row.sourceCategory === 'a2a_failure')
      .map((row) => row.id),
    [wake.id],
  );
});

test('user cancellation during binding capture does not create failure or caller work', async (t) => {
  const { messages, queue, threadId } = await runDispatch(t, { cancel: true });
  assert.equal(
    (await messages.getByThread(threadId)).some((message) => message.lifecycle?.kind === 'delivery_failure'),
    false,
  );
  assert.equal(
    (await queue.listAllDurable(threadId)).some((row) => row.sourceCategory === 'a2a_failure'),
    false,
  );
});

test('two rejected recipients of one source each get one distinct result and caller wake', async (t) => {
  const { messages, queue, source, threadId, caller, target, sibling, siblingLaunches } = await runDispatch(t, {
    parallel: true,
    failSibling: true,
  });
  assert.equal(siblingLaunches, 0);
  const failures = (await messages.getByThread(threadId)).filter(
    (message) => message.lifecycle?.kind === 'delivery_failure',
  );
  assert.equal(failures.length, 2);
  const refs = (await messages.getById(source.id)).lifecycle.dispatchRefs;
  for (const recipient of [target, sibling]) {
    const result = failures.find((message) => message.lifecycle.requestedTargets[0] === recipient);
    assert.equal(refs.find((ref) => ref.targetId === recipient).statusMessageId, result.id);
  }
  const wakes = await queue.listAllDurable(threadId);
  assert.deepEqual(
    wakes.map((row) => row.targets),
    [[caller], [caller]],
  );
  assert.ok(wakes.every((row) => row.sourceCategory === 'a2a_failure'));
  assert.deepEqual(wakes.map((row) => row.payload.sourceRecordId).sort(), failures.map((message) => message.id).sort());
});

test('a replacement worker preserves a completed sibling and the one caller wake', async (t) => {
  const ledgerStore = new InMemoryQueueLedgerStore();
  const f = await queueHttpFixture(t, { ledgerStore });
  const { source, threadId, entry, caller, target, sibling, siblingLaunches } = await runDispatch(t, {
    f,
    parallel: true,
  });
  const replacement = new InvocationQueue(ledgerStore);
  await replacement.hydrateFromLedger(f.messages);
  const refs = (await f.messages.getById(source.id)).lifecycle.dispatchRefs;
  const failureId = refs.find((ref) => ref.targetId === target).statusMessageId;
  const siblingResult = await f.messages.getById(refs.find((ref) => ref.targetId === sibling).statusMessageId);
  assert.equal(siblingResult.lifecycle.status, 'completed');
  assert.equal(siblingLaunches, 1);
  assert.equal(await replacement.getDurableEntry(threadId, entry.id), null);
  assert.deepEqual(
    (await replacement.listAllDurable(threadId)).map((row) => [
      row.sourceCategory,
      row.targets,
      row.payload.sourceRecordId,
    ]),
    [['a2a_failure', [caller], failureId]],
  );
});
