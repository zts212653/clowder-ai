import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { queueRoutes } from '../dist/routes/queue.js';
import { incidentFixture } from './helpers/alpha-browser-incident-fixture.js';

const DAY = 24 * 60 * 60_000;
function clock(t) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  return (ms = DAY + 1) => {
    now += ms;
  };
}
async function retire(f, state = 'delivered') {
  const [entry] = f.queue.list('gate-owner', 'owner');
  if (state === 'delivered') await f.messages.markDelivered(entry.payload.messageId, Date.now());
  if (state === 'canceled') await f.messages.markCanceled(entry.payload.messageId);
  await f.queue.terminalizeEntryDurable('gate-owner', 'owner', entry.id);
  return entry;
}

test('the real queue withdrawal route cannot wedge future Alpha revisions or resurrect the withdrawn wake', async (t) => {
  const advance = clock(t),
    f = incidentFixture(),
    app = Fastify();
  t.after(() => app.close());
  await app.register(queueRoutes, {
    threadStore: { get: async () => ({ id: 'gate-owner', createdBy: 'owner' }) },
    invocationQueue: f.queue,
    messageStore: f.messages,
    queueProcessor: { registerCallerDispatchQueueWithdrawal() {}, unregisterEntryCompleteHook() {} },
    invocationTracker: {},
    socketManager: { emitToUser() {}, broadcastToRoom() {} },
  });
  await f.run();
  const [entry] = f.queue.list('gate-owner', 'owner');
  const response = await app.inject({
    method: 'DELETE',
    url: `/api/threads/gate-owner/queue/${entry.id}`,
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.messages.getById(entry.payload.messageId).deliveryStatus, 'canceled');
  for (let i = 0; i < 5; i++) {
    advance();
    f.next();
    await f.run();
  }
  assert.equal(f.tasks.listByThread('gate-owner').length, 1);
  assert.equal(f.queue.list('gate-owner', 'owner').length, 0, 'withdrawal stays effective across days');
});

test('withdrawal racing a retry is acknowledged without changing the Task or blocking settlement', async () => {
  const f = incidentFixture();
  await f.run();
  const deliver = f.context.deliver;
  f.context.deliver = async (input) => {
    await retire(f, 'canceled');
    return deliver(input);
  };
  f.next();
  await f.run();
  assert.equal(f.queue.list('gate-owner', 'owner').length, 0);
  assert.equal(f.tasks.listByThread('gate-owner').length, 1);
});

for (const outcome of ['pre-admission failure', 'missing carrier', 'delivered without repair progress']) {
  test(`${outcome} recovers the original open Task at most once per day`, async (t) => {
    const advance = clock(t),
      f = incidentFixture();
    await f.run();
    const [first] = f.queue.list('gate-owner', 'owner');
    if (outcome === 'pre-admission failure') {
      const failure = f.messages.commitLifecyclePreAdmissionFailure({
        sourceMessageId: first.payload.messageId,
        expectedEntryId: first.id,
        requestedTargets: ['fixture-cat'],
        reason: 'invalid_explicit_target',
        content: 'fixture execution binding unavailable',
        failedAt: Date.now(),
      });
      assert.equal(failure.kind, 'applied');
      assert.equal(failure.inputMessage.deliveryStatus, 'delivered');
    }
    await retire(f, outcome === 'delivered without repair progress' ? 'delivered' : 'unchanged');
    for (let i = 0; i < 3; i++) {
      f.next();
      await f.run();
    }
    assert.equal(f.queue.list('gate-owner', 'owner').length, 0);
    advance();
    f.next();
    await f.run();
    const [retry] = f.queue.list('gate-owner', 'owner');
    assert.ok(retry, 'unhandled repair must return after the bounded interval');
    assert.notEqual(retry.payload.messageId, first.payload.messageId);
    await retire(f);
    for (let i = 0; i < 3; i++) {
      f.next();
      await f.run();
    }
    assert.equal(f.queue.list('gate-owner', 'owner').length, 0, 'same day does not create more wakes');
    advance();
    f.next();
    await f.run();
    assert.equal(f.queue.list('gate-owner', 'owner').length, 1);
    assert.equal(f.tasks.listByThread('gate-owner').length, 1);
  });
}

test('recent author progress and a blocked task each prevent stale-work reminders', async (t) => {
  const advance = clock(t),
    f = incidentFixture();
  await f.run();
  await retire(f);
  advance();
  const [task] = f.tasks.listByThread('gate-owner');
  f.tasks.update(task.id, { status: 'doing', why: 'new repair evidence just recorded' });
  f.next();
  await f.run();
  assert.equal(f.queue.list('gate-owner', 'owner').length, 0);
  f.tasks.update(task.id, { status: 'blocked', why: 'waiting for a committed deployment' });
  advance();
  f.next();
  await f.run();
  assert.equal(f.queue.list('gate-owner', 'owner').length, 0);
});

test('an old but still queued wake is not duplicated by the stale-work timer', async (t) => {
  const advance = clock(t),
    f = incidentFixture();
  await f.run();
  const [entry] = f.queue.list('gate-owner', 'owner');
  advance();
  f.next();
  await f.run();
  assert.deepEqual(
    f.queue.list('gate-owner', 'owner').map((e) => e.id),
    [entry.id],
  );
});

for (const status of ['processing', 'canceled']) {
  test(`a ${status} invocation is not reawakened by a stale repair Task`, async (t) => {
    const advance = clock(t),
      f = incidentFixture();
    await f.run();
    const entry = await retire(f);
    const source = f.messages.getById(entry.payload.messageId);
    const response = f.messages.append({
      from: { kind: 'agent', catId: 'fixture-cat' },
      userId: 'owner',
      threadId: 'gate-owner',
      content: 'repair response',
      mentions: [],
      timestamp: Date.now(),
      lifecycle: {
        kind: 'response',
        orderKey: `${Date.now()}:response`,
        invocationId: 'repair-invocation',
        targetId: 'fixture-cat',
        inputEntryIds: [entry.id],
        inputMessageIds: [source.id],
        status,
        startedAt: Date.now(),
        ...(status === 'canceled' ? { completedAt: Date.now() } : {}),
      },
    });
    const patch = {
      orderKey: source.lifecycle?.orderKey ?? `${Date.now()}:${source.id}`,
      targetId: 'fixture-cat',
      statusMessageId: response.id,
      phase: 'dispatched',
      dispatchedAt: Date.now(),
    };
    assert.equal(f.messages.advanceLifecycleInputDispatch(source.id, patch).kind, 'applied');
    if (status === 'canceled')
      assert.equal(f.messages.advanceLifecycleInputDispatch(source.id, { ...patch, phase: 'settled' }).kind, 'applied');
    advance(2 * DAY);
    f.next();
    await f.run();
    assert.equal(f.queue.list('gate-owner', 'owner').length, 0);
  });
}
