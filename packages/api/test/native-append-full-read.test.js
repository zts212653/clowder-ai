import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { coverPublishedMessageReads } from '../dist/routes/callback-published-wake-coverage.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { appendRecoveryFixture, recoveryProcessor } from './helpers/append-recovery-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('native-full-read');

async function fixture(t, storage = 'memory') {
  const client = storage === 'redis' ? owned.client(`${randomUUID()}:`) : undefined;
  const ledgerStore = client ? new RedisQueueLedgerStore(client) : new InMemoryQueueLedgerStore();
  const messageStore = client ? new RedisMessageStore(client, { ttlSeconds: 0 }) : new MessageStore();
  const registry = new InvocationRegistry();
  const auth = await registry.create('owner', 'opus', 'thread', 'parent');
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  await turnExecutionStore.createRunning({
    ...auth,
    parentInvocationId: 'parent',
    userId: 'owner',
    threadId: 'thread',
    catId: 'opus',
    executionKind: 'ordinary',
    startedAt: Date.now(),
  });
  let dispatched;
  const f = await appendRecoveryFixture(
    async (input) => {
      dispatched = input;
      return {
        accepted: true,
        handle: { provider: 'google', carrier: 'agy_stream_json', threadId: 'native', turnId: 'initial' },
      };
    },
    {
      from: { kind: 'agent', catId: 'codex' },
      invocationId: auth.invocationId,
      inputCompletionReceipt: true,
      ledgerStore,
      messageStore,
    },
  );
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    turnExecutionStore,
    invocationQueue: f.queue,
    queueProcessor: f.processor,
    deliveryCursorStore: new DeliveryCursorStore(),
    threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner', participants: ['opus', 'codex'] }) },
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  await app.register(queueRoutes, {
    invocationQueue: f.queue,
    queueProcessor: f.processor,
    messageStore,
    invocationTracker: f.invocationTracker,
    threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner', participants: ['opus', 'codex'] }) },
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  t.after(() => app.close());
  await f.append();
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  return { ...f, ledgerStore, app, auth, registry, turnExecutionStore, headers, input: () => dispatched };
}

for (const storage of ['memory', 'redis']) {
  test(`${storage}: actual full-read callback records read without native completion or automatic replay`, async (t) => {
    const f = await fixture(t, storage);
    const url = await f.app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${url}/api/callbacks/thread-context?readIntent=unread&responseMode=full`, {
      headers: f.headers,
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    const returned = payload.messages.find((message) => message.id === f.admission.message.id);
    assert.equal(returned?.content, f.admission.message.content);
    assert.equal(returned.truncated, false);
    const readSource = await f.messageStore.getById(f.admission.message.id);
    assert.equal(readSource.lifecycle.dispatchRefs[0].inputRead.status, 'read');
    assert.equal(readSource.lifecycle.dispatchRefs[0].appendAcceptance, 'written');
    assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null, 'handoff already left Queue');
    assert.equal(
      readSource.lifecycle.dispatchRefs[0].appendDelivery.requiresCompletion,
      true,
      'full read is not completion',
    );
    await f.input().onInputCompleted(false);
    assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
    assert.equal(
      (await f.messageStore.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance,
      'incomplete',
    );
    assert.ok((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.includes(f.admission.message.id));
    const reopened = new InvocationQueue(f.ledgerStore);
    await reopened.hydrateFromLedger(f.messageStore);
    let calls = 0;
    const restarted = recoveryProcessor({
      queue: reopened,
      messageStore: f.messageStore,
      routeExecution: async function* () {
        calls++;
      },
    });
    await restarted.reconcileAppendDeliveries('thread');
    await restarted.requestDrain('thread');
    assert.equal(calls, 0, 'unknown effects must not be repeated automatically after restart');
    assert.equal(
      (await f.messageStore.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance,
      'incomplete',
    );
    await f.input().onInputCompleted(true);
    assert.equal(
      await f.queue.getDurableEntry('thread', f.admission.entry.id),
      null,
      'a genuine late exact-turn completion cannot resurrect Queue',
    );
  });

  test(`${storage}: native read followed by failed completion keeps exact read evidence`, async (t) => {
    const f = await fixture(t, storage);
    await f.input().onInputRead();
    await f.input().onInputCompleted(false);
    const source = await f.messageStore.getById(f.admission.message.id);
    assert.equal(source.lifecycle.dispatchRefs[0]?.inputRead.status, 'read');
    assert.equal(source.lifecycle.appendFailures[0].acceptance, 'incomplete');
  });
}

for (const mode of ['anchor', 'other-child']) {
  test(`${mode} is not a read receipt for the appended input's child`, async (t) => {
    const f = await fixture(t);
    const auth = mode === 'other-child' ? await f.registry.create('owner', 'opus', 'thread', 'other-parent') : f.auth;
    const response = await f.app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?responseMode=${mode === 'anchor' ? 'anchor' : 'full'}`,
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      (await f.messageStore.getById(f.admission.message.id)).lifecycle.dispatchRefs[0].inputRead.status,
      'pending',
    );
  });
}

test('the owner can explicitly repeat a read A2A after failure, without impersonating its author or leaving its old Queue target', async (t) => {
  const f = await fixture(t);
  await f.input().onInputRead();
  await f.input().onInputCompleted(false);
  f.invocationTracker.complete('thread', 'opus');
  await f.messageStore.commitLifecycleResponseTerminal(f.response.id, {
    invocationId: f.auth.invocationId,
    status: 'failed',
    completedAt: Date.now(),
    reason: 'AGY_NATIVE_FAILED',
    content: '原生流中断，结果未确认。',
    extra: undefined,
    mentions: [],
    origin: 'stream',
  });
  const queueView = await f.app.inject({
    method: 'GET',
    url: '/api/threads/thread/queue',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(queueView.statusCode, 200, queueView.body);
  assert.deepEqual(queueView.json().queue, []);
  const path = `/api/threads/thread/messages/${f.admission.message.id}/routing-targets/opus/repeat`;
  const payload = { expectedResponseMessageId: f.response.id, expectedInvocationId: f.auth.invocationId };
  const anonymous = await f.app.inject({ method: 'POST', url: path });
  assert.equal(anonymous.statusCode, 401);
  // Keep the newly admitted message queued so this test can inspect its exact sender and idempotency.
  f.processor.suppressAutoResume('thread', 'opus');
  const repeat = () => f.app.inject({ method: 'POST', url: path, payload, headers: { 'x-cat-cafe-user': 'owner' } });
  const first = await repeat();
  assert.equal(first.statusCode, 202, first.body);
  const again = await repeat();
  assert.equal(again.statusCode, 202, again.body);
  assert.equal(again.json().messageId, first.json().messageId);
  const newInput = await f.messageStore.getById(first.json().messageId);
  assert.deepEqual(newInput.from, { kind: 'user', userId: 'owner' });
  assert.equal(newInput.replyTo, f.admission.message.id);
  assert.equal(newInput.content, f.admission.message.content);
  assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
  const original = await f.messageStore.getById(f.admission.message.id);
  assert.deepEqual(original.from, { kind: 'agent', catId: 'codex' });
  assert.equal(original.lifecycle.dispatchRefs[0].inputRead.status, 'read');
});

test('ordinary public A2A uses one full-read receiver instead of also enqueueing a Native internal turn', async () => {
  let writes = 0;
  const f = await appendRecoveryFixture(
    async () => {
      writes++;
      return {
        accepted: true,
        handle: { provider: 'google', carrier: 'agy_stream_json', threadId: 'native', turnId: 'initial' },
      };
    },
    { from: { kind: 'agent', catId: 'codex' }, inputCompletionReceipt: true, messageDisposition: 'continue_current' },
  );
  await f.messageStore.markDelivered(f.admission.message.id, Date.now());
  assert.equal(
    f.queue.getEntrySnapshot('thread', 'owner', f.admission.entry.id).delivery.authorIntentByTarget.opus
      .boundParentInvocationId,
    'parent',
  );
  assert.equal(
    (await f.queue.projectedWakeCandidates('thread', 'owner', 'opus', [f.admission.message.id], f.messageStore)).length,
    1,
  );
  const appended = await f.processor.tryAutoAppendExactEntry({
    threadId: 'thread',
    userId: 'owner',
    entryId: f.admission.entry.id,
    targetCatId: 'opus',
  });
  assert.equal(appended.reason, 'active_run_pending');
  assert.equal(writes, 0, 'one published A2A cannot enter both the MCP receiver and the Native supplemental queue');
  assert.equal(
    (await f.queue.getDurableEntry('thread', f.admission.entry.id)).delivery.appendPendingByTarget,
    undefined,
  );
  await coverPublishedMessageReads(
    {
      invocationQueue: f.queue,
      messageStore: f.messageStore,
      queueProcessor: f.processor,
      turnExecutionStore: {
        get: async () => ({
          invocationId: 'turn',
          parentInvocationId: 'parent',
          threadId: 'thread',
          userId: 'owner',
          catId: 'opus',
          status: 'running',
        }),
      },
    },
    {
      threadId: 'thread',
      userId: 'owner',
      catId: 'opus',
      invocationId: 'turn',
      parentInvocationId: 'parent',
      messageIds: [f.admission.message.id],
    },
  );
  assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
  assert.ok((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.includes(f.admission.message.id));
  assert.equal(writes, 0);
});

for (const example of [
  { name: 'user input', from: { kind: 'user', userId: 'owner' }, inputCompletionReceipt: true },
  { name: 'private A2A', from: { kind: 'agent', catId: 'codex' }, inputCompletionReceipt: true, visibility: 'whisper' },
  { name: 'non-Native A2A', from: { kind: 'agent', catId: 'codex' }, inputCompletionReceipt: false },
]) {
  test(`${example.name} keeps its existing automatic Append carrier`, async () => {
    let writes = 0;
    const f = await appendRecoveryFixture(
      async () => {
        writes++;
        return { accepted: true };
      },
      { ...example, messageDisposition: 'continue_current' },
    );
    await f.messageStore.markDelivered(f.admission.message.id, Date.now());
    const result = await f.processor.tryAutoAppendExactEntry({
      threadId: 'thread',
      userId: 'owner',
      entryId: f.admission.entry.id,
      targetCatId: 'opus',
    });
    assert.equal(result.outcome, 'appended', JSON.stringify(result));
    assert.equal(writes, 1);
  });
}
