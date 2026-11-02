import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

async function revision(ctx, original, source, body = {}, instruction = '只改第一条消息') {
  const origin = await ctx.messageStore.append({
    from: { kind: 'user', userId: 'alice' },
    userId: 'alice',
    threadId: source.id,
    content: instruction,
    mentions: [],
    timestamp: Date.now(),
  });
  await ctx.proposalStore.recordRevisionRequest(original.proposalId, {
    messageId: origin.id,
    instruction: origin.content,
    requestedBy: 'alice',
    requestedAt: Date.now(),
  });
  const { invocationId, callbackToken } = await ctx.registry.create('alice', 'opus', source.id, undefined, origin.id);
  return ctx.app.inject({
    method: 'POST',
    url: '/api/callbacks/propose-thread',
    headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    payload: {
      title: original.title,
      reason: '只改内容，其余照旧',
      supersedesProposalId: original.proposalId,
      ...body,
    },
  });
}

test('a content revision retains omitted assignment, workflow, parent and task binding', async () => {
  const task = { id: 'revision-task', userId: 'alice', title: '原任务' };
  const ctx = await createProposalTestContext({ taskStoreOverride: { get: () => task } });
  try {
    const source = ctx.threadStore.create('alice', 'source');
    const parent = ctx.threadStore.create('alice', 'original parent');
    const created = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'same work',
        preferredCats: ['codex'],
        initialMessage: '原消息',
        reportingMode: 'blocking-ack',
        declaredWorkMode: 'investigation',
        parentThreadId: parent.id,
        subjectTaskId: task.id,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const old = await ctx.proposalStore.get(created.json().proposalId);
    const replaced = await revision(ctx, old, source, { initialMessage: '新消息' });
    assert.equal(replaced.statusCode, 200, replaced.body);
    const next = await ctx.proposalStore.get(replaced.json().proposalId);
    const keys = [
      'preferredCats',
      'reportingMode',
      'declaredWorkMode',
      'parentThreadId',
      'subjectTaskId',
      'subjectTaskTitle',
    ];
    assert.deepEqual(
      Object.fromEntries(keys.map((key) => [key, next[key]])),
      Object.fromEntries(keys.map((key) => [key, old[key]])),
    );
    assert.equal(next.initialMessage, '新消息');
    const reassigned = await revision(ctx, next, source, { preferredCats: ['opus'] }, '换 opus 先开口');
    assert.equal(reassigned.statusCode, 200, reassigned.body);
    const latest = await ctx.proposalStore.get(reassigned.json().proposalId);
    assert.deepEqual(latest.preferredCats, ['opus']);
    assert.equal(latest.initialMessage, '新消息');
    assert.equal(latest.subjectTaskId, task.id);
  } finally {
    await ctx.app.close();
  }
});

test('inherited task binding is revalidated instead of dropping it when ownership changes', async () => {
  const task = { id: 'revision-task', userId: 'alice', title: '原任务' };
  const ctx = await createProposalTestContext({ taskStoreOverride: { get: () => task } });
  try {
    const source = ctx.threadStore.create('alice', 'source');
    const created = await ctx.propose({ userId: 'alice', threadId: source.id, body: { subjectTaskId: task.id } });
    assert.equal(created.statusCode, 200, created.body);
    const old = await ctx.proposalStore.get(created.json().proposalId);
    task.userId = 'bob';
    const replaced = await revision(ctx, old, source);
    assert.equal(replaced.statusCode, 403, replaced.body);
    assert.equal((await ctx.proposalStore.get(old.proposalId)).status, 'pending');
  } finally {
    await ctx.app.close();
  }
});

test('a revision honors explicit clears and workflow changes instead of restoring the old values', async () => {
  const ctx = await createProposalTestContext();
  try {
    const source = ctx.threadStore.create('alice', 'source');
    const parent = ctx.threadStore.create('alice', 'old parent');
    const created = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        preferredCats: ['codex'],
        initialMessage: '原消息',
        reportingMode: 'blocking-ack',
        declaredWorkMode: 'investigation',
        parentThreadId: parent.id,
      },
    });
    const old = await ctx.proposalStore.get(created.json().proposalId);
    const replaced = await revision(ctx, old, source, {
      preferredCats: [],
      initialMessage: '',
      reportingMode: 'none',
      declaredWorkMode: 'standalone',
      parentThreadId: source.id,
    });
    assert.equal(replaced.statusCode, 200, replaced.body);
    const next = await ctx.proposalStore.get(replaced.json().proposalId);
    assert.deepEqual(next.preferredCats, []);
    assert.equal(next.initialMessage, undefined);
    assert.equal(next.reportingMode, 'none');
    assert.equal(next.declaredWorkMode, 'standalone');
    assert.equal(next.parentThreadId, source.id);
  } finally {
    await ctx.app.close();
  }
});
