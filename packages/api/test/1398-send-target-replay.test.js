import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { createQueueLedgerAdmission } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

function envelope(targetCats = [], content = 'hello', idempotencyKey = 'fixed-request') {
  const from = { kind: 'user', userId: 'owner' };
  return [
    {
      from,
      userId: 'owner',
      threadId: 'thread',
      content,
      mentions: targetCats,
      deliveryStatus: 'queued',
      timestamp: 100,
      idempotencyKey,
    },
    {
      from,
      userId: 'owner',
      threadId: 'thread',
      content,
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      targetCats,
      intent: 'execute',
    },
  ];
}
function fixture({ unavailable = false, noServices = false } = {}) {
  const agents = new AgentRegistry();
  if (!noServices) agents.register('codex', { invoke: async function* () {} });
  if (unavailable) agents.markUnavailable('opus', { code: 'rejected-account-binding', message: 'owned fixture' });
  else if (!noServices) agents.register('opus', { invoke: async function* () {} });
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const registry = new InvocationRegistry();
  const router = new AgentRouter({ agentRegistry: agents, registry, messageStore: messages, threadStore: threads });
  const queue = new InvocationQueue(undefined, {
    resolveTargets: (targets, thread, content, exact) => router.resolveSendTargets(targets, thread, content, exact),
  });
  return { messages, threads, registry, router, queue, agents };
}
test('common send retains default recipient and policy across concurrent retries', async () => {
  let fallback = 'opus';
  const queue = new InvocationQueue(undefined, {
    resolveTargets: async (targets) => (targets.length ? [...targets] : [fallback]),
  });
  const messages = new MessageStore();
  const args = envelope();
  const first = await queue.send(messages, ...args);
  fallback = 'codex';
  const retries = await Promise.all(Array.from({ length: 12 }, () => queue.send(messages, ...args)));
  for (const retry of retries) {
    assert.equal(retry.message.id, first.message.id);
    assert.deepEqual(retry.entry.targets, ['opus']);
    assert.deepEqual(retry.entry.delivery.authorIntentByTarget, first.entry.delivery.authorIntentByTarget);
    assert.equal(retry.deduped, true);
  }
  const next = await queue.send(messages, ...envelope([], 'hello', 'new-request'));
  assert.deepEqual(next.entry.targets, ['codex']);
  await assert.rejects(queue.send(messages, ...envelope([], 'different body')), /identity conflict/);
  await assert.rejects(queue.send(messages, ...envelope(['codex'])), /identity conflict/);
  await assert.rejects(
    queue.send(messages, args[0], { ...args[1], ownerAuthProvenance: 'unknown' }),
    /identity conflict/,
  );
  await assert.rejects(queue.send(messages, args[0], { ...args[1], targetCats: ['codex'] }), /identity conflict/);
  assert.equal(queue.list('thread', 'owner').length, 2);
});
test('ordinary unavailable recipient falls back without rewriting prose; exact recipients stay exact', async () => {
  const f = fixture({ unavailable: true });
  const result = await f.queue.send(f.messages, ...envelope([], '@opus hello'));
  assert.deepEqual(result.entry.targets, ['codex']);
  assert.equal(result.message.content, '@opus hello');
  assert.deepEqual(await f.router.resolveSendTargets(['opus'], 'thread', '@opus hello', true), ['opus']);
  await assert.rejects(f.router.resolveSendTargets(['not-a-catalog-id'], 'thread'), /identity/);
});
for (const [content, expected] of [
  ['no member mentioned', ['opus']],
  ['ordinary @not_a_member prose', ['opus']],
  ['@not_a_member @codex hello', ['codex']],
  ['hello @codex', ['codex']],
]) {
  test(`common send parses only catalog mentions: ${content}`, async () => {
    const f = fixture();
    const result = await f.queue.send(f.messages, ...envelope([], content));
    assert.deepEqual(result.entry.targets, expected);
    assert.equal(result.message.content, content);
    assert.equal(result.entry.payload.routingWarnings, undefined);
  });
}
test('no available fallback persists the source and existing drain produces explicit failure', async () => {
  const f = fixture({ noServices: true });
  const result = await f.queue.send(f.messages, ...envelope([], '@opus hello'));
  assert.equal(result.outcome, 'enqueued');
  assert.deepEqual(result.entry.targets, []);
  assert.equal(f.messages.getById(result.message.id).content, '@opus hello');
  const processor = new QueueProcessor({
    queue: f.queue,
    invocationTracker: new InvocationTracker(),
    messageStore: f.messages,
    router: f.router,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  await processor.requestDrain('thread');
  assert.equal(f.queue.list('thread', 'owner').length, 0);
  const failure = f.messages
    .getByThread('thread')
    .find((message) => message.lifecycle?.reason === 'no_available_target');
  assert.ok(failure);
  assert.match(failure.content, /没有可用/);
});
test('HTTP unavailable member falls back and same-ID retry retains admission', async (t) => {
  const f = fixture({ unavailable: true });
  const thread = f.threads.create('owner', 'owned');
  const app = Fastify();
  t.after(() => app.close());
  await app.register(messagesRoutes, {
    registry: f.registry,
    messageStore: f.messages,
    threadStore: f.threads,
    invocationQueue: f.queue,
    router: f.router,
    socketManager: { broadcastToRoom() {}, emitToUser() {}, broadcastAgentMessage() {} },
  });
  const request = {
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: thread.id, content: '@opus hello', idempotencyKey: randomUUID() },
  };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 202, first.body);
  assert.deepEqual(
    first.json().entries.map((entry) => entry.targetCatId),
    ['codex'],
  );
  const retry = await app.inject(request);
  assert.equal(retry.statusCode, 202, retry.body);
  assert.equal(retry.json().userMessageId, first.json().userMessageId);
  assert.equal(f.queue.list(thread.id, 'owner').length, 1);
});

test('common replay retains a legacy admission without a requested-target field', async () => {
  const messages = new MessageStore();
  const ledger = new InMemoryQueueLedgerStore();
  const [message, input] = envelope();
  const first = messages.appendWithQueueLedgerAdmission(
    message,
    (sourceId) =>
      createQueueLedgerAdmission({
        sourceId,
        messageId: sourceId,
        threadId: 'thread',
        owner: { kind: 'user', userId: 'owner' },
        kind: 'conversation_input',
        from: input.from,
        targetCatIds: ['opus'],
        content: 'hello',
        intent: 'execute',
        ownerAuthProvenance: 'strict',
        enqueuedAt: 100,
      }),
    ledger,
  );
  const queue = new InvocationQueue(ledger, { resolveTargets: async () => ['codex'] });
  const replay = await queue.send(messages, message, input);
  assert.equal(replay.message.id, first.message.id);
  assert.deepEqual(replay.entry.targets, ['opus']);
  assert.equal(replay.entry.payload.requestedTargetCats, undefined);
  assert.equal((await ledger.list('thread')).length, 1);
});

test('A2A wake retains the named target instead of ordinary conversation fallback', async () => {
  const f = fixture({ unavailable: true });
  const [message, input] = envelope(['opus'], '@opus hello');
  const from = { kind: 'agent', catId: 'codex' };
  const result = await f.queue.send(f.messages, { ...message, from }, { ...input, from, kind: 'message_wake' });
  assert.deepEqual(result.entry.targets, ['opus']);
  assert.equal(result.message.content, '@opus hello');
  await assert.rejects(
    f.queue.send(
      f.messages,
      { ...message, from, idempotencyKey: 'missing-wake' },
      { ...input, from, kind: 'message_wake', targetCats: [] },
    ),
    /exact target/,
  );
  assert.equal(f.messages.getByIdempotencyKey('owner', 'thread', 'missing-wake'), null);
});

for (const progress of ['requestDrain', 'processNext']) {
  test(`queued whisper cannot fall back after recipient becomes unavailable: ${progress}`, async () => {
    const f = fixture();
    const [message, input] = envelope(['opus'], 'private recipient-only text');
    const result = await f.queue.send(f.messages, { ...message, visibility: 'whisper', whisperTo: ['opus'] }, input);
    assert.deepEqual(result.entry.targets, ['opus']);
    f.agents.markUnavailable('opus', { code: 'rejected-account-binding', message: 'owned late failure' });
    f.router.refreshFromRegistry(f.agents);
    const deliveries = [];
    f.router.routeExecution = async function* (...args) {
      deliveries.push({ content: args[1], targets: args[4] });
    };
    const processor = new QueueProcessor({
      queue: f.queue,
      invocationTracker: new InvocationTracker(),
      messageStore: f.messages,
      router: f.router,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
      log: { info() {}, warn() {}, error() {} },
    });
    if (progress === 'requestDrain') await processor.requestDrain('thread');
    else await processor.processNext('thread', 'owner');
    assert.deepEqual(deliveries, []);
    assert.equal(f.queue.list('thread', 'owner').length, 0);
    assert.ok(f.messages.getByThread('thread').some((row) => row.lifecycle?.reason === 'invalid_explicit_target'));
  });
}
test('common whisper admission cannot authorize targets outside whisperTo', async () => {
  const f = fixture({ unavailable: true });
  const [message, input] = envelope(['codex'], 'private');
  await assert.rejects(
    f.queue.send(f.messages, { ...message, visibility: 'whisper', whisperTo: ['opus'] }, input),
    /authorized recipients/,
  );
  assert.equal(f.messages.getByThread('thread').length, 0);
  assert.equal(f.queue.list('thread', 'owner').length, 0);
  const permitted = await f.queue.send(
    f.messages,
    { ...message, mentions: ['opus'], visibility: 'whisper', whisperTo: ['opus'] },
    { ...input, targetCats: ['opus'] },
  );
  assert.deepEqual(permitted.entry.targets, ['opus']);
  const retries = await Promise.all(
    Array.from({ length: 4 }, () =>
      f.queue.send(
        f.messages,
        { ...message, mentions: ['opus'], visibility: 'whisper', whisperTo: ['opus'] },
        { ...input, targetCats: ['opus'] },
      ),
    ),
  );
  assert.ok(retries.every((retry) => retry.message.id === permitted.message.id && retry.entry.targets[0] === 'opus'));
});
