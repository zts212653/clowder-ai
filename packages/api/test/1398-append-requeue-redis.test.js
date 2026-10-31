import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { repeatUncertainAppend } from '../dist/domains/cats/services/agents/invocation/repeat-uncertain-append.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { appendRecoveryFixture, recoveryProcessor } from './helpers/append-recovery-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('append-recovery');

test('an uncertain cat wake can be stopped after restart; History and late receipts survive, Queue does not return', async (t) => {
  const client = owned.client(`withdraw:${randomUUID()}:`);
  const store = new RedisMessageStore(client, { ttlSeconds: 0 });
  let inputRead;
  let dispatches = 0;
  const f = await appendRecoveryFixture(
    async (input) => {
      dispatches++;
      inputRead = input.onInputRead;
      return { accepted: false, reason: 'provider_rejected', acceptance: 'unknown' };
    },
    { messageStore: store, ledgerStore: new RedisQueueLedgerStore(client), from: { kind: 'agent', catId: 'codex' } },
  );
  await f.append();
  await f.processor.reconcileAppendDeliveries('thread');
  const source = await store.getById(f.admission.message.id);
  const reopened = new RedisMessageStore(client, { ttlSeconds: 0 });
  const queue = new InvocationQueue(new RedisQueueLedgerStore(client));
  await queue.hydrateFromLedger(reopened);
  const processor = recoveryProcessor({ queue, messageStore: reopened });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(queueRoutes, {
    threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner' }) },
    invocationQueue: queue,
    queueProcessor: processor,
    invocationTracker: processor.deps.invocationTracker,
    messageStore: reopened,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, getActiveInvocations: () => [] },
  });
  const stopped = await app.inject({
    method: 'DELETE',
    url: '/api/threads/thread/queue',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.deepEqual(stopped.json().queue, []);
  assert.deepEqual((await reopened.getById(source.id)).lifecycle, source.lifecycle);
  assert.equal((await reopened.getById(source.id)).content, source.content);
  await inputRead();
  assert.equal((await reopened.getById(source.id)).lifecycle.dispatchRefs[0].inputRead.status, 'read');
  await queue.hydrateFromLedger(reopened);
  await processor.requestDrain('thread');
  assert.equal(await queue.getDurableEntry('thread', f.admission.entry.id), null);
  assert.equal(dispatches, 1);
  assert.equal(await client.ttl(`msg:${source.id}`), -1);
});

test('Redis first handoff remains recoverable after failed compensation and a host restart', async () => {
  const client = owned.client(`case:${randomUUID()}:`);
  const store = new RedisMessageStore(client, { ttlSeconds: 0 });
  const ledger = new RedisQueueLedgerStore(client);
  let dispatches = 0;
  const f = await appendRecoveryFixture(
    async () => {
      dispatches++;
      return { accepted: false, reason: 'exception', acceptance: 'unknown' };
    },
    { messageStore: store, ledgerStore: ledger },
  );
  const commit = store.commitLifecycleAppendRecovery.bind(store);
  store.commitLifecycleAppendRecovery = async () => {
    throw new Error('recovery write unavailable');
  };
  await f.append();
  const pending = await ledger.get('thread', f.admission.entry.id);
  assert.equal(pending.delivery.appendPendingByTarget.opus.dispatchStarted, true);
  assert.deepEqual(pending.delivery.routingHeldTargetIds, ['opus']);
  store.commitLifecycleAppendRecovery = commit;
  const reopened = new RedisMessageStore(client, { ttlSeconds: 0 });
  const queue = new InvocationQueue(new RedisQueueLedgerStore(client));
  await queue.hydrateFromLedger(reopened);
  const resumed = recoveryProcessor({ queue, messageStore: reopened });
  await resumed.requestDrain('thread');
  await resumed.reconcileAppendDeliveries('thread');
  const reconciled = await ledger.get('thread', pending.id);
  assert.deepEqual(reconciled.payload, pending.payload);
  assert.ok(reconciled.delivery.appendRecoveryByTarget.opus.checkedAt);
  assert.equal(reconciled.delivery.appendPendingByTarget, undefined);
  assert.equal(dispatches, 1);
  assert.equal((await reopened.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance, 'unknown');
});

test('Redis concurrent deliberate repeats create one new private input and preserve its original uncertain receipt', async () => {
  const client = owned.client(`case:${randomUUID()}:`);
  const store = new RedisMessageStore(client, { ttlSeconds: 0 });
  const f = await appendRecoveryFixture(async () => ({ accepted: false, reason: 'exception', acceptance: 'unknown' }), {
    messageStore: store,
    ledgerStore: new RedisQueueLedgerStore(client),
    visibility: 'whisper',
  });
  await f.append();
  await f.processor.requestDrain('thread');
  await f.processor.reconcileAppendDeliveries('thread');
  const source = await store.getById(f.admission.message.id);
  const [first, again] = await Promise.all([
    repeatUncertainAppend(f.queue, store, source, 'opus'),
    repeatUncertainAppend(f.queue, store, source, 'opus'),
  ]);
  assert.ok(first && again);
  assert.notEqual(first.message.id, source.id);
  assert.equal(first.message.id, again.message.id);
  assert.equal(first.message.visibility, 'whisper');
  assert.deepEqual(first.message.whisperTo, ['opus']);
  assert.equal(
    (await store.getByThread('thread', 100, 'foreign', { includeQueuedUserMessages: true })).some(
      (m) => m.id === first.message.id,
    ),
    false,
  );
  assert.deepEqual((await f.queue.getDurableEntry('thread', first.entryId)).targets, ['opus']);
  assert.deepEqual((await store.getById(source.id)).lifecycle, source.lifecycle);
  assert.deepEqual((await f.queue.getDurableEntry('thread', f.admission.entry.id)).delivery.routingHeldTargetIds, [
    'opus',
  ]);
});

test('late native read retires uncertainty while another recipient owns a live claim', async () => {
  const client = owned.client(`case:${randomUUID()}:`);
  const store = new RedisMessageStore(client, { ttlSeconds: 0 });
  const ledger = new RedisQueueLedgerStore(client);
  let inputRead;
  const f = await appendRecoveryFixture(
    async (input) => {
      inputRead = input.onInputRead;
      return { accepted: false, reason: 'exception', acceptance: 'unknown' };
    },
    { messageStore: store, ledgerStore: ledger },
  );
  await f.queue.reconcileQueuedMessageTargetsDurable('thread', 'owner', f.admission.entry.id, ['codex'], [], {});
  await f.append();
  const claim = await ledger.claim('thread', f.admission.entry.id, 'sibling-claim', Date.now(), 'codex');
  assert.equal(claim.outcome, 'claimed');
  assert.equal(
    (await ledger.reconcileTargets('thread', f.admission.entry.id, [], ['codex'], {})).outcome,
    'state_changed',
  );
  assert.equal(
    (await ledger.reconcileTargets('thread', f.admission.entry.id, ['kimi'], [], {})).outcome,
    'state_changed',
  );
  await inputRead();
  const entry = await ledger.get('thread', f.admission.entry.id);
  assert.deepEqual(entry.targets, ['codex'], 'read uncertainty must leave no retry target');
  assert.equal(entry.claimId, 'sibling-claim');
  assert.deepEqual(entry.claimedTargetIds, ['codex']);
  assert.deepEqual(entry.delivery.routingHeldTargetIds ?? [], []);
  assert.equal(
    (await ledger.commit('thread', entry.id, 'sibling-claim', 'processing', Date.now(), undefined, ['codex'])).outcome,
    'updated',
  );
  assert.equal(await ledger.get('thread', entry.id), null);
});

for (const visibility of ['public', 'whisper']) {
  for (const acceptance of ['not_accepted', 'unknown']) {
    test(`Redis ${visibility} ${acceptance} survives re-open without copying the source or changing admission`, async () => {
      const client = owned.client(`case:${randomUUID()}:`);
      const store = new RedisMessageStore(client, { ttlSeconds: 0 });
      const ledger = new RedisQueueLedgerStore(client);
      let inputRead;
      const f = await appendRecoveryFixture(
        async (input) => {
          inputRead = input.onInputRead;
          return { accepted: false, reason: 'active_run_closed', acceptance };
        },
        { messageStore: store, ledgerStore: ledger, visibility },
      );
      await f.append();
      const reopened = new RedisMessageStore(client, { ttlSeconds: 0 });
      const queue = new InvocationQueue(new RedisQueueLedgerStore(client));
      assert.equal(await queue.hydrateFromLedger(reopened), 1);
      const entry = await queue.getDurableEntry('thread', f.admission.entry.id);
      assert.equal(entry.status, 'queued');
      assert.deepEqual(entry.payload, f.admission.entry.payload);
      assert.deepEqual(entry.execution, f.admission.entry.execution);
      assert.deepEqual(entry.targets, ['opus']);
      const source = await reopened.getById(f.admission.message.id);
      assert.equal(source.content, f.admission.message.content);
      assert.equal(source.visibility ?? 'public', visibility);
      if (visibility === 'whisper') {
        assert.deepEqual(source.whisperTo, ['opus']);
        assert.deepEqual((await reopened.getById(f.response.id)).lifecycle.inputMessageIds, []);
        assert.deepEqual((await reopened.getById(f.response.id)).lifecycle.inputEntryIds, []);
        assert.equal(
          (await reopened.getByThread('thread', 100, 'someone-else')).some((m) => m.id === source.id),
          false,
        );
      }
      assert.equal(source.lifecycle.appendFailures[0].acceptance, acceptance);
      assert.equal(source.lifecycle.appendFailures[0].reason, 'active_run_closed');
      const failure = entry.delivery.appendRecoveryByTarget.opus;
      assert.equal(
        (await queue.recoverLifecycleAppend(reopened, { entry: f.admission.entry, failure })).kind,
        'replayed',
      );
      if (acceptance === 'unknown') {
        assert.deepEqual(entry.delivery.routingHeldTargetIds, ['opus']);
        await inputRead();
        assert.equal(await queue.getDurableEntry('thread', entry.id), null);
        assert.equal((await reopened.getById(source.id)).lifecycle.dispatchRefs[0].inputRead.status, 'read');
      } else {
        assert.deepEqual(source.lifecycle.dispatchRefs, []);
        assert.deepEqual((await reopened.getById(f.response.id)).lifecycle.inputMessageIds, []);
      }
      assert.equal(await client.ttl(`msg:${source.id}`), -1);
      assert.equal(
        (await reopened.getByThread('thread', 100, 'owner')).filter((m) => m.from.kind === 'user').length,
        1,
      );
    });
  }
}

test('Redis lost compensation reply replays its transaction and keeps unrelated recipients queued', async () => {
  const client = owned.client(`case:${randomUUID()}:`);
  const store = new RedisMessageStore(client, { ttlSeconds: 0 });
  const ledger = new RedisQueueLedgerStore(client);
  const f = await appendRecoveryFixture(
    async () => ({ accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' }),
    { messageStore: store, ledgerStore: ledger },
  );
  await f.queue.reconcileQueuedMessageTargetsDurable('thread', 'owner', f.admission.entry.id, ['codex'], [], {});
  const commit = store.commitLifecycleAppendRecovery.bind(store);
  let lostReply = true;
  store.commitLifecycleAppendRecovery = async (...args) => {
    const result = await commit(...args);
    if (lostReply) {
      lostReply = false;
      throw new Error('connection lost after durable compensation');
    }
    return result;
  };
  await f.append();
  const entry = await ledger.get('thread', f.admission.entry.id);
  assert.deepEqual(new Set(entry.targets), new Set(['opus', 'codex']));
  assert.deepEqual(entry.delivery.authorIntentByTarget.opus, f.admission.entry.delivery.authorIntentByTarget.opus);
  assert.deepEqual(
    new Set(f.queue.getEntrySnapshot('thread', 'owner', entry.id).targets),
    new Set(['opus', 'codex']),
    'lost commit reply must recover the live Queue projection as well as restart truth',
  );
  const failure = entry.delivery.appendRecoveryByTarget.opus;
  const again = await store.commitLifecycleAppendRecovery({ entry: f.admission.entry, failure }, ledger);
  assert.equal(again.kind, 'replayed');
  assert.equal((await ledger.list('thread')).length, 1);
  assert.equal((await store.getById(f.admission.message.id)).lifecycle.appendFailures.length, 1);
});

test('Redis native read racing the recovery CAS prevents requeue and preserves the received input', async () => {
  const client = owned.client(`case:${randomUUID()}:`);
  const store = new RedisMessageStore(client, { ttlSeconds: 0 });
  const ledger = new RedisQueueLedgerStore(client);
  let inputRead;
  const f = await appendRecoveryFixture(
    async (input) => {
      inputRead = input.onInputRead;
      return { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' };
    },
    { messageStore: store, ledgerStore: ledger },
  );
  const evaluate = client.eval.bind(client);
  let injected = false;
  client.eval = async (script, ...args) => {
    if (!injected && script.includes('APPEND_RECOVERY_WRONG_KEY_TYPE')) {
      injected = true;
      await inputRead();
    }
    return evaluate(script, ...args);
  };
  await f.append();
  assert.equal(injected, true);
  assert.equal(await ledger.get('thread', f.admission.entry.id), null);
  const source = await store.getById(f.admission.message.id);
  assert.equal(source.lifecycle.dispatchRefs[0].inputRead.status, 'read');
  assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.equal(source.lifecycle.appendFailures, undefined);
});

for (const completed of [true, false]) {
  test(`Redis internal-turn completion (${completed}) retains Queue after read and survives reload`, async () => {
    const client = owned.client(`case:${randomUUID()}:`);
    const store = new RedisMessageStore(client, { ttlSeconds: 0 });
    const ledger = new RedisQueueLedgerStore(client);
    let input;
    const f = await appendRecoveryFixture(
      async (value) => {
        input = value;
        return {
          accepted: true,
          handle: { provider: 'google', carrier: 'agy_stream_json', threadId: 'native', turnId: 'first' },
        };
      },
      { messageStore: store, ledgerStore: ledger, inputCompletionReceipt: true },
    );
    assert.equal((await f.append()).outcome, 'appended');
    await input.onInputRead();
    const reloaded = new RedisMessageStore(client, { ttlSeconds: 0 });
    const queue = new InvocationQueue(new RedisQueueLedgerStore(client));
    assert.equal(await queue.hydrateFromLedger(reloaded), 1);
    const pending = await queue.getDurableEntry('thread', f.admission.entry.id);
    assert.equal(pending.delivery.appendPendingByTarget.opus.requiresCompletion, true);
    assert.equal((await reloaded.getById(f.admission.message.id)).lifecycle.dispatchRefs[0].inputRead.status, 'read');
    await input.onInputCompleted(completed);
    const row = await ledger.get('thread', f.admission.entry.id);
    const source = await reloaded.getById(f.admission.message.id);
    if (completed) {
      assert.equal(row, null);
      assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'accepted');
    } else {
      assert.deepEqual(row.payload, f.admission.entry.payload);
      assert.equal(row.delivery.appendRecoveryByTarget.opus.acceptance, 'incomplete');
      assert.equal(source.lifecycle.dispatchRefs.length, 0);
      assert.deepEqual(row.delivery.routingHeldTargetIds ?? [], []);
    }
    assert.equal(await client.ttl('msg:' + source.id), -1);
  });
}
