import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleIncrementalContext } from '../dist/domains/cats/services/agents/routing/route-helpers.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { InMemoryFreshnessClosureStore } from '../dist/domains/cats/services/freshness/closure/FreshnessClosureStore.js';
import { FreshnessOutputCommitCoordinator } from '../dist/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('#1371: a completed parallel target commits its delivery boundary before its sibling finishes', async () => {
  const messageStore = new MessageStore();
  const deliveryCursorStore = new DeliveryCursorStore();
  const source = await messageStore.append({
    userId: 'user-1',
    threadId: 'thread-1',
    catId: null,
    content: '@opus @codex think independently',
    mentions: ['opus', 'codex'],
    timestamp: Date.now(),
  });
  const siblingGate = deferred();
  const firstDone = deferred();
  const boundaries = new Map();
  const events = [];
  let sequence = 0;
  const deps = {
    services: Object.fromEntries(
      ['opus', 'codex'].map((catId) => [
        catId,
        {
          supportsToolExecutionPolicy: () => true,
          async *invoke() {
            if (catId === 'codex') await siblingGate.promise;
            yield { type: 'text', catId, content: `${catId} completed answer`, timestamp: Date.now() };
            yield { type: 'done', catId, timestamp: Date.now() };
          },
        },
      ]),
    ),
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `child-${++sequence}`, callbackToken: 'test-token' }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3102',
    },
    messageStore,
    deliveryCursorStore,
    freshnessOutputCommitCoordinator: new FreshnessOutputCommitCoordinator({
      messageStore,
      closureStore: new InMemoryFreshnessClosureStore(),
    }),
    socketManager: { broadcastToRoom() {} },
  };
  const execution = (async () => {
    for await (const event of routeParallel(deps, ['opus', 'codex'], source.content, 'user-1', 'thread-1', {
      currentUserMessageId: source.id,
      cursorBoundaries: boundaries,
      thinkingMode: 'play',
      persistenceContext: { failed: false, errors: [] },
    })) {
      events.push(event);
      if (event.type === 'done' && event.catId === 'opus') firstDone.resolve();
    }
  })();
  try {
    await Promise.race([
      firstDone.promise,
      execution.then(() => {
        throw new Error('missing first target completion');
      }),
    ]);
    const reply = (await messageStore.getByThread('thread-1')).find((message) => message.catId === 'opus');
    assert.ok(reply, 'first target reply is already durable');
    assert.equal(reply.extra.causal.triggerMessageId, source.id);
    assert.ok(boundaries.get('opus'), 'the target has an exact collected delivery boundary');
    assert.equal(
      events.some((event) => event.type === 'done' && event.catId === 'codex'),
      false,
    );
    assert.equal(await deliveryCursorStore.getCursor('user-1', 'codex', 'thread-1'), undefined);
    assert.equal(
      await deliveryCursorStore.getCursor('user-1', 'opus', 'thread-1'),
      boundaries.get('opus'),
      'durable target completion must not wait for the sibling/batch cursor finalizer',
    );
  } finally {
    siblingGate.resolve();
    await execution;
  }
});

async function appendScenarioReply(messageStore, source, scenario) {
  const reply = await messageStore.append({
    userId: scenario.userId ?? 'user-1',
    threadId: scenario.threadId ?? 'thread-restart',
    catId: scenario.catId ?? 'opus',
    content: scenario.content ?? 'The requested answer is complete.',
    mentions: [],
    timestamp: 101,
    origin: 'stream',
    ...(scenario.canceled ? { deliveryStatus: 'queued' } : {}),
    extra: {
      stream: { invocationId: 'parent', ...(scenario.omitChild ? {} : { turnInvocationId: 'child-opus' }) },
      ...(scenario.omitSource
        ? {}
        : { causal: { kind: 'invocation_reply', triggerMessageId: scenario.wrongSource ? 'unrelated' : source.id } }),
    },
  });
  if (scenario.canceled) await messageStore.markCanceled(reply.id);
}

for (const scenario of [
  { name: 'unanswered', replied: false, expectedBaton: true },
  { name: 'exact own reply', replied: true, expectedBaton: false },
  { name: 'explicit retry', replied: true, explicitRetry: true, expectedBaton: true },
  { name: 'other cat reply', replied: true, catId: 'codex', expectedBaton: true },
  { name: 'other tenant reply', replied: true, userId: 'user-2', expectedBaton: true },
  { name: 'other thread reply', replied: true, threadId: 'thread-other', expectedBaton: true },
  { name: 'unbound child', replied: true, omitChild: true, expectedBaton: true },
  { name: 'unbound source', replied: true, omitSource: true, expectedBaton: true },
  { name: 'wrong source', replied: true, wrongSource: true, expectedBaton: true },
  { name: 'canceled reply', replied: true, canceled: true, expectedBaton: true },
  { name: 'empty output', replied: true, content: '', expectedBaton: true },
  { name: 'failed partial output', replied: true, status: 'failed', expectedBaton: true },
  { name: 'interrupted output', replied: true, status: 'interrupted', expectedBaton: true },
  { name: 'still running output', replied: true, status: 'running', expectedBaton: true },
  { name: 'unknown child outcome', replied: true, omitRecord: true, expectedBaton: true },
  { name: 'wrong child record source', replied: true, wrongRecordSource: true, expectedBaton: true },
]) {
  test(`#1371: cold navigation distinguishes ${scenario.name}`, async () => {
    const messageStore = new MessageStore();
    const source = await messageStore.append({
      userId: 'user-1',
      threadId: 'thread-restart',
      catId: null,
      content: '@opus old source question',
      mentions: ['opus'],
      timestamp: 100,
    });
    if (scenario.replied) {
      await appendScenarioReply(messageStore, source, scenario);
    }
    const turnExecutionStore = new InMemoryTurnExecutionStore();
    if (scenario.replied && !scenario.omitRecord) {
      turnExecutionStore.createRunning({
        invocationId: 'child-opus',
        parentInvocationId: 'parent',
        threadId: 'thread-restart',
        userId: 'user-1',
        catId: 'opus',
        executionKind: 'ordinary',
        startedAt: 100,
        causal: { triggerMessageId: scenario.wrongRecordSource ? 'foreign-source' : source.id },
      });
      if (scenario.status !== 'running')
        turnExecutionStore.transitionTerminal('child-opus', {
          status: scenario.status ?? 'succeeded',
          endedAt: 102,
          ...(scenario.status ? { terminalReason: 'controlled failure' } : {}),
        });
    }
    const context = await assembleIncrementalContext(
      {
        messageStore,
        deliveryCursorStore: new DeliveryCursorStore(),
        invocationDeps: { turnExecutionStore },
      },
      'user-1',
      'thread-restart',
      'opus',
      scenario.explicitRetry ? source.id : undefined,
    );
    assert.equal(
      context.navigationHeader?.includes('old source question') ?? false,
      scenario.expectedBaton,
      'only the exact answered source may leave navigation; explicit retry and independent sources remain reachable',
    );
  });
}
