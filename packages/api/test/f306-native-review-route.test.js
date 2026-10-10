import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

async function fixture({ providerError, providerResult } = {}) {
  const [{ nativeThreadReviewRoutes }, { ThreadStore }, { MessageStore }, { SessionChainStore }, { AgentRegistry }] =
    await Promise.all([
      import('../dist/routes/native-thread-review-routes.js'),
      import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'),
      import('../dist/domains/cats/services/agents/registry/AgentRegistry.js'),
    ]);
  const app = Fastify();
  const threadStore = new ThreadStore();
  const messageStore = new MessageStore();
  const sessionChainStore = new SessionChainStore();
  const agentRegistry = new AgentRegistry();
  const calls = [];
  const thread = threadStore.create('owner-1', 'Native review');
  sessionChainStore.create({ cliSessionId: 'native-1', threadId: thread.id, catId: 'codex', userId: 'owner-1' });
  agentRegistry.register('codex', {
    async *invoke() {},
    async requestNativeReview(input) {
      calls.push(input);
      if (providerError) throw providerError;
      if (providerResult) return providerResult;
      const running = {
        status: 'running',
        runtimeSessionId: 'native-1',
        reviewThreadId: 'native-1',
        turnId: 'review-turn-1',
        items: [{ id: 'enter-1', kind: 'mode_entered', text: 'Reviewing', completedAt: 101 }],
      };
      await input.onUpdate?.(running);
      return {
        ...running,
        status: 'completed',
        items: [...running.items, { id: 'exit-1', kind: 'mode_exited', text: 'No findings', completedAt: 102 }],
        result: { status: 'completed', summary: 'No findings' },
      };
    },
  });
  await app.register(nativeThreadReviewRoutes, {
    threadStore,
    messageStore,
    sessionChainStore,
    agentRegistry,
    isSessionBusy: () => false,
  });
  await app.ready();
  return { app, agentRegistry, calls, messageStore, sessionChainStore, thread, threadStore };
}

const ownerHeaders = { 'x-cat-cafe-user': 'owner-1' };

test('native review route persists structured mode, items, and result', async (t) => {
  const { app, calls, messageStore, thread, threadStore } = await fixture();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
    payload: { target: { kind: 'uncommitted_changes' }, delivery: 'inline', catId: 'codex' },
  });
  assert.equal(response.statusCode, 202);
  const started = response.json().review;
  assert.equal(started.status, 'running');
  let review;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/reviews/native`,
      headers: ownerHeaders,
    });
    review = listed.json().reviews[0];
    if (review.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(review.status, 'completed');
  assert.equal(review.items.length, 3);
  assert.equal(
    review.items.some((item) => item.text === 'Codex 原生 Review 已连接'),
    true,
  );
  assert.deepEqual(review.result, { status: 'completed', summary: 'No findings' });
  assert.equal((await threadStore.get(thread.id)).nativeReviews, undefined);
  const reviewMessages = await messageStore.getByThread(thread.id);
  assert.equal(
    reviewMessages.every((message) => message.extra?.semanticEvent?.kind === 'review'),
    true,
  );
  assert.equal(
    reviewMessages.some(
      (message) =>
        message.extra?.semanticEvent?.stage === 'progress' &&
        message.extra.semanticEvent.reviewThreadId === 'native-1' &&
        message.extra.semanticEvent.turnId === 'review-turn-1',
    ),
    true,
  );
  assert.equal(
    reviewMessages.every(
      (message) =>
        // F117: sender identity is MessageFrom truth; review receipts persist
        // from = { kind: 'system', service: 'native-thread-review' }.
        message.userId === 'system' &&
        message.from?.kind === 'system' &&
        message.content.includes('Codex 原生 Review') &&
        message.content.includes('不能作为合入批准'),
    ),
    true,
  );
  assert.equal(review.catId, 'codex');
  assert.equal(review.reviewThreadId, 'native-1');
  assert.equal(review.turnId, 'review-turn-1');
  assert.equal(calls[0].request.target.kind, 'uncommitted_changes');

  const listed = await app.inject({
    method: 'GET',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
  });
  assert.deepEqual(listed.json().reviews, [review]);
});

test('native review route validates target and keeps an unavailable receipt after provider failure', async (t) => {
  const { app, thread } = await fixture({ providerError: new Error('provider failed') });
  t.after(() => app.close());
  const invalid = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
    payload: { target: { kind: 'commit', sha: 'not-a-sha' }, delivery: 'detached' },
  });
  assert.equal(invalid.statusCode, 400);

  const unavailable = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
    payload: { target: { kind: 'custom', instructions: 'Check concurrency boundaries' }, delivery: 'detached' },
  });
  assert.equal(unavailable.statusCode, 202);
  let failed;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/reviews/native`,
      headers: ownerHeaders,
    });
    failed = listed.json().reviews[0];
    if (failed.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result.summary, 'Codex 原生 Review 未完成');
  assert.equal(failed.result.errorCode, 'native_review_request_failed');
});

test('a restarted route projects an orphaned durable review as unverifiable without writing a false terminal', async () => {
  const { app, agentRegistry, messageStore, sessionChainStore, thread, threadStore } = await fixture();
  // F117: append requires an explicit MessageFrom sender identity.
  await messageStore.append(
    canonicalTestMessageInput({
      userId: 'system',
      catId: 'system',
      threadId: thread.id,
      content: 'Codex 原生 Review 已启动',
      mentions: [],
      timestamp: 100,
      idempotencyKey: 'native-review:orphaned-review:started',
      extra: {
        semanticEvent: {
          v: 1,
          id: 'native-review:orphaned-review:started',
          kind: 'review',
          reviewId: 'orphaned-review',
          stage: 'started',
          summary: 'Codex 原生 Review 已启动',
          actorCatId: 'codex',
          occurredAt: 100,
          target: { kind: 'base_branch', branch: 'origin/main' },
          targetLabel: '相对 origin/main',
          delivery: 'detached',
          provenance: { provider: 'openai_codex', carrier: 'app_server' },
        },
      },
    }),
  );
  await app.close();

  const { nativeThreadReviewRoutes } = await import('../dist/routes/native-thread-review-routes.js');
  const restarted = Fastify();
  await restarted.register(nativeThreadReviewRoutes, {
    threadStore,
    messageStore,
    sessionChainStore,
    agentRegistry,
    isSessionBusy: () => false,
  });
  await restarted.ready();
  try {
    const listed = await restarted.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/reviews/native`,
      headers: ownerHeaders,
    });

    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().reviews[0].status, 'unavailable');
    assert.equal(listed.json().reviews[0].unavailableReason, 'runtime_liveness_unverifiable');
    const terminal = (await messageStore.getByThread(thread.id)).find(
      (message) => message.extra?.semanticEvent?.id === 'native-review:orphaned-review:terminal',
    );
    assert.equal(terminal, undefined);
  } finally {
    await restarted.close();
  }
});

test('native review requires explicit cat selection when multiple capable sessions exist', async (t) => {
  const { app, agentRegistry, sessionChainStore, thread } = await fixture();
  t.after(() => app.close());
  sessionChainStore.create({
    cliSessionId: 'native-terra-1',
    threadId: thread.id,
    catId: 'codex-terra',
    userId: 'owner-1',
  });
  agentRegistry.register('codex-terra', {
    async *invoke() {},
    async requestNativeReview() {
      throw new Error('not_expected');
    },
  });

  const listed = await app.inject({
    method: 'GET',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
  });
  assert.deepEqual(listed.json().nativeTargets, [{ catId: 'codex' }, { catId: 'codex-terra' }]);

  const ambiguous = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
    payload: { target: { kind: 'uncommitted_changes' }, delivery: 'inline' },
  });
  assert.equal(ambiguous.statusCode, 409);
  assert.equal(ambiguous.json().code, 'NATIVE_SESSION_SELECTION_REQUIRED');
  assert.deepEqual(ambiguous.json().nativeTargets, [{ catId: 'codex' }, { catId: 'codex-terra' }]);
});

test('native review preserves provider failure code instead of promoting a partial item to terminal summary', async (t) => {
  const { app, thread } = await fixture({
    providerResult: {
      status: 'failed',
      runtimeSessionId: 'native-1',
      reviewThreadId: 'native-1',
      turnId: 'review-turn-1',
      items: [{ id: 'partial-1', kind: 'message', text: 'partial finding', completedAt: 101 }],
      result: { status: 'failed', summary: 'partial finding', errorCode: 'provider_review_interrupted' },
    },
  });
  t.after(() => app.close());
  await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
    payload: { target: { kind: 'uncommitted_changes' }, delivery: 'inline', catId: 'codex' },
  });

  let failed;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/reviews/native`,
      headers: ownerHeaders,
    });
    failed = listed.json().reviews[0];
    if (failed.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(failed.result.errorCode, 'provider_review_interrupted');
  assert.equal(failed.result.summary, 'Codex 原生 Review 已被中断');
});

test('review projection preserves structured finding events', async () => {
  const { projectReviewMessages } = await import('../dist/routes/native-thread-review-projection.js');
  const base = {
    userId: 'system',
    catId: 'system',
    threadId: 'thread-1',
    content: 'projected',
    mentions: [],
    timestamp: 100,
  };
  const event = (id, stage, summary, extra = {}) => ({
    ...base,
    id,
    extra: {
      semanticEvent: {
        v: 1,
        id,
        kind: 'review',
        reviewId: 'review-finding',
        stage,
        summary,
        actorCatId: 'codex',
        occurredAt: stage === 'started' ? 100 : 101,
        provenance: { provider: 'openai_codex', carrier: 'app_server' },
        ...extra,
      },
    },
  });
  const reviews = projectReviewMessages([
    event('started', 'started', 'started', {
      target: { kind: 'uncommitted_changes' },
      delivery: 'inline',
    }),
    event('finding', 'finding', 'P1 finding', { filePath: 'src/index.ts', severity: 'error' }),
  ]);
  assert.equal(reviews[0].catId, 'codex');
  assert.deepEqual(reviews[0].items, [{ id: 'finding', kind: 'finding', text: 'P1 finding', completedAt: 101 }]);
});

test('native review listing uses a bounded reverse history read', async (t) => {
  const { app, messageStore, thread } = await fixture();
  t.after(() => app.close());
  const originalGetByThread = messageStore.getByThread.bind(messageStore);
  const calls = [];
  messageStore.getByThread = (...args) => {
    calls.push(args);
    return originalGetByThread(...args);
  };
  messageStore.getByThreadAfter = () => {
    throw new Error('unbounded_review_history_read');
  };

  const listed = await app.inject({
    method: 'GET',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
  });

  assert.equal(listed.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 200);
});

test('active review remains discoverable after its durable start leaves the bounded window', async (t) => {
  const neverCompletes = new Promise(() => {});
  const { app, messageStore, thread } = await fixture({ providerResult: neverCompletes });
  t.after(() => app.close());
  const started = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
    payload: { target: { kind: 'uncommitted_changes' }, delivery: 'inline', catId: 'codex' },
  });
  assert.equal(started.statusCode, 202);
  const reviewId = started.json().review.id;

  for (let index = 0; index < 201; index += 1) {
    // F117: append requires an explicit MessageFrom sender identity.
    await messageStore.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: thread.id,
        content: `active-filler-${index}`,
        mentions: [],
        timestamp: 1_000 + index,
      }),
    );
  }

  const listed = await app.inject({
    method: 'GET',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().activeReviewIds, [reviewId]);
  assert.equal(listed.json().reviews[0].id, reviewId);
  assert.equal(listed.json().reviews[0].status, 'running');
});

test('terminal review becomes durable before its active liveness entry is removed', async (t) => {
  let finishReview;
  const providerResult = new Promise((resolve) => {
    finishReview = resolve;
  });
  const { app, thread } = await fixture({ providerResult });
  t.after(() => app.close());
  const started = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
    payload: { target: { kind: 'uncommitted_changes' }, delivery: 'inline', catId: 'codex' },
  });
  const reviewId = started.json().review.id;
  const active = await app.inject({
    method: 'GET',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
  });
  assert.deepEqual(active.json().activeReviewIds, [reviewId]);

  finishReview({
    status: 'completed',
    runtimeSessionId: 'native-1',
    reviewThreadId: 'native-1',
    turnId: 'turn-terminal-order',
    items: [],
    result: { status: 'completed', summary: 'Terminal is durable' },
  });

  let terminal;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/reviews/native`,
      headers: ownerHeaders,
    });
    const body = listed.json();
    assert.equal(
      body.reviews.some((review) => review.id === reviewId),
      true,
    );
    if (body.reviews[0]?.status === 'completed') {
      terminal = body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(terminal.reviews[0].result.summary, 'Terminal is durable');
  assert.deepEqual(terminal.activeReviewIds, []);
});

test('review listing preserves a completed review after its start rolls beyond 500 newer messages', async (t) => {
  const { app, messageStore, thread } = await fixture();
  t.after(() => app.close());
  const semanticEvent = (id, stage, occurredAt, extra = {}) => ({
    v: 1,
    id,
    kind: 'review',
    reviewId: 'long-thread-review',
    stage,
    summary: stage === 'result' ? 'No findings' : 'Review started',
    actorCatId: 'codex',
    occurredAt,
    provenance: { provider: 'openai_codex', carrier: 'app_server' },
    ...extra,
  });
  // F117: append requires an explicit MessageFrom sender identity.
  await messageStore.append(
    canonicalTestMessageInput({
      userId: 'system',
      catId: 'system',
      threadId: thread.id,
      content: 'Review started',
      mentions: [],
      timestamp: 1,
      extra: {
        semanticEvent: semanticEvent('long-review-started', 'started', 1, {
          target: { kind: 'uncommitted_changes' },
          delivery: 'inline',
        }),
      },
    }),
  );
  for (let index = 0; index < 501; index += 1) {
    await messageStore.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: thread.id,
        content: `filler-${index}`,
        mentions: [],
        timestamp: index + 2,
      }),
    );
  }
  await messageStore.append(
    canonicalTestMessageInput({
      userId: 'system',
      catId: 'system',
      threadId: thread.id,
      content: 'No findings',
      mentions: [],
      timestamp: 503,
      extra: {
        semanticEvent: semanticEvent('long-review-result', 'result', 503, {
          target: { kind: 'uncommitted_changes' },
          delivery: 'inline',
          requestedAt: 1,
        }),
      },
    }),
  );

  const listed = await app.inject({
    method: 'GET',
    url: `/api/threads/${thread.id}/reviews/native`,
    headers: ownerHeaders,
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().reviews, [
    expectReview({ id: 'long-thread-review', status: 'completed', summary: 'No findings', truncated: true }),
  ]);
});

function expectReview({ id, status, summary, truncated }) {
  return {
    v: 1,
    id,
    target: { kind: 'uncommitted_changes' },
    delivery: 'inline',
    status,
    requestedAt: 1,
    updatedAt: 503,
    catId: 'codex',
    items: [],
    result: { status: 'completed', summary },
    ...(truncated ? { truncated: true } : {}),
  };
}
