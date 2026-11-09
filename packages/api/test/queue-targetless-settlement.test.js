import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('queue-targetless-settlement');

function storageFactory(storage) {
  const prefix = `${randomUUID()}:`;
  const memory = { ledger: new InMemoryQueueLedgerStore(), messages: new MessageStore() };
  return () => {
    if (storage === 'memory') return memory;
    const client = owned.client(prefix);
    return { ledger: new RedisQueueLedgerStore(client), messages: new RedisMessageStore(client, { ttlSeconds: 0 }) };
  };
}

function fixture(stores, available = false) {
  const agents = new AgentRegistry();
  if (available) agents.register('opus', { async *invoke() {} });
  const router = new AgentRouter({
    agentRegistry: agents,
    registry: new InvocationRegistry(),
    messageStore: stores.messages,
    threadStore: new ThreadStore(),
  });
  const queue = new InvocationQueue(stores.ledger, {
    resolveTargets: (targets, thread, content, exact) => router.resolveSendTargets(targets, thread, content, exact),
  });
  const processor = new QueueProcessor({
    queue,
    router,
    messageStore: stores.messages,
    invocationTracker: new InvocationTracker(),
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  const from = { kind: 'user', userId: 'owner' };
  const source = { from, userId: 'owner', threadId: 'thread', content: 'hello' };
  const send = () =>
    queue.send(
      stores.messages,
      { ...source, mentions: [], deliveryStatus: 'queued', timestamp: 100, idempotencyKey: 'same-request' },
      { ...source, kind: 'conversation_input', ownerAuthProvenance: 'strict', targetCats: [], intent: 'execute' },
    );
  return { ...stores, queue, processor, send };
}

for (const storage of ['memory', 'redis']) {
  for (const { fault, restart = true, available = false } of [
    { fault: 'before-retirement' },
    { fault: 'lost-retirement-reply' },
    { fault: 'before-retirement', available: true },
    { fault: 'lost-retirement-reply', restart: false },
  ]) {
    test(`${storage}: ${fault}, restart=${restart}, available=${available} preserves terminal input and replay`, async (t) => {
      const reopen = storageFactory(storage);
      const f = fixture(reopen());
      const sent = await f.send();
      assert.deepEqual(sent.entry.targets, []);
      const commit = f.ledger.commit.bind(f.ledger);
      let injected = false;
      f.ledger.commit = async (...args) => {
        if (args[3] !== 'withdrawn' || injected) return commit(...args);
        injected = true;
        if (fault === 'lost-retirement-reply') await commit(...args);
        throw new Error(`owned fault: ${fault}`);
      };
      t.after(() => {
        f.ledger.commit = commit;
      });
      await assert.rejects(f.processor.requestDrain('thread'), new RegExp(`owned fault: ${fault}`));
      assert.equal(injected, true, 'the failure occurs at durable Queue retirement, after History commits');
      f.ledger.commit = commit;
      const historyBefore = await f.messages.getByThread('thread');
      const failureBefore = historyBefore.find((message) => message.lifecycle?.reason === 'no_available_target');
      assert.ok(failureBefore);
      assert.equal((await f.messages.getById(sent.message.id)).content, 'hello');

      // Reopen Redis clients/stores as well as the process-local Queue; no cached receipt supplies recovery.
      const restarted = restart ? fixture(reopen(), available) : f;
      if (restart) await restarted.queue.hydrateFromLedger(restarted.messages);
      await restarted.processor.requestDrain('thread');
      assert.equal(await restarted.queue.getDurableEntry('thread', sent.entry.id), null);
      assert.deepEqual(restarted.queue.list('thread', 'owner'), []);
      const replay = await restarted.send();
      assert.equal(replay.message.id, sent.message.id);
      assert.equal(replay.deduped, true);
      assert.deepEqual(await restarted.ledger.list('thread'), []);
      const historyAfter = await restarted.messages.getByThread('thread');
      assert.deepEqual(
        historyAfter.map((message) => message.id),
        historyBefore.map((message) => message.id),
        'recovery and replay preserve the original input and exactly one explicit failure',
      );
      assert.equal(historyAfter.filter((message) => message.lifecycle?.reason === 'no_available_target').length, 1);
    });
  }

  test(`${storage}: an old empty claim cannot retire a replacement target`, async () => {
    const f = fixture(storageFactory(storage)());
    const sent = await f.send();
    const original = await f.queue.claimPreAdmissionFailureAcrossUsersDurable('thread', sent.entry.id, []);
    assert.ok(original?.claimId);
    assert.deepEqual(original.claimedTargetIds, []);
    const addTarget = () =>
      f.queue.reconcileQueuedMessageTargetsDurable('thread', 'owner', sent.entry.id, ['opus'], [], {});
    assert.equal((await addTarget()).outcome, 'state_changed', 'an empty claim freezes recipient changes');
    assert.equal(await f.queue.rollbackProcessingDurable('thread', sent.entry.id), true);
    assert.equal((await addTarget()).outcome, 'updated');
    const replacement = await f.queue.markProcessingByIdDurable('thread', sent.entry.id, 'opus');
    assert.ok(replacement?.claimId);
    assert.notEqual(replacement.claimId, original.claimId);
    assert.equal(
      await f.queue.removeProcessedAcrossUsersDurable(
        'thread',
        sent.entry.id,
        'failed',
        'invocation_failed',
        Date.now(),
        original,
      ),
      null,
    );
    const current = await f.queue.getDurableEntry('thread', sent.entry.id);
    assert.equal(current.claimId, replacement.claimId);
    assert.deepEqual(current.targets, ['opus']);
    assert.deepEqual(f.queue.list('thread', 'owner')[0].targets, ['opus']);
    assert.equal((await f.messages.getById(sent.message.id)).content, 'hello');
  });
}
