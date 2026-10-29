import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { appendRecoveryFixture, recoveryProcessor } from './helpers/append-recovery-fixture.js';

async function fixture(options = {}) {
  let input;
  const ledger = new InMemoryQueueLedgerStore();
  const f = await appendRecoveryFixture(
    async (value) => {
      input = value;
      return { accepted: true, handle: { provider: 'other', carrier: 'other', threadId: 'native', turnId: 'first' } };
    },
    { inputCompletionReceipt: true, ledgerStore: ledger, ...options },
  );
  return { ...f, ledger, input: () => input };
}

async function http(t, f) {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(queueRoutes, {
    threadStore: { get: async (id) => (id === 'thread' ? { id, createdBy: 'owner' } : null) },
    invocationQueue: f.queue,
    queueProcessor: f.processor,
    invocationTracker: f.invocationTracker,
    messageStore: f.messageStore,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, getActiveInvocations: () => [] },
  });
  return (method, path) =>
    app.inject({ method, url: `/api/threads/thread/${path}`, headers: { 'x-cat-cafe-user': 'owner' } });
}

for (const operation of ['withdraw', 'clear', 'message-withdraw']) {
  test(`an in-flight internal turn survives ${operation} and remains compensatable`, async (t) => {
    const f = await fixture();
    await f.append();
    const request = await http(t, f);
    if (operation === 'message-withdraw') {
      assert.equal(
        (await f.queue.claimMessageEntriesForWithdrawal('thread', 'owner', f.admission.message.id)).outcome,
        'processing',
      );
    } else if (operation === 'withdraw') {
      const response = await request('DELETE', `queue/${f.admission.entry.id}`);
      assert.equal(response.statusCode, 409, response.body);
    } else {
      const response = await request('DELETE', 'queue');
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().code, 'QUEUE_WITHDRAWAL_FAILED');
      assert.equal(response.json().cleared.length, 0);
      assert.equal(response.json().queue[0].id, f.admission.entry.id);
    }
    assert.ok(await f.queue.getDurableEntry('thread', f.admission.entry.id));
    await f.input().onInputCompleted(false);
    assert.equal((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.length, 0);
    assert.equal((await f.messageStore.getById(f.admission.message.id)).lifecycle.dispatchRefs.length, 0);
    assert.equal(f.queue.list('thread', 'owner')[0].delivery.appendRecoveryByTarget.opus.acceptance, 'incomplete');
  });
}

test('GET Queue hides Append once its original input is already in flight', async (t) => {
  const f = await fixture();
  await f.append();
  const request = await http(t, f);
  const response = await request('GET', 'queue');
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().queue[0].lifecycleActions?.append, undefined);
});

for (const operation of ['entry', 'message']) {
  test(`a stale Queue cache cannot ${operation}-withdraw a now in-flight durable row`, async () => {
    const f = await fixture();
    const stale = new InvocationQueue(f.ledger);
    await stale.hydrateFromLedger(f.messageStore);
    await f.append();
    if (operation === 'entry')
      assert.equal(await stale.claimQueuedEntryForWithdrawal('thread', 'owner', f.admission.entry.id), null);
    else
      assert.equal(
        (await stale.claimMessageEntriesForWithdrawal('thread', 'owner', f.admission.message.id)).outcome,
        'processing',
      );
    assert.equal((await f.ledger.get('thread', f.admission.entry.id)).status, 'queued');
    await f.input().onInputCompleted(false);
    assert.equal(f.queue.list('thread', 'owner')[0].delivery.appendRecoveryByTarget.opus.acceptance, 'incomplete');
  });
}

for (const operation of ['hydrate', 'reconcile']) {
  test(`${operation} keeps an unfinished read internal turn beside a sibling claim`, async () => {
    const f = await fixture();
    await f.queue.reconcileQueuedMessageTargetsDurable('thread', 'owner', f.admission.entry.id, ['codex'], [], {});
    await f.append();
    await f.input().onInputRead();
    assert.equal(
      (await f.ledger.claim('thread', f.admission.entry.id, 'sibling', Date.now(), 'codex')).outcome,
      'claimed',
    );
    if (operation === 'hydrate') await new InvocationQueue(f.ledger).hydrateFromLedger(f.messageStore);
    else await f.queue.reconcileClaimedLifecycleTargets('thread', [f.admission.entry.id], f.messageStore);
    const row = await f.ledger.get('thread', f.admission.entry.id);
    assert.ok(row.targets.includes('opus'), 'reading must not retire an unfinished internal turn');
    assert.equal(row.delivery.appendPendingByTarget.opus.requiresCompletion, true);
  });
}

for (const completed of [true, false]) {
  test(`completion (${completed}) broadcasts the resulting Queue, after durable custody changes`, async () => {
    const f = await fixture();
    await f.append();
    const socket = f.processor.deps.socketManager;
    socket.emitToUser.mock.resetCalls();
    await f.input().onInputCompleted(completed);
    const events = socket.emitToUser.mock.calls.filter((call) => call.arguments[1] === 'queue_updated');
    assert.ok(events.length > 0, 'completion must refresh the visible Queue without another user action');
    assert.equal(events.at(-1).arguments[2].queue.length, completed ? 0 : 1);
  });
}

test('restart recovery broadcasts restoration of the original unfinished input', async () => {
  const f = await fixture();
  await f.append();
  await f.input().onInputRead();
  const restarted = recoveryProcessor({ queue: f.queue, messageStore: f.messageStore });
  await restarted.reconcileAppendDeliveries('thread');
  const events = restarted.deps.socketManager.emitToUser.mock.calls.filter(
    (call) => call.arguments[1] === 'queue_updated',
  );
  assert.ok(
    events.some((call) => call.arguments[2].queue[0]?.appendFailures?.length || call.arguments[2].queue.length === 1),
  );
  assert.equal(f.queue.list('thread', 'owner')[0].delivery.appendRecoveryByTarget.opus.acceptance, 'incomplete');
});
