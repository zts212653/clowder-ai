import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';

test('terminal report and timeout wake the original owner once, retaining the canonical Task identity', async (t) => {
  const f = await fixture(t);
  const registration = await f.service.register(f.actor, f.input, 'strict');
  assert.equal(
    (await f.service.register(f.actor, { ...f.input }, 'strict')).registrationId,
    registration.registrationId,
  );
  assert.equal(
    (await f.service.register({ ...f.actor, invocationId: 'next' }, f.input, 'strict')).registrationId,
    registration.registrationId,
  );
  const message = f.report();
  const report = { sourceMessageId: message.id, outcome: 'completed', evidenceRefs: ['artifact:published'] };
  await f.service.report({ ...f.actor, threadId: f.child.id }, registration.registrationId, report);
  f.tick(20000);
  await f.runner.triggerNow(registration.registrationId);
  await f.service.report({ ...f.actor, threadId: f.child.id }, registration.registrationId, report);
  assert.equal(f.wakes.length, 1);
  assert.equal(f.wakes[0][0], f.actor.threadId);
  assert.equal(f.wakes[0][1], f.actor.catId);
  const wakeMessage = f.messages.getById(f.wakes[0][4]);
  assert.equal(
    wakeMessage?.queueCustody?.sourceCategory,
    'producer_return',
    'development-return producer must classify its wake',
  );
  assert.equal(f.tasks.get(f.input.taskId).threadId, f.actor.threadId);
  assert.equal(f.tasks.get(f.input.taskId).entrustedWork.revision, 1, 'waking never updates or completes Task');
  assert.equal(f.service.read(registration.registrationId).status, 'delivered');
});

test('execution cannot register for the original owner or read its Task projection', async (t) => {
  const f = await fixture(t),
    childActor = { ...f.actor, threadId: f.child.id };
  await assert.rejects(f.service.register(childActor, f.input, 'strict'));
  const state = await f.service.register(f.actor, f.input, 'strict');
  const view = f.service.readForActor(childActor, state.registrationId);
  assert.equal(JSON.stringify(view).includes(f.input.taskId), false);
  assert.deepEqual(f.service.readForActor({ ...childActor, userId: 'other' }, state.registrationId), []);
});

test('deadline only requests one fact review; closed Task retires the stale registration', async (t) => {
  const f = await fixture(t),
    state = await f.service.register(f.actor, f.input, 'strict');
  f.tick(20000);
  await f.runner.triggerNow(state.registrationId);
  assert.equal(f.wakes.length, 1);
  assert.match(f.wakes[0][3], /deadline_review/);
  const late = await f.service.report({ ...f.actor, threadId: f.child.id }, state.registrationId, {
    sourceMessageId: f.report().id,
    outcome: 'completed',
    evidenceRefs: ['artifact:late'],
  });
  assert.equal(
    late.status,
    'requires_owner_successor',
    'a timeout wake cannot claim that a later final report was delivered',
  );
  assert.equal(f.tasks.get(f.input.taskId).status, 'todo');
  const g = await fixture(t),
    stale = await g.service.register(g.actor, g.input, 'strict');
  g.tasks.closeEntrustedWork(g.input.taskId, {
    expectedRevision: 1,
    closure: {
      state: 'satisfied',
      condition: 'Verified',
      expectedSignal: 'verified',
      evidenceRefs: ['artifact:accepted'],
    },
  });
  g.tick(20000);
  await g.runner.triggerNow(stale.registrationId);
  assert.equal(g.wakes.length, 0);
  assert.equal(g.service.read(stale.registrationId).status, 'retired');
});

test('overdue registered return is hydrated for fact review instead of being discarded on restart', async (t) => {
  const f = await fixture(t),
    state = await f.service.register(f.actor, f.input, 'strict');
  f.runner.unregister(state.registrationId);
  f.definitions.updateTrigger(state.registrationId, { type: 'once', fireAt: Date.now() - 1000 });
  const loaded = f.runner.hydrateDynamic(f.definitions, { get: () => f.service.template });
  assert.equal(loaded, 1);
  assert.ok(f.service.read(state.registrationId));
});

test('a terminal report advances the durable trigger and queue rejection retains one retryable wake', async (t) => {
  const f = await fixture(t),
    state = await f.service.register(f.actor, f.input, 'strict');
  f.setQueueFull(true);
  const report = { sourceMessageId: f.report().id, outcome: 'completed', evidenceRefs: ['artifact:published'] };
  await f.service.report({ ...f.actor, threadId: f.child.id }, state.registrationId, report);
  assert.ok(f.definitions.getById(state.registrationId).trigger.fireAt < f.input.slaUntil);
  assert.equal(f.service.read(state.registrationId).status, 'delivering');
  assert.equal(f.wakes.length, 0);
  f.setQueueFull(false);
  await f.runner.triggerNow(state.registrationId);
  assert.equal(f.deliveries.size, 1);
  assert.equal(f.wakes.length, 1);
});

test('aborted execution or deleted owner thread cannot dispatch a stale wake', async (t) => {
  const f = await fixture(t),
    state = await f.service.register(f.actor, f.input, 'strict');
  f.tick(20000);
  await assert.rejects(
    f.service.execute(state.registrationId, {
      assignedCatId: null,
      signal: AbortSignal.abort(new Error('aborted')),
    }),
    /aborted/,
  );
  assert.equal(f.wakes.length, 0);
  f.threads.softDelete(f.actor.threadId);
  await f.service.execute(state.registrationId, { assignedCatId: null, signal: new AbortController().signal });
  assert.equal(f.wakes.length, 0);
  assert.equal(f.service.read(state.registrationId).reason, 'owner_changed');
});

test('real once timer retries a rejected queue and retires after one durable owner wake', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  const f = await fixture(t),
    state = await f.service.register(f.actor, f.input, 'strict');
  const advance = async (ms) => {
    f.tick(ms);
    t.mock.timers.tick(ms);
    await nextTurn();
    t.mock.timers.tick(0);
    await nextTurn();
  };
  f.setQueueFull(true);
  f.runner.start();
  await advance(10000);
  assert.equal(f.service.read(state.registrationId).status, 'delivering');
  assert.equal(f.definitions.getById(state.registrationId).enabled, true);
  f.setQueueFull(false);
  await advance(30000);
  assert.equal(f.service.read(state.registrationId).status, 'delivered');
  assert.equal(f.wakes.length, 1);
  assert.equal(f.deliveries.size, 1);
  assert.equal(f.runner.getRegisteredTasks().includes(state.registrationId), false);
  assert.equal(f.definitions.getById(state.registrationId).enabled, false);
  assert.equal(f.tasks.get(f.input.taskId).status, 'todo');
});

test('exhausted timer retries retain failure evidence and do not claim work cancellation or completion', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  const f = await fixture(t),
    state = await f.service.register(f.actor, f.input, 'strict');
  const advance = async (ms) => {
    f.tick(ms);
    t.mock.timers.tick(ms);
    await nextTurn();
    t.mock.timers.tick(0);
    await nextTurn();
  };
  f.setQueueFull(true);
  f.runner.start();
  await advance(10000);
  for (let attempt = 0; attempt < 10; attempt++) await advance(30000);
  const final = f.service.read(state.registrationId);
  assert.equal(final.status, 'retired');
  assert.equal(final.reason, 'delivery_failed');
  assert.equal(f.wakes.length, 0);
  assert.equal(f.deliveries.size, 0);
  assert.equal(f.runner.getRegisteredTasks().includes(state.registrationId), false);
  assert.equal(f.tasks.get(f.input.taskId).status, 'todo');
});

for (const revoked of ['human-source', 'execution-thread', 'terminal-report']) {
  test(`pending return stops when ${revoked} is withdrawn`, async (t) => {
    const f = await fixture(t),
      state = await f.service.register(f.actor, f.input, 'strict');
    f.setQueueFull(true);
    const message = f.report();
    await f.service.report({ ...f.actor, threadId: f.child.id }, state.registrationId, {
      sourceMessageId: message.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:real'],
    });
    if (revoked === 'human-source') f.messages.softDelete(f.input.sourceActionRef.slice('message:'.length), 'human');
    if (revoked === 'execution-thread') f.threads.softDelete(f.child.id);
    if (revoked === 'terminal-report') f.messages.softDelete(message.id, 'human');
    f.setQueueFull(false);
    await f.runner.triggerNow(state.registrationId);
    assert.equal(f.wakes.length, 0);
    assert.equal(f.service.read(state.registrationId).status, 'retired');
  });
}

test('a crash after Dispatch acceptance reuses the original durable carrier and invocation', async (t) => {
  const f = await fixture(t),
    state = await f.service.register(f.actor, f.input, 'strict');
  const replace = f.definitions.replacePrivateExecutionReturn.bind(f.definitions);
  let crash = true;
  f.definitions.replacePrivateExecutionReturn = (id, current, next) => {
    if (next.status === 'delivered' && crash) {
      crash = false;
      throw new Error('crash after durable admission');
    }
    return replace(id, current, next);
  };
  await f.service.report({ ...f.actor, threadId: f.child.id }, state.registrationId, {
    sourceMessageId: f.report().id,
    outcome: 'completed',
    evidenceRefs: ['artifact:real'],
  });
  assert.equal(f.service.read(state.registrationId).status, 'delivering');
  assert.equal(f.transport.records.size, 1);
  await f.runner.triggerNow(state.registrationId);
  assert.equal(f.service.read(state.registrationId).status, 'delivered');
  assert.equal(f.transport.records.size, 1);
  assert.equal(f.wakes.length, 1);
});

test('the owner can discover its return and explicitly register one successor without fabricating Task progress', async (t) => {
  const f = await fixture(t),
    first = await f.service.register(f.actor, f.input, 'strict');
  assert.equal(f.service.readForActor(f.actor).length, 1);
  const continuation = {
    ...f.input,
    predecessorRegistrationId: first.registrationId,
    slaUntil: f.input.slaUntil + 30000,
  };
  await assert.rejects(f.service.register(f.actor, continuation, 'strict'), /terminal predecessor/);
  f.tick(20000);
  await f.runner.triggerNow(first.registrationId);
  const next = await f.service.register(f.actor, continuation, 'strict');
  assert.notEqual(next.registrationId, first.registrationId);
  assert.equal(next.predecessorRegistrationId, first.registrationId);
  assert.equal((await f.service.register(f.actor, continuation, 'strict')).registrationId, next.registrationId);
  assert.equal(f.tasks.get(f.input.taskId).entrustedWork.revision, 1);
  assert.equal(f.service.readForActor(f.actor).length, 2);
});
