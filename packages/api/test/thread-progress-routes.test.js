import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('thread progress read routes', () => {
  async function fixture() {
    const [
      { ThreadStore },
      { MessageStore },
      { TaskStore },
      { ThreadProgressReceiptStore },
      { ThreadBriefAssembler },
      { ThreadBriefCollectionAssembler },
      { ThreadRuntimeBriefAssembler },
      { threadProgressRoutes },
    ] = await Promise.all([
      import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../dist/domains/cats/services/stores/ports/TaskStore.js'),
      import('../dist/domains/thread-progress/ThreadProgressReceiptStore.js'),
      import('../dist/domains/thread-progress/ThreadBriefAssembler.js'),
      import('../dist/domains/thread-progress/ThreadBriefCollectionAssembler.js'),
      import('../dist/domains/thread-progress/ThreadRuntimeBriefAssembler.js'),
      import('../dist/routes/thread-progress-routes.js'),
    ]);
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const taskStore = new TaskStore();
    const receiptStore = new ThreadProgressReceiptStore();
    const assembler = new ThreadBriefAssembler({
      receiptStore,
      taskStore,
      readLiveExecutions: async () => [],
      readAttention: async () => [],
      readWaits: async () => [],
    });
    const currentFacts = new Map();
    const collectionAssembler = new ThreadBriefCollectionAssembler({
      threadStore,
      receiptStore,
      briefAssembler: assembler,
      discoverCurrentFacts: async () => currentFacts,
    });
    const runtimeAssembler = new ThreadRuntimeBriefAssembler({
      receiptStore,
      taskStore,
      taskProgressStore: { getThreadSnapshots: async () => ({}) },
      sessionChainStore: { getChainByThread: async () => [] },
      readLiveExecutions: async () => [],
    });
    const app = Fastify();
    await app.register(threadProgressRoutes, {
      threadStore,
      receiptStore,
      assembler,
      collectionAssembler,
      runtimeAssembler,
      taskStore,
      messageStore,
    });
    return { app, threadStore, messageStore, taskStore, receiptStore, currentFacts };
  }

  test('returns a Brief only for an owner-created ordinary thread', async () => {
    const fx = await fixture();
    const own = fx.threadStore.create('user-1', 'Runtime harness 深入学习');
    const foreign = fx.threadStore.create('user-2', 'Foreign');
    const special = fx.threadStore.create('user-1', 'Concierge');
    await fx.threadStore.updateThreadKind(special.id, 'concierge');

    const ok = await fx.app.inject({
      method: 'GET',
      url: `/api/threads/${own.id}/brief`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    const denied = await fx.app.inject({
      method: 'GET',
      url: `/api/threads/${foreign.id}/brief`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    const specialDenied = await fx.app.inject({
      method: 'GET',
      url: `/api/threads/${special.id}/brief`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().contextHeading.text, 'Runtime harness 深入学习');
    assert.equal(ok.json().presentationState, 'idle');
    assert.equal(denied.statusCode, 403);
    assert.equal(specialDenied.statusCode, 403);
    await fx.app.close();
  });

  test('paginates immutable Receipts and does not cross owner scope', async () => {
    const fx = await fixture();
    const own = fx.threadStore.create('user-1', 'Long task');
    for (const [id, occurredAt] of [
      ['receipt-old', 100],
      ['receipt-new', 200],
    ]) {
      await fx.receiptStore.appendIfAbsent({
        v: 1,
        id,
        ownerUserId: 'user-1',
        threadId: own.id,
        kind: 'milestone',
        impactAxes: ['verified_outcome'],
        actor: { kind: 'cat', catId: 'opus' },
        headline: id,
        provenance: [{ kind: 'invocation', invocationId: id }],
        sourceKey: `source-${id}`,
        occurredAt,
        createdAt: occurredAt,
      });
    }

    const first = await fx.app.inject({
      method: 'GET',
      url: `/api/threads/${own.id}/progress?limit=1`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    const second = await fx.app.inject({
      method: 'GET',
      url: `/api/threads/${own.id}/progress?limit=1&cursor=${first.json().nextCursor}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    const denied = await fx.app.inject({
      method: 'GET',
      url: `/api/threads/${own.id}/progress`,
      headers: { 'x-cat-cafe-user': 'user-2' },
    });

    assert.deepEqual(
      first.json().items.map((item) => item.id),
      ['receipt-new'],
    );
    assert.deepEqual(
      second.json().items.map((item) => item.id),
      ['receipt-old'],
    );
    assert.equal(second.json().nextCursor, null);
    assert.equal(denied.statusCode, 403);
    await fx.app.close();
  });

  test('resolves typed provenance only after revalidating owner and thread scope', async () => {
    const fx = await fixture();
    const own = fx.threadStore.create('user-1', 'Evidence');
    const message = await fx.messageStore.append({
      threadId: own.id,
      userId: 'user-1',
      catId: null,
      content: 'Decision source',
      timestamp: Date.now(),
    });
    await fx.receiptStore.appendIfAbsent({
      v: 1,
      id: 'receipt-evidence',
      ownerUserId: 'user-1',
      threadId: own.id,
      kind: 'decision',
      impactAxes: ['goal_or_scope'],
      actor: { kind: 'cat', catId: 'opus' },
      headline: '确定范围',
      provenance: [{ kind: 'message', messageId: message.id }],
      sourceKey: 'source-evidence',
      occurredAt: 300,
      createdAt: 300,
    });

    const source = await fx.app.inject({
      method: 'GET',
      url: `/api/threads/${own.id}/progress/receipt-evidence/sources/0`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    const denied = await fx.app.inject({
      method: 'GET',
      url: `/api/threads/${own.id}/progress/receipt-evidence/sources/0`,
      headers: { 'x-cat-cafe-user': 'user-2' },
    });

    assert.equal(source.statusCode, 200);
    assert.deepEqual(source.json(), { kind: 'message', threadId: own.id, messageId: message.id });
    assert.equal(denied.statusCode, 403);
    await fx.app.close();
  });

  test('returns complete current briefs plus independently paginated recent briefs', async () => {
    const fx = await fixture();
    const running = fx.threadStore.create('user-1', 'Running');
    const recent = fx.threadStore.create('user-1', 'Recent');
    fx.currentFacts.set(running.id, {
      live: [{ catId: 'opus', startedAt: 100, turnInvocationId: 'turn-1', degraded: false }],
      attention: [],
      waits: [],
    });
    for (const [thread, occurredAt] of [
      [running, 200],
      [recent, 100],
    ]) {
      await fx.receiptStore.appendIfAbsent({
        v: 1,
        id: `receipt-${thread.id}`,
        ownerUserId: 'user-1',
        threadId: thread.id,
        kind: 'milestone',
        impactAxes: ['verified_outcome'],
        actor: { kind: 'cat', catId: 'opus' },
        headline: thread.title,
        provenance: [{ kind: 'invocation', invocationId: `inv-${thread.id}` }],
        sourceKey: `source-${thread.id}`,
        occurredAt,
        createdAt: occurredAt,
      });
    }

    const response = await fx.app.inject({
      method: 'GET',
      url: '/api/threads/briefs?scope=recent&limit=1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().current.map((brief) => brief.thread.id),
      [running.id],
    );
    assert.deepEqual(
      response.json().recent.map((brief) => brief.thread.id),
      [recent.id],
    );
    assert.equal(response.json().nextCursor, null);

    const invalidCursor = await fx.app.inject({
      method: 'GET',
      url: '/api/threads/briefs?scope=recent&cursor=not-a-cursor',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(invalidCursor.statusCode, 400);
    await fx.app.close();
  });

  test('returns a runtime brief only for the ordinary thread owner', async () => {
    const fx = await fixture();
    const own = fx.threadStore.create('user-1', 'Runtime details');
    const ok = await fx.app.inject({
      method: 'GET',
      url: `/api/threads/${own.id}/runtime-brief`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    const denied = await fx.app.inject({
      method: 'GET',
      url: `/api/threads/${own.id}/runtime-brief`,
      headers: { 'x-cat-cafe-user': 'user-2' },
    });

    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().thread.title, 'Runtime details');
    assert.deepEqual(ok.json().currentExecutions, []);
    assert.equal(denied.statusCode, 403);
    await fx.app.close();
  });
});
