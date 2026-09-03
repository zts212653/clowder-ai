import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore, deriveGrowingSourceMessageRevision } = await import(
  '../../dist/domains/cats/services/stores/ports/MessageStore.js'
);
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { registerCustodyOfferRoutes } = await import('../../dist/routes/custody-offer-routes.js');

function appendSource(store, overrides = {}) {
  return store.append({
    userId: 'owner-1',
    catId: null,
    content: 'Please prepare a reviewable presentation next week.',
    contentBlocks: [{ type: 'text', text: 'Please prepare a reviewable presentation next week.' }],
    mentions: ['codex-sol'],
    timestamp: 1_788_190_000_000,
    threadId: 'thread-f310',
    ...overrides,
  });
}

async function harness() {
  const app = Fastify();
  const messageStore = new MessageStore();
  const taskStore = new TaskStore();
  const callbackRegistry = new InvocationRegistry();
  const events = [];
  registerCustodyOfferRoutes(app, {
    messageStore,
    taskStore,
    callbackRegistry,
    socketManager: {
      broadcastToRoom(room, event, data) {
        events.push({ room, event, data });
      },
    },
    now: () => 1_788_190_000_100,
  });
  await app.ready();
  const credentials = await callbackRegistry.create('owner-1', 'codex-sol', 'thread-f310');
  return { app, messageStore, taskStore, events, credentials };
}

function callbackHeaders(credentials) {
  return {
    'x-invocation-id': credentials.invocationId,
    'x-callback-token': credentials.callbackToken,
  };
}

describe('F310 source conversation custody routes', () => {
  test('implicit recognition creates one source offer and acceptance admits one Task idempotently', async () => {
    const { app, messageStore, taskStore, events, credentials } = await harness();
    const source = appendSource(messageStore);

    const recognized = await app.inject({
      method: 'POST',
      url: '/api/callbacks/custody-offers',
      headers: callbackHeaders(credentials),
      payload: { sourceMessageId: source.id, reasonCode: 'future_deliverable' },
    });
    assert.equal(recognized.statusCode, 200);
    assert.equal(recognized.json().offer.disposition, 'pending');
    assert.equal(recognized.json().sourceMessageRevision, deriveGrowingSourceMessageRevision(source));

    const visible = await app.inject({
      method: 'GET',
      url: `/api/messages/${source.id}/custody-offer`,
      headers: { 'x-cat-cafe-user': 'owner-1' },
    });
    assert.equal(visible.statusCode, 200);
    assert.deepEqual(visible.json().offer, recognized.json().offer);

    const decision = {
      sourceMessageRevision: recognized.json().sourceMessageRevision,
      offerId: recognized.json().offer.offerId,
    };
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/messages/${source.id}/custody-offer/accept`,
      headers: { 'x-cat-cafe-user': 'owner-1' },
      payload: decision,
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().offer.admission.state, 'resulted');
    assert.equal(accepted.json().offer.admission.result.result, 'admitted');

    const replay = await app.inject({
      method: 'POST',
      url: `/api/messages/${source.id}/custody-offer/accept`,
      headers: { 'x-cat-cafe-user': 'owner-1' },
      payload: decision,
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().transitioned, false);
    assert.equal((await taskStore.listByThread('thread-f310')).length, 1);
    assert.equal(events.filter(({ event }) => event === 'custody_offer_updated').length, 2);
    assert.equal(events.filter(({ event }) => event === 'task_created').length, 1);
    await app.close();
  });

  test('decline is terminal without Task admission and a foreign owner cannot read or mutate it', async () => {
    const { app, messageStore, taskStore, credentials } = await harness();
    const source = appendSource(messageStore);
    const recognized = await app.inject({
      method: 'POST',
      url: '/api/callbacks/custody-offers',
      headers: callbackHeaders(credentials),
      payload: { sourceMessageId: source.id, reasonCode: 'follow_up_commitment' },
    });
    const body = recognized.json();
    const declined = await app.inject({
      method: 'POST',
      url: `/api/messages/${source.id}/custody-offer/refuse`,
      headers: { 'x-cat-cafe-user': 'owner-1' },
      payload: {
        sourceMessageRevision: body.sourceMessageRevision,
        offerId: body.offer.offerId,
        disposition: 'declined',
      },
    });
    assert.equal(declined.statusCode, 200);
    assert.equal(declined.json().offer.disposition, 'declined');
    assert.equal((await taskStore.listByThread('thread-f310')).length, 0);

    const foreignRead = await app.inject({
      method: 'GET',
      url: `/api/messages/${source.id}/custody-offer`,
      headers: { 'x-cat-cafe-user': 'owner-2' },
    });
    assert.equal(foreignRead.statusCode, 404);
    await app.close();
  });

  test('accepted clarification stays source-local and the cat retries with the original key', async () => {
    const { app, messageStore, taskStore, credentials } = await harness();
    const source = appendSource(messageStore, { content: '', contentBlocks: [] });
    const recognized = await app.inject({
      method: 'POST',
      url: '/api/callbacks/custody-offers',
      headers: callbackHeaders(credentials),
      payload: { sourceMessageId: source.id, reasonCode: 'future_deliverable' },
    });
    const offered = recognized.json();
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/messages/${source.id}/custody-offer/accept`,
      headers: { 'x-cat-cafe-user': 'owner-1' },
      payload: { sourceMessageRevision: offered.sourceMessageRevision, offerId: offered.offer.offerId },
    });
    assert.equal(accepted.json().offer.admission.result.result, 'needs_clarification');
    assert.equal((await taskStore.listByThread('thread-f310')).length, 0);
    const originalKey = accepted.json().offer.admission.idempotencyKey;

    const retried = await app.inject({
      method: 'POST',
      url: '/api/callbacks/custody-offers/retry-admission',
      headers: callbackHeaders(credentials),
      payload: {
        sourceMessageId: source.id,
        sourceMessageRevision: offered.sourceMessageRevision,
        offerId: offered.offer.offerId,
        title: 'Prepare the presentation',
        why: 'Clarified in the source conversation',
        intendedOutcome: 'A reviewable presentation is ready',
        closure: {
          condition: 'The presentation is ready for review',
          expectedSignal: 'artifact:final-presentation',
        },
      },
    });
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().offer.admission.result.result, 'admitted');
    assert.equal(retried.json().offer.admission.idempotencyKey, originalKey);
    assert.equal((await taskStore.listByThread('thread-f310')).length, 1);
    await app.close();
  });
});
