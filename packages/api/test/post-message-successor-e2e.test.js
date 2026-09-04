/**
 * Local review is an ordinary durable A2A fact. It must not depend on the
 * ActionSuccessor lease/generation state machine that still owns implement and
 * external-review flows.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

let app;
let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

async function createHarness({ failEnqueueAttempts = 0 } = {}) {
  const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
  const { handlePostMessage } = await import('../../mcp-server/dist/tools/callback-tools.js');

  const registry = new InvocationRegistry();
  const invocationQueue = new InvocationQueue();
  const originalEnqueue = invocationQueue.enqueue.bind(invocationQueue);
  let remainingEnqueueFailures = failEnqueueAttempts;
  invocationQueue.enqueue = (input) => {
    if (remainingEnqueueFailures > 0) {
      remainingEnqueueFailures -= 1;
      throw new Error('simulated Queue admission failure');
    }
    return originalEnqueue(input);
  };
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const thread = await threadStore.create('user-1', 'Local review durable fact');
  const auth = await registry.create('user-1', 'opus', thread.id);
  const admissionCalls = [];
  const autoExecuteCalls = [];

  app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    invocationQueue,
    messageStore,
    threadStore,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    router: {
      async *routeExecution() {},
      getExecutions() {
        return [];
      },
    },
    invocationRecordStore: {
      create() {
        return { outcome: 'created', invocationId: 'child-invocation' };
      },
      update() {},
      get() {
        return null;
      },
    },
    queueProcessor: {
      async tryAutoExecute(...args) {
        autoExecuteCalls.push(args);
      },
      async onInvocationComplete() {},
    },
    actionSuccessorAdmissionService: {
      async admit(input) {
        admissionCalls.push(input);
        throw new Error('local review must not enter ActionSuccessor admission');
      },
    },
  });

  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  process.env.CAT_CAFE_API_URL = apiUrl;
  process.env.CAT_CAFE_INVOCATION_ID = auth.invocationId;
  process.env.CAT_CAFE_CALLBACK_TOKEN = auth.callbackToken;
  process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';

  return { admissionCalls, autoExecuteCalls, auth, handlePostMessage, invocationQueue, messageStore, thread };
}

function toolJson(result) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return JSON.parse(result.content[0]?.text);
}

const REVIEW_ANCHOR = {
  reviewSubjectRef: 'pr:zts212653/cat-cafe#4255',
  acceptedSourceRef: 'docs/features/F314-development-episode-alignment-experiment.md',
  acceptedRevision: '1'.repeat(40),
};

test('typed local review fact needs no action lease or inherited coordination to wake the named author once', async () => {
  const harness = await createHarness();
  const input = {
    content: '@codex\n\nREQUEST_CHANGES for the reviewed HEAD; findings are attached in this durable message.',
    targetCats: ['codex'],
    clientMessageId: 'durable-local-review-without-lease',
    localReviewVerdict: 'changes_requested',
    reviewedHeadSha: 'a'.repeat(40),
    ...REVIEW_ANCHOR,
  };

  const first = toolJson(await harness.handlePostMessage(input));
  assert.equal(first.status, 'ok');
  assert.equal(harness.admissionCalls.length, 0);
  const visible = harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1');
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].extra.localReviewVerdict, {
    verdict: 'changes_requested',
    clientMessageId: input.clientMessageId,
    reviewedHeadSha: input.reviewedHeadSha,
    ...REVIEW_ANCHOR,
  });
  assert.deepEqual(visible[0].mentions, ['codex']);
  assert.equal(visible[0].deliveryStatus, 'queued');
  assert.deepEqual(harness.invocationQueue.list(harness.thread.id, 'user-1')[0].targetCats, ['codex']);
  assert.equal(harness.autoExecuteCalls.length, 1);

  const replay = toolJson(await harness.handlePostMessage(input));
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.messageId, first.messageId);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => harness.handlePostMessage(input)));
  assert.equal(
    concurrent.every((result) => toolJson(result).status === 'duplicate'),
    true,
  );
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 1);
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 1);
  assert.equal(harness.autoExecuteCalls.length, 1);
});

test('typed local review fact fails closed without an exact reviewed HEAD', async () => {
  const harness = await createHarness();
  const response = await app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: {
      'x-invocation-id': harness.auth.invocationId,
      'x-callback-token': harness.auth.callbackToken,
    },
    payload: {
      content: '@codex\n\nThis conclusion has no exact reviewed revision.',
      targetCats: ['codex'],
      clientMessageId: 'durable-local-review-missing-head',
      localReviewVerdict: 'approved',
      ...REVIEW_ANCHOR,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().kind, 'invalid_review_fact');
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 0);
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 0);
});

test('typed local review fact fails closed without an accepted source anchor', async () => {
  const harness = await createHarness();
  const response = await app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: {
      'x-invocation-id': harness.auth.invocationId,
      'x-callback-token': harness.auth.callbackToken,
    },
    payload: {
      content: '@codex\n\nThis conclusion has no accepted source coordinate.',
      targetCats: ['codex'],
      clientMessageId: 'durable-local-review-missing-source',
      localReviewVerdict: 'approved',
      reviewedHeadSha: 'a'.repeat(40),
      reviewSubjectRef: REVIEW_ANCHOR.reviewSubjectRef,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().kind, 'invalid_review_fact');
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 0);
});

test('direct local review action custody is retired before ActionSuccessor admission', async () => {
  const harness = await createHarness();
  const response = await app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: {
      'x-invocation-id': harness.auth.invocationId,
      'x-callback-token': harness.auth.callbackToken,
    },
    payload: {
      content: '@codex\n\nPlease review this exact revision.',
      targetCats: ['codex'],
      clientMessageId: 'retired-direct-local-review-action',
      action: {
        subjectRef: 'pr:owner/repo#42',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
      },
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().kind, 'unsupported_direct_action');
  assert.equal(harness.admissionCalls.length, 0);
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 0);
});

test('a durable review fact recovers one author wake after transient Queue failure', async () => {
  const harness = await createHarness({ failEnqueueAttempts: 1 });
  const payload = {
    content: '@codex\n\nAPPROVED at this exact HEAD.',
    targetCats: ['codex'],
    clientMessageId: 'durable-review-recover-delivery',
    localReviewVerdict: 'approved',
    reviewedHeadSha: 'b'.repeat(40),
    ...REVIEW_ANCHOR,
  };
  const headers = {
    'x-invocation-id': harness.auth.invocationId,
    'x-callback-token': harness.auth.callbackToken,
  };

  const first = await app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload });
  assert.equal(first.statusCode, 503);
  assert.equal(first.json().kind, 'review_delivery_pending');
  const durable = harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1');
  assert.equal(durable.length, 1);
  assert.equal(durable[0].deliveryStatus, 'queued');
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 0);

  const replay = await app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().status, 'duplicate');
  assert.equal(replay.json().messageId, durable[0].id);
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 1);
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 1);
  assert.equal(harness.autoExecuteCalls.length, 1);
});

test('a new HEAD stores a fresh review fact while retaining the old HEAD as history', async () => {
  const harness = await createHarness();
  const base = {
    content: '@codex\n\nAPPROVED for the exact reviewed revision.',
    targetCats: ['codex'],
    localReviewVerdict: 'approved',
    ...REVIEW_ANCHOR,
  };

  assert.equal(
    toolJson(
      await harness.handlePostMessage({
        ...base,
        clientMessageId: 'review-head-old',
        reviewedHeadSha: 'c'.repeat(40),
      }),
    ).status,
    'ok',
  );
  assert.equal(
    toolJson(
      await harness.handlePostMessage({
        ...base,
        clientMessageId: 'review-head-new',
        reviewedHeadSha: 'd'.repeat(40),
      }),
    ).status,
    'ok',
  );

  const facts = harness.messageStore
    .getByThreadIncludingQueued(harness.thread.id, 20, 'user-1')
    .map((message) => message.extra.localReviewVerdict?.reviewedHeadSha)
    .filter(Boolean);
  assert.deepEqual(facts.sort(), ['c'.repeat(40), 'd'.repeat(40)]);
  assert.equal(harness.admissionCalls.length, 0);
});

test('one local-review clientMessageId cannot be reused for a different durable fact', async () => {
  const harness = await createHarness();
  const headers = {
    'x-invocation-id': harness.auth.invocationId,
    'x-callback-token': harness.auth.callbackToken,
  };
  const payload = {
    content: '@codex\n\nAPPROVED for this exact revision.',
    targetCats: ['codex'],
    clientMessageId: 'review-idempotency-conflict',
    localReviewVerdict: 'approved',
    reviewedHeadSha: 'e'.repeat(40),
    ...REVIEW_ANCHOR,
  };

  const first = await app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload });
  assert.equal(first.statusCode, 200);
  const conflict = await app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers,
    payload: { ...payload, reviewedHeadSha: 'f'.repeat(40) },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().kind, 'review_fact_idempotency_conflict');
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 1);
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 1);
});

test('one local-review clientMessageId cannot be reused for a different accepted revision', async () => {
  const harness = await createHarness();
  const headers = {
    'x-invocation-id': harness.auth.invocationId,
    'x-callback-token': harness.auth.callbackToken,
  };
  const payload = {
    content: '@codex\n\nAPPROVED for this accepted source revision.',
    targetCats: ['codex'],
    clientMessageId: 'review-source-idempotency-conflict',
    localReviewVerdict: 'approved',
    reviewedHeadSha: 'e'.repeat(40),
    ...REVIEW_ANCHOR,
  };

  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload })).statusCode,
    200,
  );
  const conflict = await app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers,
    payload: { ...payload, acceptedRevision: '2'.repeat(40) },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().kind, 'review_fact_idempotency_conflict');
});
