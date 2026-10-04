import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ordinaryDispatchFixture } from './helpers/ordinary-dispatch-fixture.js';

const full = (h) => h.get('/api/callbacks/thread-context?responseMode=full');
const terminals = (h) => h.eventLog.events.filter((e) => e.kind === 'ball.dispatch_dispositioned');
const failTurn = (h) =>
  h.processor.onInvocationComplete('thread-1', 'codex-sol', 'failed', h.identity.invocationId, [], true);

for (const persistent of [false, true]) {
  test(`ordinary adopted CAS contention is bounded and revalidates (${persistent ? 'persistent' : 'once'})`, async (t) => {
    const h = await ordinaryDispatchFixture(t);
    const source = await h.addSource('contention');
    await full(h);
    const append = h.eventLog.appendFenced.bind(h.eventLog);
    let attempts = 0;
    h.eventLog.appendFenced = async (event, sequence) => {
      if (event.kind === 'ball.dispatch_dispositioned' && (++attempts === 1 || persistent))
        return { outcome: 'conflict', actualSequence: sequence + 1 };
      return append(event, sequence);
    };
    assert.equal((await h.complete(source.id)).status, persistent ? 409 : 200);
    assert.equal(attempts, 2);
    assert.equal(terminals(h).length, persistent ? 0 : 1);
  });
}

for (const field of ['userId', 'threadId', 'catId', 'invocationId']) {
  test(`ordinary completion rejects a foreign ${field} even with an exposed message id`, async (t) => {
    const h = await ordinaryDispatchFixture(t);
    const source = await h.addSource('protected');
    await full(h);
    const auth = { ...h.identity, userId: 'user-1', catId: 'codex-sol', threadId: 'thread-1', [field]: 'foreign' };
    await assert.rejects(h.service.completeAdopted(auth, source.id, 'handled'), /inactive_invocation|stale_invocation/);
    assert.equal(terminals(h).length, 0);
  });
}

test('a source withdrawn while completion is inspecting the event log is not terminalized', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  const source = await h.addSource('will be withdrawn');
  await full(h);
  const read = h.eventLog.read.bind(h.eventLog);
  let raced = false;
  h.eventLog.read = async (...args) => {
    if (!raced) {
      raced = true;
      await h.coordinator.withdrawEntry(h.queue.list('thread-1', 'user-1')[0]);
    }
    return read(...args);
  };
  assert.equal((await h.complete(source.id)).status, 409);
  assert.equal(terminals(h).length, 0);
});

for (const boundary of ['unread', 'preview', 'withdrawn', 'closed', 'terminal', 'stale', 'live without host']) {
  test(`ordinary adopted completion rejects ${boundary} without a terminal`, async (t) => {
    const h = await ordinaryDispatchFixture(t, { live: boundary === 'live without host' });
    const source = await h.addSource('pending source');
    if (boundary === 'preview') await h.get(`/api/callbacks/get-message?messageId=${source.id}&mode=preview`);
    else if (boundary !== 'unread') await full(h);
    if (boundary === 'withdrawn') await h.coordinator.withdrawEntry(h.queue.list('thread-1', 'user-1')[0]);
    if (boundary === 'closed') await h.unregister();
    if (boundary === 'terminal')
      h.executions.transitionTerminal(h.identity.invocationId, {
        status: 'failed',
        terminalReason: 'fixture failure',
        endedAt: Date.now(),
      });
    if (boundary === 'stale') await h.registry.create('user-1', 'codex-sol', 'thread-1');
    const response = await h.complete(source.id);
    assert.notEqual(response.status, 200, JSON.stringify(response.body));
    assert.equal(terminals(h).length, 0);
    assert.deepEqual(h.messageStore.getById(source.id).queueCustody.handledByCatIds, []);
  });
}

test('one completed source survives failure; its read but incomplete sibling remains failed', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  const first = await h.addSource('finished');
  const second = await h.addSource('unfinished');
  await full(h);
  assert.equal((await h.complete(first.id)).status, 200);
  await failTurn(h);
  assert.deepEqual(h.messageStore.getById(first.id).queueCustody.handledByCatIds, ['codex-sol']);
  assert.deepEqual(h.messageStore.getById(second.id).queueCustody.handledByCatIds, []);
  assert.deepEqual(h.messageStore.getById(second.id).queueCustody.failedByCatIds, ['codex-sol']);
  assert.equal(terminals(h).length, 1);
});

test('a failed receipt write is repaired before provider failure can requeue its source', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  const source = await h.addSource('finished before disconnect');
  await full(h);
  const repair = h.receipts.repair.bind(h.receipts);
  h.receipts.repair = async () => {
    throw new Error('synthetic receipt outage');
  };
  assert.equal((await h.complete(source.id)).status, 500);
  assert.equal(terminals(h).length, 1);
  assert.deepEqual(h.messageStore.getById(source.id).queueCustody.handledByCatIds, []);
  h.receipts.repair = repair;
  await failTurn(h);
  assert.deepEqual(h.messageStore.getById(source.id).queueCustody.handledByCatIds, ['codex-sol']);
  assert.deepEqual(h.messageStore.getById(source.id).queueCustody.failedByCatIds, []);
  assert.equal(terminals(h).length, 1);
});

test('ordinary route close drains accepted completion and refuses new source operations', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  const first = await h.addSource('accepted');
  const second = await h.addSource('too late');
  await full(h);
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const repair = h.receipts.repair.bind(h.receipts);
  h.receipts.repair = async (input) => {
    enter();
    await released;
    return repair(input);
  };
  const completing = h.complete(first.id);
  await entered;
  let closed = false;
  const closing = h.unregister().then(() => {
    closed = true;
  });
  try {
    assert.equal((await h.complete(second.id)).status, 409);
    assert.equal(closed, false);
  } finally {
    release();
  }
  assert.equal((await completing).status, 200);
  await closing;
  assert.equal(closed, true);
  assert.deepEqual(h.messageStore.getById(second.id).queueCustody.handledByCatIds, []);
});
