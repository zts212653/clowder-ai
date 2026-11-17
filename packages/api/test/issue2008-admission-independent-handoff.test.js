import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendA2ASourceWithLedgerAdmission } from '../dist/routes/callback-a2a-trigger.js';
import { admissionFixture, enqueueUser, gateAttempt, socketFixture } from './helpers/stop-admission-fixture.js';
import { waitFor } from './helpers/stop-private-fixture.js';

test('#2008 independent work still starts while another admission waits for its record', async (t) => {
  const h = await admissionFixture(t);
  const first = await enqueueUser(h);
  const gate = gateAttempt(h, first, 'record');
  t.after(() => gate.release());
  const drain = h.processor.requestDrain('thread');
  await gate.waiting;
  // The gate blocks only its first create; independent admission keeps progressing.
  await enqueueUser(h, 'independent', ['gemini']);
  await h.processor.requestDrain('thread');
  await waitFor(() => h.starts.includes('independent'));
  assert.deepEqual(h.starts, ['independent']);
  gate.release();
  await drain;
});

test('#2008 Stop on an unreserved secondary revokes its admission and preserves a concurrent independent admission', async (t) => {
  const h = await admissionFixture(t);
  const stop = await socketFixture(t, h);
  let releaseA;
  let releaseB;
  const aGate = new Promise((resolve) => {
    releaseA = resolve;
  });
  const bGate = new Promise((resolve) => {
    releaseB = resolve;
  });
  const entered = [];
  const targetStarts = [];
  const route = h.processor.deps.router.routeExecution;
  h.processor.deps.router.routeExecution = async function* (...args) {
    targetStarts.push([...args[4]]);
    yield* route(...args);
  };
  let originalRecordId;
  const create = h.records.create.bind(h.records);
  h.records.create = async (input) => {
    const result = await create(input);
    if (input.targetCats.length === 2) originalRecordId = result.invocationId;
    entered.push([...input.targetCats]);
    if (input.targetCats.includes('opus') && entered.length <= 2) await aGate;
    if (input.targetCats.includes('sonnet')) await bGate;
    return result;
  };
  t.after(() => {
    releaseA();
    releaseB();
  });
  const source = await enqueueUser(h, 'multi A', ['opus', 'codex']);
  await h.processor.requestDrain('thread');
  await waitFor(() => entered.length === 1);
  await enqueueUser(h, 'independent B', ['sonnet']);
  await h.processor.requestDrain('thread');
  await waitFor(() => entered.length === 2);
  assert.equal(h.processor.hasProcessingSlotReservation('thread', 'opus'), true);
  assert.equal(h.processor.hasProcessingSlotReservation('thread', 'codex'), false);
  assert.equal(h.processor.hasProcessingSlotReservation('thread', 'sonnet'), true);
  const controller = await stop('codex', 'default-user');
  h.tracker.complete('thread', 'codex', controller);
  await h.processor.onInvocationComplete('thread', 'codex', 'canceled_by_user', 'new-stop');
  releaseA();
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'opus'));
  await waitFor(() => h.starts.includes('multi A'));
  assert.deepEqual(targetStarts[0], ['opus'], 'the untouched sibling progresses in a new subset');
  assert.equal(
    targetStarts.some((targets) => targets.length === 2),
    false,
    'the revoked full attempt never starts',
  );
  assert.equal((await h.records.get(originalRecordId)).status, 'queued');
  assert.equal(
    h.processor.hasProcessingSlotReservation('thread', 'sonnet'),
    true,
    'independent prestart B is retained',
  );
  releaseB();
  await waitFor(() => h.starts.includes('independent B'));
});

for (const targets of [['sonnet'], ['opus', 'codex']]) {
  test(`#2008 new durable handoff may schedule a fresh attempt after Stop revoked ${targets.join('/')}`, async (t) => {
    const h = await admissionFixture(t);
    const stop = await socketFixture(t, h);
    const source = await enqueueUser(h, 'restored A', targets);
    let aCreates = 0;
    const create = h.records.create.bind(h.records);
    h.records.create = async (input) => {
      if (input.targetCats.includes(targets[0])) aCreates += 1;
      return create(input);
    };
    const aGate = gateAttempt(h, source, 'record');
    t.after(() => aGate.release());
    const drain = h.processor.requestDrain('thread');
    await aGate.waiting;
    let bEnter;
    let bRelease;
    const bEntered = new Promise((resolve) => {
      bEnter = resolve;
    });
    const bGate = new Promise((resolve) => {
      bRelease = resolve;
    });
    const route = h.processor.deps.router.routeExecution;
    const aTargetStarts = [];
    h.processor.deps.router.routeExecution = async function* (...args) {
      if (args[1] === 'active') {
        bEnter();
        await bGate;
      }
      if (args[1] === 'restored A') aTargetStarts.push([...args[4]]);
      yield* route(...args);
    };
    t.after(() => bRelease());
    const stoppedTarget = targets.at(-1);
    const controller = await stop(stoppedTarget, 'default-user');
    h.tracker.complete('thread', stoppedTarget, controller);
    await h.processor.onInvocationComplete('thread', stoppedTarget, 'canceled_by_user', 'new-stop');
    assert.equal(h.processor.isAutoResumeSuppressed('thread', stoppedTarget), false);
    await enqueueUser(h, 'active', ['gemini']);
    aGate.release();
    await drain;
    await bEntered;
    await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', targets[0]));
    if (targets.length === 1) {
      assert.deepEqual(h.starts, [], 'the revoked target cannot use consumed Stop evidence');
      assert.equal((await h.queue.getDurableEntry('thread', source.entry.id)).status, 'queued');
      assert.equal(aCreates, 1);
    } else {
      await waitFor(() => aTargetStarts.length > 0);
      assert.deepEqual(aTargetStarts[0], ['opus'], 'D4 does not pause the untouched sibling');
    }
    bRelease();
    await waitFor(() => h.starts.includes('restored A') && h.starts.includes('active'));
    if (targets.length === 1) {
      assert.equal(aCreates, 2, 'B handoff starts a fresh admission of the pending source');
      assert.deepEqual(h.starts, ['active', 'restored A']);
    }
    assert.equal(
      aTargetStarts.every((targets) => targets.length === 1),
      true,
      'no revoked full-target admission runs',
    );
    assert.equal(h.tracker.has('thread', 'gemini'), true, 'B need not finish before independent A progresses');
  });
}

test('#2008 a rejected independent scan cannot skip the revoked attempt exact rollback', async (t) => {
  const h = await admissionFixture(t);
  const stop = await socketFixture(t, h);
  const source = await enqueueUser(h);
  const gate = gateAttempt(h, source, 'record');
  t.after(() => gate.release());
  await h.processor.requestDrain('thread');
  await gate.waiting;
  const controller = await stop('sonnet', 'default-user');
  h.tracker.complete('thread', 'sonnet', controller);
  await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-stop');
  await appendA2ASourceWithLedgerAdmission(
    { messageStore: h.messages, invocationQueue: h.queue },
    {
      userId: 'default-user',
      threadId: 'thread',
      from: { kind: 'agent', catId: 'opus' },
      content: 'unread independent',
      mentions: ['gemini'],
      timestamp: Date.now(),
    },
    {
      plan: { requestedTargetCats: ['gemini'], acceptedTargetCats: ['gemini'], streakTargetCats: ['gemini'] },
      ownerAuthProvenance: 'strict',
    },
  );
  const resolve = h.processor.deps.router.resolveExplicitTargets;
  h.processor.deps.router.resolveExplicitTargets = async (ids, ...args) => {
    if (ids.includes('gemini')) throw new Error('independent A2A admission read failed');
    return resolve(ids, ...args);
  };
  gate.release();
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'sonnet'));
  assert.deepEqual(h.starts, []);
  assert.equal((await h.queue.getDurableEntry('thread', source.entry.id)).status, 'queued');
});
