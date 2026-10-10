import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { AgentKeyRegistry } from '../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import {
  InvocationQueue,
  queueEntryTargetCats,
} from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { appendA2ASourceWithLedgerAdmission } from '../dist/routes/callback-a2a-trigger.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

async function harness(t, transport) {
  const registry = new InvocationRegistry();
  const agentKeyRegistry = new AgentKeyRegistry();
  const messageStore = new MessageStore();
  const invocationQueue = new InvocationQueue();
  const threadStore = new ThreadStore();
  const from = await threadStore.create('identity-owner', 'source');
  const to = await threadStore.create('identity-owner', 'destination');
  threadStore.addParticipants(to.id, ['opus', 'codex']);
  const auth = await registry.create('identity-owner', 'opus', from.id);
  const key = await agentKeyRegistry.issue('opus', 'identity-owner');
  const headers =
    transport === 'invocation'
      ? { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken }
      : { 'x-agent-key-secret': key.secret };
  const broadcasts = [];
  const app = Fastify();
  t.after(() => app.close());
  await app.register(callbacksRoutes, {
    registry,
    agentKeyRegistry,
    messageStore,
    invocationQueue,
    threadStore,
    socketManager: {
      broadcastAgentMessage(message) {
        broadcasts.push(message);
      },
      emitToUser() {},
    },
    router: {},
    invocationRecordStore: {},
    queueProcessor: {
      async requestDrain() {},
      async tryAutoAppendExactEntry() {
        return { outcome: 'rejected' };
      },
      registerCallerDispatchInitialTargets() {},
    },
  });
  const payload = { threadId: to.id, targetCats: ['codex'], content: 'same explicit cross-thread notice' };
  const post = (id, extra = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers,
      payload: { ...payload, clientMessageId: id, ...extra },
    });
  return { app, registry, agentKeyRegistry, messageStore, invocationQueue, to, post, broadcasts, payload, auth, key };
}

for (const transport of ['invocation', 'agent-key']) {
  test(`${transport}: same-ID concurrent A2A retry has one durable source and one target row`, async (t) => {
    const h = await harness(t, transport);
    const responses = await Promise.all([h.post('source-a'), h.post('source-a')]);
    assert.deepEqual(responses.map((r) => r.json().status).sort(), ['duplicate', 'ok']);
    assert.equal(responses[0].json().messageId, responses[1].json().messageId);
    assert.equal(h.messageStore.size, 1);
    const entries = h.invocationQueue.list(h.to.id, 'identity-owner');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].payload.messageId, responses[0].json().messageId);
    assert.equal(h.broadcasts.filter((m) => m.type === 'text').length, 1);
  });

  test(`${transport}: different-ID concurrent A2A notices retain two sources and two target rows`, async (t) => {
    const h = await harness(t, transport);
    const responses = await Promise.all([h.post('source-a'), h.post('source-b')]);
    assert.deepEqual(
      responses.map((r) => r.json().status),
      ['ok', 'ok'],
    );
    const ids = responses.map((r) => r.json().messageId);
    assert.equal(new Set(ids).size, 2);
    assert.equal(h.messageStore.size, 2);
    assert.deepEqual(
      h.invocationQueue
        .list(h.to.id, 'identity-owner')
        .map((e) => e.payload.messageId)
        .sort(),
      ids.sort(),
    );
  });

  test(`${transport}: failed atomic admission does not consume the message ID`, async (t) => {
    const h = await harness(t, transport);
    const realAdmission = h.invocationQueue.send.bind(h.invocationQueue);
    let fail = true;
    h.invocationQueue.send = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('isolated transaction failure');
      }
      return realAdmission(...args);
    };
    assert.equal((await h.post('source-recover')).statusCode, 500);
    assert.equal(h.messageStore.size, 0);
    assert.equal(h.invocationQueue.list(h.to.id, 'identity-owner').length, 0);
    const recovered = await h.post('source-recover');
    assert.equal(recovered.json().status, 'ok');
    const replay = await h.post('source-recover');
    assert.equal(replay.json().status, 'duplicate');
    assert.equal(replay.json().messageId, recovered.json().messageId);
    assert.equal(h.messageStore.size, 1);
    assert.equal(h.invocationQueue.list(h.to.id, 'identity-owner').length, 1);
  });

  test(`${transport}: replay uses original recipients instead of the replacement request`, async (t) => {
    const h = await harness(t, transport);
    const first = await h.post('original-recipient');
    const replay = await h.post('original-recipient', { targetCats: ['bengal'], content: 'replacement body' });
    assert.equal(replay.json().status, 'duplicate');
    assert.equal(replay.json().messageId, first.json().messageId);
    const entries = h.invocationQueue.list(h.to.id, 'identity-owner');
    assert.equal(entries.length, 1);
    assert.deepEqual(queueEntryTargetCats(entries[0]), ['codex']);
    assert.equal(h.messageStore.getById(first.json().messageId).content, h.payload.content);
  });
}

test('one durable source survives retry through another authenticated callback transport', async (t) => {
  const h = await harness(t, 'invocation');
  const first = await h.post('transport-stable-source');
  const replay = await h.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: { 'x-agent-key-secret': h.key.secret },
    payload: { ...h.payload, clientMessageId: 'transport-stable-source' },
  });
  assert.equal(replay.json().status, 'duplicate');
  assert.equal(replay.json().messageId, first.json().messageId);
  assert.equal(h.messageStore.size, 1);
  assert.equal(h.invocationQueue.list(h.to.id, 'identity-owner').length, 1);
});

test('different authenticated senders can independently use the same client message ID', async (t) => {
  const h = await harness(t, 'invocation');
  const first = await h.post('sender-local-source');
  const other = await h.agentKeyRegistry.issue('bengal', 'identity-owner');
  const second = await h.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: { 'x-agent-key-secret': other.secret },
    payload: { ...h.payload, clientMessageId: 'sender-local-source' },
  });
  assert.equal(first.json().status, 'ok');
  assert.equal(second.json().status, 'ok');
  assert.notEqual(first.json().messageId, second.json().messageId);
  assert.equal(h.messageStore.size, 2);
});

test('an admission with no accepted recipients still commits and replays the exact source once', async () => {
  const messageStore = new MessageStore();
  const message = {
    from: { kind: 'agent', catId: 'opus' },
    userId: 'identity-owner',
    threadId: 'no-accepted-targets',
    content: 'public source with exhausted fanout',
    mentions: ['codex'],
    timestamp: Date.now(),
    idempotencyKey: 'callback-empty-admission-source',
  };
  const options = {
    plan: { requestedTargetCats: ['codex'], acceptedTargetCats: [], streakTargetCats: [] },
    ownerAuthProvenance: 'unknown',
  };
  const results = await Promise.all([
    appendA2ASourceWithLedgerAdmission({ messageStore }, message, options),
    appendA2ASourceWithLedgerAdmission({ messageStore }, message, options),
  ]);
  assert.deepEqual(
    results.map((r) => r.preAdmittedReplayed),
    [false, true],
  );
  assert.equal(results[0].message.id, results[1].message.id);
  assert.equal(messageStore.size, 1);
});
