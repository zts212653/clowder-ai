import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { safeParseExtra } from '../src/domains/cats/services/stores/redis/redis-message-parsers.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import { messagesRoutes } from '../src/routes/messages.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.js';

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('bounded Queue admission did not converge');
}
async function fixture(t, settings = {}) {
  const messages = new MessageStore();
  if (settings.loseResponseAck) {
    const append = messages.appendAndObservePriorFrontier.bind(messages);
    messages.appendAndObservePriorFrontier = (input) => {
      const committed = append(input);
      if (input.lifecycle?.kind === 'response') throw new Error('fixture durable write acknowledgement lost');
      return committed;
    };
    if (settings.unknownRead) {
      const read = messages.getByIdempotencyKey.bind(messages);
      messages.getByIdempotencyKey = (owner, thread, key) => {
        if (key.startsWith('message-lifecycle-response:')) throw new Error('fixture durable read unavailable');
        return read(owner, thread, key);
      };
    }
  }
  const sessions = new LiveCompanionSessions();
  let nativeStarts = 0;
  let received;
  const h = createPersistedQueueFixture(messages, {
    liveCompanionSessions: sessions,
    async onExecution(options) {
      assert.ok(options.liveCompanion, 'no ordinary text fallback');
      received = options.liveCompanion;
      nativeStarts++;
      await received.ready('native', {
        request: async () => ({}),
        submitText: async () => {
          assert.fail('text fallback');
        },
      });
      if (settings.providerFails) throw new Error('fixture native startup failed after delivery');
    },
  });
  const app = Fastify();
  await app.register(messagesRoutes, {
    registry: { active: () => new Set() },
    messageStore: messages,
    invocationQueue: h.queue,
    queueProcessor: h.processor,
    invocationTracker: h.tracker,
    router: {
      async resolveExplicitTargets(targets) {
        await settings.routingBarrier?.();
        return [...targets];
      },
      async resolveTargetsAndIntent() {
        return { targetCats: [createCatId('codex')], intent: { intent: 'execute', explicit: true }, hasMentions: true };
      },
      async resolveConversationTargetsAtAdmission(targets) {
        return [...targets];
      },
    },
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
  });
  t.after(async () => {
    await h.close();
    await sessions.close();
    await app.close();
  });
  async function prepare(
    callId = 'call',
    owner = 'owner',
    thread = 'thread',
    cat = 'codex',
    verifyCompanion = async () => true,
  ) {
    return sessions.prepare({
      binding: { userId: owner, threadId: thread, catId: cat, callId },
      messageStore: messages,
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      verifyNativeBinding: async () => true,
      verifyCompanion,
      publish() {},
    });
  }
  async function send(key = 'key', handle = 'call', target = 'codex', thread = 'thread') {
    const idempotencyKey = {
      key: '11111111-1111-4111-8111-111111111111',
      first: '22222222-2222-4222-8222-222222222222',
      second: '33333333-3333-4333-8333-333333333333',
    }[key];
    return app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner', 'x-cat-cafe-live-session': handle },
      payload: { content: '@codex 开始交流', threadId: thread, idempotencyKey, mentions: [target] },
    });
  }
  return { ...h, app, sessions, prepare, send, nativeStarts: () => nativeStarts, received: () => received };
}
test('Live uses actual Queue and one response; accepted-key replay never claims again or starts another call', async (t) => {
  const h = await fixture(t);
  await h.prepare();
  const admission = await h.send();
  assert.equal(admission.statusCode, 202, admission.body);
  const id = admission.json().userMessageId;
  await h.waitForAwakening(id);
  assert.equal(h.nativeStarts(), 1);
  assert.equal((await h.send()).json().userMessageId, id);
  assert.equal((await h.send('key', 'different')).statusCode, 409);
  assert.equal((await h.send('key', 'call', 'opus')).statusCode, 409);
  assert.equal(h.nativeStarts(), 1);
  assert.equal(h.queue.list('thread', 'owner').length, 0);
  assert.equal(
    h.messages.getByThread('thread', 30, 'owner').filter((m) => m.lifecycle?.kind === 'delivery_failure').length,
    0,
  );
});
for (const scenario of [
  'missing-handle',
  'wrong-owner',
  'wrong-thread',
  'wrong-target',
  'busy',
  'stopped',
  'selection',
]) {
  test(`Live ${scenario} yields exactly one undelivered result, zero media or text executions`, async (t) => {
    const h = await fixture(t);
    if (scenario !== 'missing-handle') {
      const call = await h.prepare(
        'call',
        scenario === 'wrong-owner' ? 'sibling' : 'owner',
        scenario === 'wrong-thread' ? 'foreign' : 'thread',
        scenario === 'wrong-target' ? 'opus' : 'codex',
        async () => scenario !== 'selection',
      );
      if (scenario === 'stopped') await call.stop();
    }
    if (scenario === 'busy') h.tracker.startAll('thread', ['codex'], 'owner', 'sibling');
    const admission = await h.send();
    assert.equal(admission.statusCode, 202, admission.body);
    await until(
      () =>
        h.queue.list('thread', 'owner').length === 0 &&
        h.messages.getByThread('thread', 30, 'owner').some((m) => m.lifecycle?.kind === 'delivery_failure'),
    );
    const rows = h.messages.getByThread('thread', 30, 'owner');
    assert.equal(rows.filter((m) => m.lifecycle?.kind === 'delivery_failure').length, 1);
    assert.equal(rows.filter((m) => m.lifecycle?.kind === 'response').length, 0);
    assert.equal(h.nativeStarts(), 0);
    assert.equal(h.queue.list('thread', 'owner').length, 0);
    if (scenario === 'busy') assert.equal(h.tracker.getExecutionId('thread', 'codex'), 'sibling');
    if (scenario === 'wrong-owner') assert.equal(h.sessions.get('call', 'sibling')?.status().state, 'preparing');
    assert.equal((await h.send()).json().userMessageId, admission.json().userMessageId);
  });
}
test('different accepted keys compete for one handle; losing key cannot stop the winner', async (t) => {
  const h = await fixture(t);
  await h.prepare();
  const [a, b] = await Promise.all([h.send('first'), h.send('second')]);
  await until(
    () =>
      h.nativeStarts() === 1 &&
      h.messages.getByThread('thread', 30, 'owner').some((m) => m.lifecycle?.kind === 'delivery_failure'),
  );
  assert.equal(a.statusCode, 202);
  assert.equal(b.statusCode, 202);
  assert.equal(h.nativeStarts(), 1);
  assert.equal(h.received().status().state, 'ready');
  assert.equal(
    h.messages.getByThread('thread', 30, 'owner').filter((m) => m.lifecycle?.kind === 'delivery_failure').length,
    1,
  );
});
test('concurrent replay with another handle conflicts instead of starting another call', async (t) => {
  let arrivals = 0;
  let release;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await fixture(t, {
    async routingBarrier() {
      if (++arrivals === 2) release();
      await both;
    },
  });
  await h.prepare('call');
  const sibling = await h.prepare('different', 'sibling');
  const [a, b] = await Promise.all([h.send('key', 'call'), h.send('key', 'different')]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [202, 409]);
  await until(() => h.nativeStarts() === 1);
  assert.equal(h.nativeStarts(), 1);
  assert.equal(h.messages.getByThread('thread', 30, 'owner').filter((m) => m.lifecycle?.kind === 'input').length, 1);
  const winner = h.received();
  const loser = winner === sibling ? h.sessions.get('call', 'owner') : sibling;
  assert.equal(loser?.status().state, 'preparing');
});
test('failure after durable delivery belongs to original response, never an undelivered notice', async (t) => {
  const h = await fixture(t, { providerFails: true });
  await h.prepare();
  const admission = await h.send();
  await until(() =>
    h.messages
      .getByThread('thread', 30, 'owner')
      .some((m) => m.lifecycle?.kind === 'response' && m.lifecycle.status !== 'processing'),
  );
  const rows = h.messages.getByThread('thread', 30, 'owner');
  assert.equal(rows.filter((m) => m.lifecycle?.kind === 'response').length, 1);
  assert.equal(rows.filter((m) => m.lifecycle?.kind === 'delivery_failure').length, 0);
  assert.equal((await h.send()).json().userMessageId, admission.json().userMessageId);
  assert.equal(h.nativeStarts(), 1);
});
test('Live immutable receipt survives Redis extra codec, without media or credentials', () => {
  assert.deepEqual(safeParseExtra(JSON.stringify({ liveAdmission: { sessionId: 'call', targetId: 'codex' } })), {
    liveAdmission: { sessionId: 'call', targetId: 'codex' },
  });
  assert.equal(safeParseExtra(JSON.stringify({ liveAdmission: { sessionId: '', targetId: 'codex' } })), undefined);
});
for (const race of ['idle-to-busy', 'stop', 'permissions']) {
  test(`actual Queue claim rejects ${race} during companion verification without touching sibling execution`, async (t) => {
    const h = await fixture(t);
    let finishVerification;
    let verifying;
    const started = new Promise<void>((resolve) => {
      verifying = resolve;
    });
    const call = await h.prepare('call', 'owner', 'thread', 'codex', () => {
      verifying();
      return new Promise((resolve) => {
        finishVerification = resolve;
      });
    });
    const admission = await h.send();
    await started;
    let permission;
    let finishSave;
    if (race === 'idle-to-busy') h.tracker.startAll('thread', ['codex'], 'owner', 'sibling');
    if (race === 'stop') await call.stop();
    if (race === 'permissions')
      permission = h.sessions.withOwnerPreferenceChange(
        'owner',
        () =>
          new Promise((resolve) => {
            finishSave = resolve;
          }),
        async () => false,
      );
    finishVerification(true);
    await until(() =>
      h.messages.getByThread('thread', 30, 'owner').some((m) => m.lifecycle?.kind === 'delivery_failure'),
    );
    assert.equal(h.nativeStarts(), 0);
    assert.equal(h.queue.list('thread', 'owner').length, 0);
    assert.equal((await h.send()).json().userMessageId, admission.json().userMessageId);
    if (race === 'idle-to-busy') assert.equal(h.tracker.getExecutionId('thread', 'codex'), 'sibling');
    if (permission) {
      finishSave();
      await permission;
    }
  });
}
test('durable response acknowledgement loss reads back the exact response and starts media once', async (t) => {
  const h = await fixture(t, { loseResponseAck: true });
  await h.prepare();
  const admission = await h.send();
  await h.waitForAwakening(admission.json().userMessageId);
  assert.equal(h.nativeStarts(), 1);
  assert.equal((await h.send()).json().userMessageId, admission.json().userMessageId);
  assert.equal(h.messages.getByThread('thread', 30, 'owner').filter((m) => m.lifecycle?.kind === 'response').length, 1);
  assert.equal(
    h.messages.getByThread('thread', 30, 'owner').filter((m) => m.lifecycle?.kind === 'delivery_failure').length,
    0,
  );
});
test('unknown durable response acknowledgement preserves original Queue claim, without new call or false failure', async (t) => {
  const h = await fixture(t, { loseResponseAck: true, unknownRead: true });
  await h.prepare();
  const admission = await h.send();
  await until(
    () =>
      h.queue.list('thread', 'owner').some((entry) => entry.status === 'claimed') &&
      h.sessions.readStatus('call', 'owner') === undefined,
  );
  const before = h.queue.list('thread', 'owner')[0];
  assert.equal(h.nativeStarts(), 0);
  await h.processor.requestDrain('thread');
  assert.equal(h.queue.list('thread', 'owner')[0].claimId, before.claimId);
  assert.equal((await h.send()).json().userMessageId, admission.json().userMessageId);
  assert.equal(
    h.messages.getByThread('thread', 30, 'owner').filter((m) => m.lifecycle?.kind === 'delivery_failure').length,
    0,
  );
});
test('closing after delivery does not requeue or create another undelivered result', async (t) => {
  const h = await fixture(t);
  await h.prepare();
  const admission = await h.send();
  await h.waitForAwakening(admission.json().userMessageId);
  await h.received().stop();
  await h.close();
  await until(() => !h.tracker.has('thread', 'codex'));
  await h.processor.requestDrain('thread');
  const rows = h.messages.getByThread('thread', 30, 'owner');
  assert.equal(rows.filter((m) => m.lifecycle?.kind === 'response').length, 1);
  assert.equal(rows.filter((m) => m.lifecycle?.kind === 'delivery_failure').length, 0);
  assert.equal(h.nativeStarts(), 1);
});

test('slot becoming busy during record persistence rejects Live before native claim', async (t) => {
  const h = await fixture(t);
  const call = await h.prepare();
  const create = h.records.create.bind(h.records);
  h.records.create = (input) => {
    const record = create(input);
    h.tracker.startAll('thread', ['codex'], 'owner', 'sibling');
    return record;
  };
  await h.send();
  await until(
    () =>
      h.queue.list('thread', 'owner').length === 0 &&
      h.messages.getByThread('thread', 30, 'owner').some((m) => m.lifecycle?.kind === 'delivery_failure'),
  );
  assert.equal(h.nativeStarts(), 0);
  assert.equal(h.tracker.getExecutionId('thread', 'codex'), 'sibling');
  await until(() => call.status().state === 'closed');
  assert.equal(call.status().state, 'closed');
  assert.equal(
    h.messages.getByThread('thread', 30, 'owner').filter((m) => m.lifecycle?.kind === 'delivery_failure').length,
    1,
  );
});

for (const delivered of [false, true]) {
  test(`cold Queue hydration ${delivered ? 'recovers original response' : 'rejects missing ephemeral handle'} without media resurrection`, async (t) => {
    const h = await fixture(t);
    await h.prepare();
    const drain = h.processor.requestDrain.bind(h.processor);
    h.processor.requestDrain = async () => {};
    const admission = await h.send();
    const rows = await h.ledger.list('thread');
    assert.equal(rows.length, 1);
    if (delivered) {
      await drain('thread');
      await h.waitForAwakening(admission.json().userMessageId);
      await h.close();
    }
    await h.sessions.close();
    const recoveredLedger = new InMemoryQueueLedgerStore();
    await recoveredLedger.enqueue(rows);
    const coldSessions = new LiveCompanionSessions();
    const cold = createPersistedQueueFixture(h.messages, {
      ledger: recoveredLedger,
      liveCompanionSessions: coldSessions,
      async onExecution() {
        assert.fail('cold handle cannot reconstruct media or fall back to text');
      },
    });
    t.after(async () => {
      await cold.close();
      await coldSessions.close();
    });
    await cold.queue.hydrateFromLedger(h.messages);
    await cold.processor.requestDrain('thread');
    await until(() => cold.queue.list('thread', 'owner').length === 0);
    const history = h.messages.getByThread('thread', 30, 'owner');
    assert.equal(history.filter((m) => m.lifecycle?.kind === 'response').length, delivered ? 1 : 0);
    assert.equal(history.filter((m) => m.lifecycle?.kind === 'delivery_failure').length, delivered ? 0 : 1);
    assert.equal(cold.starts.length, 0);
    assert.equal((await h.send()).json().userMessageId, admission.json().userMessageId);
  });
}
