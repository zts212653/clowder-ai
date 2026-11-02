import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

test('a group is suggested from the source, but only the owner approval places the child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proposal-v2-'));
  const ctx = await createProposalTestContext({ projectRoot: root });
  try {
    const parent = ctx.threadStore.create('alice', 'F329 建模');
    const sibling = ctx.threadStore.create('alice', 'F329 地形');
    for (const [order, thread] of [parent, sibling].entries())
      await ctx.threadStore.atomicMergeThreadMetadata(thread.id, {
        attentionGroup: { v: 1, groupId: 'attention_planet', order },
      });
    const proposed = await ctx.propose({ userId: 'alice', threadId: parent.id });
    assert.equal(proposed.statusCode, 200, proposed.body);
    const proposal = await ctx.proposalStore.get(proposed.json().proposalId);
    assert.equal(proposal.suggestedGroupId, 'attention_planet');
    assert.equal(proposal.groupSuggestionReason, 'source-thread');
    assert.equal(ctx.threadStore.list('alice').length, 2, 'a suggestion must not create a child');
    const approved = await ctx.approve('alice', proposal.proposalId, { attentionGroupId: proposal.suggestedGroupId });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(
      (await ctx.threadStore.getThreadMetadata(approved.json().threadId)).attentionGroup.groupId,
      'attention_planet',
    );

    const second = await ctx.propose({ userId: 'alice', threadId: parent.id });
    const ungrouped = await ctx.approve('alice', second.json().proposalId, { attentionGroupId: null });
    assert.equal(ungrouped.statusCode, 200, ungrouped.body);
    assert.equal((await ctx.threadStore.getThreadMetadata(ungrouped.json().threadId))?.attentionGroup, undefined);
    const forbidden = await ctx.propose({
      userId: 'bob',
      threadId: ctx.threadStore.create('bob', 'Other').id,
      body: { suggestedGroupId: 'attention_planet' },
    });
    assert.equal(forbidden.statusCode, 400);
  } finally {
    await ctx.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a revision goes only to the proposer and the old card is replaced only after a visible new card', async () => {
  const sent = [];
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const queue = new InvocationQueue();
  const send = queue.send.bind(queue);
  queue.send = async (...args) => {
    sent.push(args[2]);
    return send(...args);
  };
  const ctx = await createProposalTestContext({ invocationQueueOverride: queue });
  try {
    const source = ctx.threadStore.create('alice', '每日漫谈');
    const original = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'F330 发版', preferredCats: ['codex'] },
    });
    const proposalId = original.json().proposalId;
    const foreign = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/request-revision`,
      headers: { 'x-cat-cafe-user': 'bob' },
      payload: { instruction: '换猫' },
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal(sent.length, 0);
    const ask = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/request-revision`,
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { instruction: '换 Argon 审，6.1 先开口', suggestedGroupId: null, pinned: true },
    });
    assert.equal(ask.statusCode, 200, ask.body);
    assert.deepEqual(sent[0].targetCats, ['opus']);
    assert.equal(
      (await ctx.proposalStore.get(proposalId)).revisionRequest.messageId,
      ask.json().messageId,
      'the exact queued owner message must be the replacement source',
    );
    assert.ok(sent[0].content.includes('换 Argon 审，6.1 先开口'));
    assert.equal((await ctx.proposalStore.get(proposalId)).status, 'pending');
    const { invocationId, callbackToken } = await ctx.registry.create(
      'alice',
      'opus',
      source.id,
      undefined,
      ask.json().messageId,
    );
    const replacement = await ctx.app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-thread',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        title: 'F330 发版',
        reason: '按你的话改了',
        preferredCats: ['codex'],
        supersedesProposalId: proposalId,
      },
    });
    assert.equal(replacement.statusCode, 200, replacement.body);
    const old = await ctx.proposalStore.get(proposalId);
    const next = await ctx.proposalStore.get(replacement.json().proposalId);
    assert.equal(old.status, 'withdrawn');
    assert.equal(old.supersededByProposalId, next.proposalId);
    assert.equal(next.suggestedGroupId, undefined);
    assert.equal(next.suggestedPinned, true, 'the owner small choices survive a content revision');
    assert.ok(next.cardMessageId);
    assert.equal((await ctx.approve('alice', old.proposalId)).statusCode, 409);
    assert.equal((await ctx.approve('alice', next.proposalId)).statusCode, 200);
  } finally {
    await ctx.app.close();
  }
});

test('a full proposer queue retains a retryable request, then records real delivery exactly once', async () => {
  let full = true;
  const ids = [];
  const ctx = await createProposalTestContext({
    invocationQueueOverride: {
      async send(store, message) {
        if (full) return { outcome: 'full' };
        const stored = await store.append(message);
        ids.push(stored.id);
        return { outcome: 'enqueued', message: stored, entries: [], deduped: ids.length > 1 };
      },
    },
  });
  try {
    const source = ctx.threadStore.create('alice', 'source');
    const original = await ctx.propose({ userId: 'alice', threadId: source.id });
    const proposalId = original.json().proposalId;
    const ask = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/proposals/${proposalId}/request-revision`,
        headers: { 'x-cat-cafe-user': 'alice' },
        payload: { instruction: '换 Argon 审' },
      });
    assert.equal((await ask()).statusCode, 429);
    assert.equal((await ctx.proposalStore.get(proposalId)).revisionRequest.queuedAt, undefined);
    full = false;
    assert.equal((await ask()).statusCode, 200);
    assert.equal((await ask()).statusCode, 200);
    assert.equal(new Set(ids).size, 1, 'transport retries share one owner message');
    assert.ok((await ctx.proposalStore.get(proposalId)).revisionRequest.queuedAt);
  } finally {
    await ctx.app.close();
  }
});

test('only the proposer on the exact revision source may replace a pending card', async () => {
  const ctx = await createProposalTestContext();
  try {
    const source = ctx.threadStore.create('alice', 'source');
    const original = await ctx.propose({ userId: 'alice', threadId: source.id });
    const proposalId = original.json().proposalId;
    const request = { messageId: 'exact-revision-source', instruction: '换猫', requestedBy: 'alice', requestedAt: 1 };
    await ctx.proposalStore.recordRevisionRequest(proposalId, request);
    for (const [catId, origin] of [
      ['codex', request.messageId],
      ['opus', 'unrelated-source'],
    ]) {
      const { invocationId, callbackToken } = await ctx.registry.create('alice', catId, source.id, undefined, origin);
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-thread',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { title: 'replacement', reason: 'changed', supersedesProposalId: proposalId },
      });
      assert.equal(response.statusCode, 409, response.body);
    }
    assert.equal((await ctx.proposalStore.get(proposalId)).status, 'pending');
    assert.equal((await ctx.proposalStore.listAllByThread(source.id)).length, 1);
  } finally {
    await ctx.app.close();
  }
});

test('a visible replacement cannot be approved before it atomically retires the original', async () => {
  const ctx = await createProposalTestContext();
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let published;
  const visible = new Promise((resolve) => {
    published = resolve;
  });
  const replace = ctx.proposalStore.supersedePending.bind(ctx.proposalStore);
  ctx.proposalStore.supersedePending = async (...args) => {
    published(args[1]);
    await barrier;
    return replace(...args);
  };
  try {
    const source = ctx.threadStore.create('alice', 'source');
    const original = await ctx.propose({ userId: 'alice', threadId: source.id });
    const originalId = original.json().proposalId;
    const origin = await ctx.messageStore.append({
      from: { kind: 'user', userId: 'alice' },
      userId: 'alice',
      threadId: source.id,
      content: '修改提议',
      mentions: [],
      timestamp: Date.now(),
    });
    const request = { messageId: origin.id, instruction: '修改提议', requestedBy: 'alice', requestedAt: 1 };
    await ctx.proposalStore.recordRevisionRequest(originalId, request);
    const { invocationId, callbackToken } = await ctx.registry.create(
      'alice',
      'opus',
      source.id,
      undefined,
      request.messageId,
    );
    const creation = ctx.app
      .inject({
        method: 'POST',
        url: '/api/callbacks/propose-thread',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { title: 'replacement', reason: 'changed', supersedesProposalId: originalId },
      })
      .then((response) => response);
    const nextId = await visible;
    assert.equal((await ctx.approve('alice', nextId)).statusCode, 409);
    assert.equal(ctx.threadStore.list('alice').length, 1);
    release();
    assert.equal((await creation).statusCode, 200);
    assert.equal((await ctx.approve('alice', nextId)).statusCode, 200);
  } finally {
    release?.();
    await ctx.app.close();
  }
});

test('an approval winning the replacement race withdraws the visible new card and invalidates its readers', async () => {
  const ctx = await createProposalTestContext();
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let published;
  const visible = new Promise((resolve) => {
    published = resolve;
  });
  const supersede = ctx.proposalStore.supersedePending.bind(ctx.proposalStore);
  ctx.proposalStore.supersedePending = async (...args) => {
    published(args[1]);
    await barrier;
    return supersede(...args);
  };
  try {
    const source = ctx.threadStore.create('alice', 'source');
    const original = await ctx.propose({ userId: 'alice', threadId: source.id });
    const originalId = original.json().proposalId;
    const origin = await ctx.messageStore.append({
      from: { kind: 'user', userId: 'alice' },
      userId: 'alice',
      threadId: source.id,
      content: '修改提议',
      mentions: [],
      timestamp: Date.now(),
    });
    await ctx.proposalStore.recordRevisionRequest(originalId, {
      messageId: origin.id,
      instruction: '修改提议',
      requestedBy: 'alice',
      requestedAt: Date.now(),
    });
    const { invocationId, callbackToken } = await ctx.registry.create('alice', 'opus', source.id, undefined, origin.id);
    const creation = ctx.app
      .inject({
        method: 'POST',
        url: '/api/callbacks/propose-thread',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { title: 'replacement', reason: 'changed', supersedesProposalId: originalId },
      })
      .then((response) => response);
    const nextId = await visible;
    assert.equal((await ctx.approve('alice', originalId)).statusCode, 200);
    release();
    assert.equal((await creation).statusCode, 409);
    assert.equal((await ctx.proposalStore.get(nextId)).status, 'withdrawn');
    assert.ok(
      ctx.socketEvents.some(
        ({ userId, event, data }) =>
          userId === 'alice' &&
          event === 'proposal_updated' &&
          data.proposalId === nextId &&
          data.status === 'withdrawn',
      ),
    );
    assert.equal(ctx.threadStore.list('alice').length, 2, 'only the already-approved original creates a child');
  } finally {
    release();
    await ctx.app.close();
  }
});
