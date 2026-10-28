import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { AgentKeyRegistry } from '../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MemoryCloudReturnGrantStore } from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MessageSearchAnswerPublicationService } from '../dist/domains/memory/MessageSearchAnswerPublicationService.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { fixture, human } from './helpers/message-search-answer-fixture.js';

async function harness(t, transport, cloud = false) {
  const f = fixture();
  t.after(() => f.db.close());
  const threadStore = new ThreadStore();
  const origin = threadStore.create('owner', 'answer origin');
  const forward = threadStore.create('owner', 'answer forward');
  threadStore.addParticipants(forward.id, ['opus', 'codex']);
  f.threads.set(origin.id, origin);
  f.threads.set(forward.id, forward);
  const cloudReturnGrantStore = new MemoryCloudReturnGrantStore();
  const question = f.messages.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: origin.id,
    content: 'How did we decide?',
    mentions: [],
    timestamp: Date.now(),
  });
  const catId = cloud ? 'gpt-pro' : 'opus';
  if (cloud)
    await cloudReturnGrantStore.issue({
      userId: 'owner',
      threadId: origin.id,
      sourceMessageId: question.id,
      targetCatId: catId,
      dispatchInvocationId: 'cloud-return-purpose',
    });
  const registry = new InvocationRegistry();
  const agentKeyRegistry = new AgentKeyRegistry();
  const auth = await registry.create('owner', catId, origin.id);
  const key = await agentKeyRegistry.issue(catId, 'owner', cloud ? { scope: 'cloud-conversation' } : undefined);
  const headers =
    transport === 'invocation'
      ? { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken }
      : { 'x-agent-key-secret': key.secret };
  const producer =
    transport === 'invocation'
      ? { kind: 'invocation', id: auth.invocationId, catId: 'opus' }
      : { kind: 'agent_key', id: key.id, catId: 'opus' };
  const service = new MessageSearchAnswerPublicationService(f.store, f.search, f.messages, threadStore);
  const app = Fastify();
  t.after(() => app.close());
  await app.register(callbacksRoutes, {
    registry,
    cloudReturnGrantStore,
    agentKeyRegistry,
    messageStore: f.messages,
    threadStore,
    messageSearchAnswerService: service,
    messageSearchService: f.search,
    router: {},
    invocationRecordStore: {},
    invocationQueue: new InvocationQueue(),
    queueProcessor: {
      async requestDrain() {},
      async tryAutoAppendExactEntry() {
        return { outcome: 'rejected' };
      },
      registerCallerDispatchInitialTargets() {},
    },
    socketManager: { broadcastAgentMessage() {}, emitToUser() {} },
  });
  const prepare = () =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/search-evidence/answer',
      headers,
      payload: {
        operationId: 'same-answer',
        q: 'piano',
        mode: 'lexical',
        resultUnit: 'message',
        destinationThreadId: origin.id,
        ...(cloud ? { replyTo: question.id } : {}),
      },
    });
  const send = (publicationRef, extra = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers,
      payload: {
        content: 'Here are the original sources.',
        clientMessageId: 'same-message',
        threadId: origin.id,
        searchAnswer: { publicationRef },
        ...(cloud ? { replyTo: question.id } : {}),
        ...extra,
      },
    });
  return { ...f, service, app, headers, producer, origin, forward, prepare, send, cloudReturnGrantStore, question };
}

for (const transport of ['invocation', 'agent-key']) {
  test(`${transport}: prepare and explicit post recover a lost binding response through the same durable message`, async (t) => {
    const h = await harness(t, transport);
    const prepared = await h.prepare();
    assert.equal(prepared.statusCode, 200, prepared.body);
    const ref = prepared.json().publicationRef;
    const attach = h.messages.attachMessageSearchAnswer.bind(h.messages);
    h.messages.attachMessageSearchAnswer = () => {
      throw new Error('isolated lost response after claim');
    };
    assert.equal((await h.send(ref)).statusCode, 500);
    h.messages.attachMessageSearchAnswer = attach;
    const retried = await h.send(ref);
    assert.equal(retried.statusCode, 200, retried.body);
    const messageId = retried.json().messageId;
    const stored = h.messages.getById(messageId);
    assert.ok(stored.extra.messageSearchAnswer);
    assert.equal(stored.extra.rich.blocks.filter((block) => block.meta?.domain === 'message-search-answer').length, 1);
    assert.equal((await h.send(ref)).json().messageId, messageId);
    assert.equal((await h.prepare()).json().publicationRef, ref);
    assert.equal(h.searches(), 1);
    assert.equal(h.calls(), 0);
    assert.equal(
      (await h.service.read(messageId, stored.extra.messageSearchAnswer.blockId, human)).status,
      'available',
    );
    const replacement = await h.send(ref, { clientMessageId: 'another-message' });
    assert.equal(replacement.statusCode, 409, replacement.body);
  });
  test(`${transport}: an explicit forward re-admits a new destination and rejects a copied unbound ref`, async (t) => {
    const h = await harness(t, transport);
    const ref = (await h.prepare()).json().publicationRef;
    const first = await h.send(ref);
    assert.equal(first.statusCode, 200, first.body);
    const messageId = first.json().messageId;
    const binding = h.messages.getById(messageId).extra.messageSearchAnswer;
    const copied = await h.send(ref, { clientMessageId: 'copy', threadId: h.forward.id, targetCats: ['codex'] });
    assert.equal(copied.statusCode, 409, copied.body);
    const forwarded = await h.send(ref, {
      clientMessageId: 'forward',
      threadId: h.forward.id,
      targetCats: ['codex'],
      searchAnswer: { publicationRef: ref, source: { messageId, blockId: binding.blockId } },
    });
    assert.equal(forwarded.statusCode, 200, forwarded.body);
    const actual = h.messages.getById(forwarded.json().messageId);
    assert.equal(actual.extra.messageSearchAnswer.forwardedFromMessageId, messageId);
    assert.equal(h.searches(), 1);
    assert.equal(h.calls(), 0);
  });
}

test('agent-key publication requires an explicit destination separate from search scope', async (t) => {
  const h = await harness(t, 'agent-key');
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/callbacks/search-evidence/answer',
    headers: h.headers,
    payload: { operationId: 'missing-target', q: 'piano', resultUnit: 'message', threadId: h.origin.id },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(h.searches(), 0);
});

test('an invocation cannot retarget preparation away from its authenticated answer thread', async (t) => {
  const h = await harness(t, 'invocation');
  const result = await h.app.inject({
    method: 'POST',
    url: '/api/callbacks/search-evidence/answer',
    headers: h.headers,
    payload: { operationId: 'wrong-destination', q: 'piano', resultUnit: 'message', destinationThreadId: h.forward.id },
  });
  assert.equal(result.statusCode, 403, result.body);
  assert.equal(h.searches(), 0);
});

test('cloud prepare uses the existing exact-source grant; retry after actual return does not claim or search again', async (t) => {
  const h = await harness(t, 'agent-key', true);
  let claims = 0;
  const claim = h.cloudReturnGrantStore.claim.bind(h.cloudReturnGrantStore);
  h.cloudReturnGrantStore.claim = async (...args) => {
    claims++;
    return claim(...args);
  };
  const prepared = await h.prepare();
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(claims, 1);
  assert.equal(h.searches(), 1);
  const first = await h.send(prepared.json().publicationRef);
  assert.equal(first.statusCode, 200, first.body);
  const claimsAfterPost = claims;
  assert.equal((await h.prepare()).json().publicationRef, prepared.json().publicationRef);
  assert.equal(claims, claimsAfterPost);
  assert.equal(h.searches(), 1);
  assert.equal((await h.send(prepared.json().publicationRef)).json().messageId, first.json().messageId);
  assert.equal(h.calls(), 0);
});
