/**
 * F193 Phase A — AC-A4: cross-post fail-closed when routing credentials missing.
 *
 * KD-1: cross-thread post (effectiveThreadId !== actor.threadId) MUST have
 * either targetCats[] OR a line-start @mention in content. Server rejects 400
 * with kind:'cross_post_no_routing' + alternatives[] when neither is present.
 *
 * Why reject and not silent-strip:
 *   - Silent strip would write the message into source thread instead, losing
 *     the cat's intent + losing F052 sourceThreadId relay link.
 *   - Reject surfaces the error so the cat can fix the call (add targetCats
 *     or line-start @).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
  };
}

function createMockInvocationRecordStore() {
  const records = [];
  return {
    create(input) {
      const id = `inv-${records.length}`;
      records.push({ id, ...input });
      return { outcome: 'created', invocationId: id };
    },
    update() {},
    getRecords() {
      return records;
    },
  };
}

function createMockRouter() {
  return {
    async *routeExecution() {
      yield* [];
    },
    getExecutions() {
      return [];
    },
  };
}

function createMockThreadStore() {
  // Minimal IThreadStore for cross-thread post tests. We need:
  //  - get(id) → return Thread-shaped object (resolveScopedThreadId checks
  //    membership via the returned thread.userId)
  //  - getParticipants / addParticipants / updateParticipantActivity → no-op
  const threads = new Map();
  return {
    create(userId, title) {
      const thread = {
        id: `thread-${threads.size}`,
        userId,
        title: title ?? '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      threads.set(thread.id, thread);
      return thread;
    },
    get(id) {
      return threads.get(id) ?? null;
    },
    list(userId) {
      return [...threads.values()].filter((t) => t.userId === userId);
    },
    listByProject(userId) {
      return [...threads.values()].filter((t) => t.userId === userId);
    },
    getParticipants() {
      return [];
    },
    getParticipantsWithActivity() {
      return [];
    },
    addParticipants() {},
    updateParticipantActivity() {},
    updateTitle() {},
    seed(thread) {
      threads.set(thread.id, thread);
      return thread;
    },
  };
}

describe('F193 AC-A4: cross-post fail-closed when no routing credentials', () => {
  let registry;
  let messageStore;
  let socketManager;
  let invocationRecordStore;
  let mockRouter;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    socketManager = createMockSocketManager();
    invocationRecordStore = createMockInvocationRecordStore();
    mockRouter = createMockRouter();
    threadStore = createMockThreadStore();
    // Seed the target thread owned by user-1 (resolveScopedThreadId checks
    // targetThread.createdBy === actor.userId)
    threadStore.seed({
      id: 'target-thread',
      userId: 'user-1',
      createdBy: 'user-1',
      title: 'Target Thread',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  async function createApp(opts = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      router: mockRouter,
      invocationRecordStore,
      threadStore,
      ...opts,
    });
    return app;
  }

  test('reject 400 when cross-post has neither targetCats nor line-start @', async () => {
    const app = await createApp();
    // actor.threadId = 'source-thread', target threadId = 'target-thread' → cross-thread
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', {
      threadId: 'source-thread',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: 'target-thread', // cross-thread
        content: 'no targets, no line-start @',
        clientMessageId: 'no-routing-1',
      },
    });

    assert.equal(response.statusCode, 400, 'must reject cross-post without routing creds');
    const body = response.json();
    assert.equal(body.kind, 'cross_post_no_routing');
    assert.ok(Array.isArray(body.alternatives), 'must include alternatives[] for fixup');
    assert.ok(body.alternatives.length >= 2, 'alternatives should suggest both targetCats and line-start @');
    assert.ok(
      body.alternatives.some((a) => a.toLowerCase().includes('targetcats')),
      'one alternative must mention targetCats',
    );
  });

  test('accept cross-post when targetCats provided', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', {
      threadId: 'source-thread',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: 'target-thread',
        content: 'no @ but has targetCats',
        targetCats: ['codex'],
        clientMessageId: 'has-targets-1',
      },
    });

    assert.equal(response.statusCode, 200, 'targetCats present → cross-post accepted');
  });

  test('accept cross-post when content has line-start @', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', {
      threadId: 'source-thread',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: 'target-thread',
        content: '@codex hi from another thread',
        clientMessageId: 'has-mention-1',
      },
    });

    assert.equal(response.statusCode, 200, 'line-start @ present → cross-post accepted');
  });

  test('codex P1 round 2 (2026-05-08): AC-A4 reject does not consume clientMessageId — corrected retry delivers', async () => {
    // Closes Codex P1 round 2: AC-A4 reject MUST run before claimClientMessageId.
    // Otherwise a malformed first attempt permanently consumes the idempotency
    // key, and the corrected retry with same key gets `duplicate` (silent drop).
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'source-thread');

    // First attempt: malformed (no routing creds) — should reject 400 cross_post_no_routing
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: 'target-thread',
        content: 'oops no routing creds',
        clientMessageId: 'idempotent-key-retry-test-1',
      },
    });
    assert.equal(res1.statusCode, 400, 'first malformed attempt rejects with AC-A4');
    assert.equal(res1.json().kind, 'cross_post_no_routing');

    // Second attempt: corrected (with targetCats), same clientMessageId
    // Must NOT be treated as duplicate — AC-A4 reject must not consume the key.
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: 'target-thread',
        content: 'now with proper routing',
        targetCats: ['codex'],
        clientMessageId: 'idempotent-key-retry-test-1', // SAME idempotency key
      },
    });
    assert.equal(
      res2.statusCode,
      200,
      'corrected retry with same clientMessageId must succeed (AC-A4 must not consume the key)',
    );
    const body = res2.json();
    assert.notEqual(body.status, 'duplicate', 'retry must not be treated as duplicate after AC-A4 reject');
  });

  test('codex P2 (2026-05-08): targetCats=[disabled_cat] does NOT trigger cross_post_no_routing', async () => {
    // Closes Codex review P2: AC-A4 gate previously used post-resolve
    // mergedTargets.size === 0, mis-classifying "caller provided routing
    // but target is disabled/unknown" as "no routing creds". The existing
    // F182 allExplicitFailed / routing_warnings path is the right channel
    // for those cases (returns cat_disabled/cat_not_found).
    //
    // Fix: gate uses raw caller input (explicitTargetCats?.length > 0 OR
    // contentTargets.length > 0 OR contentAnalysis.routing_warnings.length > 0).
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'source-thread');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: 'target-thread',
        content: 'no @, but targetCats provided',
        // Use a non-existent cat handle — resolveCatTarget will drop it.
        // AC-A4 must NOT fire (caller DID provide routing intent).
        targetCats: ['totally-unknown-cat-9999'],
        clientMessageId: 'p2-fix-1',
      },
    });

    // Must NOT be 400 cross_post_no_routing.
    if (response.statusCode === 400) {
      const body = response.json();
      assert.notEqual(
        body.kind,
        'cross_post_no_routing',
        `caller provided targetCats — should not fire AC-A4 even if target unavailable (got: ${JSON.stringify(body)})`,
      );
    }
    // Acceptable outcomes: 200 (allExplicitFailed soft path) or 400 with
    // a different kind (e.g. cat_disabled). The key is AC-A4 doesn't misfire.
  });

  test('same-thread post without targetCats/@ stays valid (regression)', async () => {
    // Critical: AC-A4 reject MUST NOT misfire on regular in-thread progress
    // updates that legitimately have no targetCats and no @mention.
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', {
      threadId: 'source-thread',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        // NO threadId override → same-thread post (defaults to actor.threadId)
        content: 'just a status update, no mentions',
        clientMessageId: 'same-thread-1',
      },
    });

    assert.equal(response.statusCode, 200, 'same-thread progress update without routing creds must remain valid');
  });
});
