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
  const create = h.records.create.bind(h.records);
  h.records.create = async (input) => {
    const result = await create(input);
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
  assert.deepEqual(h.starts, []);
  assert.equal((await h.queue.getDurableEntry('thread', source.entry.id)).status, 'queued');
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
    h.processor.deps.router.routeExecution = async function* (...args) {
      if (args[1] === 'active') {
        bEnter();
        await bGate;
      }
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
    assert.deepEqual(h.starts, [], 'the revoked attempt cannot use consumed Stop evidence');
    assert.equal((await h.queue.getDurableEntry('thread', source.entry.id)).status, 'queued');
    assert.equal(aCreates, 1);
    bRelease();
    await waitFor(() => h.starts.includes('restored A') && h.starts.includes('active'));
    assert.equal(aCreates, 2, 'B handoff starts a fresh admission of the pending source');
    assert.deepEqual(h.starts, ['active', 'restored A']);
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
