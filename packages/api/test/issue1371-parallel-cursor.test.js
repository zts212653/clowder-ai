import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleIncrementalContext } from '../dist/domains/cats/services/agents/routing/route-helpers.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { FreshnessOutputCommitCoordinator } from '../dist/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { adaptMessageStore } from './helpers/message-from-fixtures.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('#1371: a completed parallel target commits its delivery boundary before its sibling finishes', async () => {
  const messageStore = adaptMessageStore(new MessageStore());
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
    freshnessOutputCommitCoordinator: new FreshnessOutputCommitCoordinator({ messageStore }),
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

test('#1371: an explicit retry has exact source provenance while historical replies do not select a source', async () => {
  const messageStore = adaptMessageStore(new MessageStore());
  const source = messageStore.append({
    userId: 'user-1',
    threadId: 'thread-restart',
    catId: null,
    content: '@opus old source question',
    mentions: ['opus'],
    timestamp: 100,
  });
  messageStore.append({
    userId: 'user-1',
    threadId: 'thread-restart',
    catId: 'opus',
    content: 'Earlier reply completed.',
    mentions: [],
    origin: 'stream',
    timestamp: 101,
  });
  const deps = { messageStore, deliveryCursorStore: new DeliveryCursorStore(), invocationDeps: {} };
  const historical = await assembleIncrementalContext(deps, 'user-1', 'thread-restart', 'opus');
  assert.doesNotMatch(historical.navigationHeader, /本轮输入来源|传球/);
  const retry = await assembleIncrementalContext(deps, 'user-1', 'thread-restart', 'opus', source.id);
  assert.ok(retry.navigationHeader.includes(source.id));
  assert.ok(retry.includesCurrentUserMessage);
});
