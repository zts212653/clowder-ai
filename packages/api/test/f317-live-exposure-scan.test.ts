import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import {
  bindFreshnessNoticeBroker,
  FreshnessNoticeBroker,
} from '../src/domains/cats/services/freshness/FreshnessNoticeBroker.js';
import { ThreadUnseenChecker } from '../src/domains/cats/services/freshness/ThreadUnseenChecker.js';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';

const catId = createCatId('codex-astra');
function fixture(count: number, maxScanPages = 4, includeExpectedA2AReplies = false) {
  const store = new MessageStore();
  const base = {
    userId: 'owner',
    from: { kind: 'user' as const, userId: 'owner' },
    threadId: 'home',
    content: 'spoken',
    mentions: [],
    timestamp: 1,
  };
  const seed = store.append(base);
  const exposed = new Set<string>();
  for (let i = 0; i < count; i++) exposed.add(store.append({ ...base, timestamp: i + 2 }).id);
  let seen = cursorFor(seed);
  const checker = new ThreadUnseenChecker({
    userId: 'owner',
    messageStore: store,
    maxScanPages,
    includeExpectedA2AReplies,
    cursorStore: {
      getSeenCursor: async () => seen,
      updateSeenCursor: async () => assert.fail('scanner cannot mark messages seen'),
    },
    exposureReason: (message) => (exposed.has(message.id) ? 'same_live_call_exposure' : null),
  });
  return {
    store,
    checker,
    base,
    exposed,
    advance: (cursor: string) => {
      seen = cursor;
    },
  };
}

test('50 already-exposed ASR rows cannot hide the next external message; count and correlations exclude ASR', async () => {
  const f = fixture(50);
  const incoming = f.store.append({
    ...f.base,
    from: { kind: 'agent', catId: createCatId('codex-sol') },
    content: 'external reply',
    timestamp: 200,
  });
  f.exposed.add(f.store.append({ ...f.base, content: 'already heard after the reply', timestamp: 201 }).id);
  const result = await f.checker.checkUnseen({ threadId: 'home', catId });
  assert.ok(result && !('kind' in result));
  assert.equal(result.count, 1);
  assert.deepEqual(result.correlationMessageIds, [incoming.id]);
  assert.deepEqual(result.senders, ['codex-sol']);
  assert.equal(result.maxMessageId, cursorFor(incoming));
});

test('an attached Live call notices its expected downstream answer, while ordinary calls stay quiet', async () => {
  for (const live of [false, true]) {
    const f = fixture(0, 4, live);
    const handoff = f.store.append({
      ...f.base,
      from: { kind: 'agent', catId },
      mentions: [createCatId('opus5')],
      content: '@opus5 请读原文',
      timestamp: 2,
    });
    const reply = f.store.append({
      ...f.base,
      from: { kind: 'agent', catId: createCatId('opus5') },
      replyTo: handoff.id,
      content: 'Opus 5 的真实结论',
      timestamp: 3,
    });
    const result = await f.checker.checkUnseen({ threadId: 'home', catId });
    if (!live) {
      assert.equal(result, null);
      continue;
    }
    assert.ok(result && !('kind' in result), 'Live must resume when the requested cat actually answers');
    assert.deepEqual(result.correlationMessageIds, [reply.id]);
    f.advance(cursorFor(reply));
    assert.equal(
      await f.checker.checkUnseen({ threadId: 'home', catId }),
      null,
      'a read answer must not cause a notice loop',
    );
  }
});

test('same-call exposure alone exhausts without notice, while another call remains eligible', async () => {
  const f = fixture(51);
  assert.equal(await f.checker.checkUnseen({ threadId: 'home', catId }), null);
  const otherCall = f.store.append({ ...f.base, content: 'another call', timestamp: 200 });
  const result = await f.checker.checkUnseen({ threadId: 'home', catId });
  assert.ok(result && !('kind' in result));
  assert.deepEqual(result.correlationMessageIds, [otherCall.id]);
});

test('capped scans resume locally across idle boundaries without any attempted notice or cursor write', async () => {
  const f = fixture(120, 1);
  const incoming = f.store.append({
    ...f.base,
    from: { kind: 'agent', catId: createCatId('codex-sol') },
    content: 'external',
    timestamp: 300,
  });
  const events: unknown[] = [];
  const broker = bindFreshnessNoticeBroker(
    new FreshnessNoticeBroker({
      context: { threadId: 'home', catId, invocationId: 'call' },
      checkUnseen: () => f.checker.checkUnseen({ threadId: 'home', catId }),
      appendEvent: async (event) => {
        events.push(event);
      },
    }),
    { provider: 'openai_codex', carrier: 'codex_app_server', deliverySemantics: 'exact_active_turn' },
  );
  assert.ok(broker.idle);
  assert.equal(await broker.idle.prepare(), null);
  assert.equal(await broker.idle.prepare(), null);
  assert.equal(events.length, 0);
  const notice = await broker.idle.prepare();
  assert.ok(notice);
  assert.deepEqual(notice.correlationMessageIds, [incoming.id]);
  assert.equal(events.length, 2);
});

test('ordinary post-message does not resurrect the retired HELD gate or acknowledge unread Live input', async () => {
  const { default: Fastify } = await import('fastify');
  const { callbacksRoutes } = await import('../src/routes/callbacks.js');
  const { InvocationRegistry } = await import('../src/domains/cats/services/agents/invocation/InvocationRegistry.js');
  const f = fixture(50);
  const outside = f.store.append({
    ...f.base,
    from: { kind: 'agent', catId: createCatId('codex-sol') },
    content: 'owned synthetic external input',
    timestamp: 400,
  });
  const registry = new InvocationRegistry();
  const identity = await registry.create('owner', catId, 'home');
  let seenWrites = 0;
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: f.store,
    socketManager: { broadcastAgentMessage() {} },
    deliveryCursorStore: {
      getSeenCursor: async () => cursorFor(f.store.getByThread('home', 1000)[0]),
      ackSeenCursor: async () => {
        seenWrites++;
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': identity.invocationId, 'x-callback-token': identity.callbackToken },
      payload: { content: 'owned synthetic ordinary reply' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'ok');
    assert.equal(seenWrites, 0, 'posting a reply is not reading the pending input');
    const unread = await f.checker.checkUnseen({ threadId: 'home', catId });
    assert.ok(unread && !('kind' in unread));
    assert.deepEqual(unread.correlationMessageIds, [outside.id]);
  } finally {
    await app.close();
  }
});
