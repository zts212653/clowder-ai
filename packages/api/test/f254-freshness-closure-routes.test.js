import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { threadsRoutes } = await import('../dist/routes/threads.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);

async function makeBlockedClosure(store, threadId) {
  const closure = await store.openOrAdvance({
    closureId: 'closure-1',
    userId: 'user-1',
    threadId,
    catId: 'codex-sol',
    invocationId: 'base-inv',
    draftContent: 'stale',
    requiredMessageIds: ['msg-2'],
    requiredFrontierMessageId: 'msg-2',
    observedRawFrontierMessageId: 'msg-2',
    now: 100,
  });
  const running = await store.claimAttempt(closure.id, {
    invocationId: 'successor-1',
    inputFrontierMessageId: 'msg-2',
    observedRawFrontierMessageId: 'msg-2',
    now: 110,
  });
  return store.blockAttempt(running.id, {
    invocationId: 'successor-1',
    reason: 'provider_failure',
    evidenceRefs: ['provider:test'],
    now: 120,
  });
}

describe('F254 Phase E — closure projection and retry routes', () => {
  it('repairs a leaked decline control message in the reconnect projection', async () => {
    const app = Fastify();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'F254 repaired route test', '/tmp/test');
    const messageStore = new MessageStore();
    const closureStore = new InMemoryFreshnessClosureStore();
    const original = await messageStore.append({
      userId: 'user-1',
      catId: 'codex-sol',
      threadId: thread.id,
      content: 'published answer',
      mentions: [],
      timestamp: 100,
      origin: 'stream',
    });
    const offered = await closureStore.offerSupplement({
      lineageId: original.id,
      originalMessageId: original.id,
      userId: 'user-1',
      threadId: thread.id,
      catId: 'codex-sol',
      requiredMessageIds: ['msg-late'],
      requiredFrontierMessageId: 'msg-late',
      now: 110,
    });
    const running = await closureStore.claimSupplement(offered.supplement.id, {
      invocationId: 'supplement-inv',
      now: 120,
    });
    const leaked = await messageStore.append({
      userId: 'user-1',
      catId: 'codex-sol',
      threadId: thread.id,
      content: '<!-- cat-cafe:supplement-decline -->',
      mentions: [],
      timestamp: 130,
      origin: 'stream',
      replyTo: original.id,
      extra: {
        supplement: {
          lineageId: original.id,
          supplementId: running.id,
          seq: running.seq,
          originalMessageId: original.id,
        },
      },
    });
    await closureStore.commitSupplement(running.id, {
      invocationId: 'supplement-inv',
      messageId: leaked.id,
      now: 140,
    });
    await app.register(threadsRoutes, { threadStore, messageStore, freshnessClosureStore: closureStore });

    const hydrated = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/freshness-closures`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(hydrated.statusCode, 200);
    assert.equal(hydrated.json().supplements[0].status, 'declined');
    assert.equal(hydrated.json().supplements[0].terminalReason, 'checked_no_supplement_needed');
    assert.equal(hydrated.json().supplements[0].committedMessageId, undefined);
    await app.close();
  });

  it('hydrates a blocked closure and queues an explicit retry', async () => {
    const app = Fastify();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'F254 route test', '/tmp/test');
    const closureStore = new InMemoryFreshnessClosureStore();
    await makeBlockedClosure(closureStore, thread.id);
    const offered = await closureStore.offerSupplement({
      lineageId: 'msg-original',
      originalMessageId: 'msg-original',
      userId: 'user-1',
      threadId: thread.id,
      catId: 'codex-sol',
      requiredMessageIds: ['msg-late'],
      requiredFrontierMessageId: 'msg-late',
      now: 130,
    });
    await closureStore.claimSupplement(offered.supplement.id, { invocationId: 'supplement-inv', now: 140 });
    await closureStore.declineSupplement(offered.supplement.id, { invocationId: 'supplement-inv', now: 150 });
    const entries = [];
    let autoExecuteThreadId;
    await app.register(threadsRoutes, {
      threadStore,
      freshnessClosureStore: closureStore,
      invocationQueue: {
        enqueue(entry) {
          entries.push(entry);
          return { outcome: 'enqueued', entry: { ...entry, id: 'queue-1' } };
        },
      },
      queueProcessor: {
        async tryAutoExecute(threadId) {
          autoExecuteThreadId = threadId;
        },
      },
      socketManager: { broadcastAgentMessage() {} },
    });

    const hydrated = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/freshness-closures`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(hydrated.statusCode, 200);
    assert.equal(hydrated.json().closures[0].status, 'blocked');
    assert.deepEqual(hydrated.json().supplements, [
      {
        type: 'freshness_supplement',
        supplementId: offered.supplement.id,
        lineageId: 'msg-original',
        originalMessageId: 'msg-original',
        threadId: thread.id,
        catId: 'codex-sol',
        seq: 1,
        status: 'declined',
        requiredCount: 1,
        terminalReason: 'checked_no_supplement_needed',
        updatedAt: 150,
      },
    ]);

    const retried = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/freshness-closures/closure-1/retry`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(retried.statusCode, 202);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].freshnessClosureId, 'closure-1');
    assert.equal(entries[0].autoExecute, true, 'explicit retry must be visible to tryAutoExecute');
    assert.equal((await closureStore.get('closure-1')).status, 'pending');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(autoExecuteThreadId, thread.id);
    await app.close();
  });
});
