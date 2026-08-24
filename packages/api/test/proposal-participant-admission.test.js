// @ts-check
/**
 * F128 proposal approval participant admission.
 *
 * The proposal dispatch plan may choose targets that differ from raw-message
 * mentions (preferredCats ordering and #ideate are F128-owned semantics). The
 * canonical ThreadStore participants must therefore follow the final dispatch
 * targets before Queue starts, not the router's earlier mention parse.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

function participantEvents(ctx, threadId) {
  return ctx.socketEvents.filter(
    (event) => event.kind === 'user' && event.event === 'thread_updated' && event.data.threadId === threadId,
  );
}

describe('F128 proposal approval — participant admission', () => {
  test('no @ + preferredCats persists the final chain starter before Queue starts', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    let ctx;
    const processSnapshots = [];
    const persistOptions = [];
    const router = {
      async resolveTargetsAndIntent(_content, _threadId, options) {
        persistOptions.push(options.persist);
        return { targetCats: [], intent: { intent: 'execute' }, hasMentions: false };
      },
    };
    const queueProcessor = {
      async processNext(threadId, userId) {
        processSnapshots.push({
          threadId,
          userId,
          participants: [...(await ctx.threadStore.getParticipants(threadId))],
        });
        return { started: true };
      },
    };
    ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const proposed = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { initialMessage: '开工', preferredCats: ['kimi', 'gemini'] },
    });

    const approved = await ctx.approve('alice', proposed.json().proposalId);
    assert.equal(approved.statusCode, 200);
    const threadId = approved.json().threadId;
    assert.deepEqual(persistOptions, [false], 'proposal planning must not persist raw mention candidates');
    assert.deepEqual(processSnapshots, [{ threadId, userId: 'alice', participants: ['kimi'] }]);
    assert.deepEqual(await ctx.threadStore.getParticipants(threadId), ['kimi']);
    assert.deepEqual(participantEvents(ctx, threadId), [
      { kind: 'user', userId: 'alice', event: 'thread_updated', data: { threadId, participants: ['kimi'] } },
    ]);

    const replay = await ctx.approve('alice', proposed.json().proposalId);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().deduped, true);
    assert.equal(participantEvents(ctx, threadId).length, 1, 'approve retry must not publish a duplicate event');
  });

  test('preferredCats override does not persist a narrative raw-message mention', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    let ctx;
    const router = {
      async resolveTargetsAndIntent(_content, threadId, options) {
        if (options.persist) await ctx.threadStore.addParticipants(threadId, ['opus']);
        return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: true };
      },
    };
    const queueProcessor = {
      async processNext() {
        return { started: true };
      },
    };
    ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const proposed = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { initialMessage: '@opus 这是叙事说明', preferredCats: ['kimi'] },
    });

    const approved = await ctx.approve('alice', proposed.json().proposalId);
    const threadId = approved.json().threadId;
    assert.deepEqual(await ctx.threadStore.getParticipants(threadId), ['kimi']);
    assert.deepEqual(invocationQueue.list(threadId, 'alice')[0].targetCats, ['kimi']);
  });

  test('#ideate persists every final parallel target with one user-scoped event', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    let ctx;
    const snapshots = [];
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: [], intent: { intent: 'ideate' }, hasMentions: false };
      },
    };
    const queueProcessor = {
      async processNext(threadId) {
        snapshots.push(await ctx.threadStore.getParticipants(threadId));
        return { started: true };
      },
    };
    ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const proposed = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { initialMessage: '#ideate 各自独立分析', preferredCats: ['kimi', 'gemini', 'codex'] },
    });

    const approved = await ctx.approve('alice', proposed.json().proposalId);
    const threadId = approved.json().threadId;
    assert.deepEqual(snapshots, [['kimi', 'gemini', 'codex']]);
    assert.deepEqual(new Set(await ctx.threadStore.getParticipants(threadId)), new Set(['kimi', 'gemini', 'codex']));
    assert.equal(participantEvents(ctx, threadId).length, 1);
  });

  test('queue rejection leaves no participant or participant event', async () => {
    const invocationQueue = {
      enqueue() {
        return { outcome: 'full' };
      },
      backfillMessageId() {},
      rollbackEnqueue() {},
    };
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: [], intent: { intent: 'execute' }, hasMentions: false };
      },
    };
    const queueProcessor = {
      async processNext() {
        throw new Error('must not start');
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const proposed = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { initialMessage: '开工', preferredCats: ['kimi'] },
    });

    const approved = await ctx.approve('alice', proposed.json().proposalId);
    assert.equal(approved.statusCode, 200);
    const threadId = approved.json().threadId;
    assert.match(approved.json().warnings.join('\n'), /queue is full/);
    assert.deepEqual(await ctx.threadStore.getParticipants(threadId), []);
    assert.equal(participantEvents(ctx, threadId).length, 0);
  });

  test('Sidebar snapshot keeps C2 participants while presence transitions working → idle', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const workingThreads = new Set();
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: [], intent: { intent: 'execute' }, hasMentions: false };
      },
    };
    const queueProcessor = {
      async processNext(threadId) {
        workingThreads.add(threadId);
        return { started: true };
      },
    };
    const presenceSource = {
      async getPresence(threadIds) {
        return new Map(
          threadIds
            .filter((threadId) => workingThreads.has(threadId))
            .map((threadId) => [threadId, { status: 'working', cats: ['kimi'], activeSince: 1_787_409_000_000 }]),
        );
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
      sidebarPresenceSourceOverride: presenceSource,
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const proposed = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { initialMessage: '开工', preferredCats: ['kimi'] },
    });
    const approved = await ctx.approve('alice', proposed.json().proposalId);
    const threadId = approved.json().threadId;

    const listSidebar = async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/threads?view=sidebar',
        headers: { 'x-cat-cafe-user': 'alice' },
      });
      assert.equal(response.statusCode, 200);
      return response.json().threads.find((thread) => thread.id === threadId);
    };

    const working = await listSidebar();
    assert.deepEqual(working.participants, ['kimi']);
    assert.deepEqual(working.presence, { status: 'working', cats: ['kimi'], activeSince: 1_787_409_000_000 });

    workingThreads.delete(threadId);
    const completedAndRead = await listSidebar();
    assert.deepEqual(completedAndRead.participants, ['kimi'], 'C2 remains durable after working presence retires');
    assert.deepEqual(completedAndRead.presence, { status: 'idle' });
  });
});
