import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

for (const pinned of [true, false, undefined]) {
  test(`approval creates with initial pinned=${pinned} before dispatch and publication`, async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    let ctx;
    const dispatchPins = [];
    ctx = await createProposalTestContext({
      invocationQueueOverride: new InvocationQueue(),
      routerOverride: {
        async resolveTargetsAndIntent(_content, threadId) {
          dispatchPins.push((await ctx.threadStore.get(threadId)).pinned ?? false);
          return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: false };
        },
      },
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = (
      await ctx.propose({
        userId: 'alice',
        threadId: source.id,
        body: { initialMessage: 'Start this work' },
      })
    ).json();
    const create = ctx.threadStore.create.bind(ctx.threadStore);
    const births = [];
    ctx.threadStore.create = (...args) => {
      const thread = create(...args);
      births.push({ pinned: thread.pinned ?? false, pinnedAt: thread.pinnedAt });
      return thread;
    };
    const response = await ctx.approve('alice', proposalId, pinned === undefined ? {} : { pinned });
    assert.equal(response.statusCode, 200, response.body);
    const threadId = response.json().threadId;
    const thread = await ctx.threadStore.get(threadId);
    assert.equal(thread.pinned ?? false, pinned === true);
    assert.equal(births[0].pinned, pinned === true, 'first create return must already reflect pin');
    if (pinned) assert.equal(typeof births[0].pinnedAt, 'number');
    assert.deepEqual(dispatchPins, [pinned === true]);
    assert.equal(
      ctx.socketEvents.find((event) => event.event === 'thread_created').data.pinned ?? false,
      pinned === true,
    );
    ctx.threadStore.updatePin(threadId, false);
    const replay = await ctx.approve('alice', proposalId, { pinned: true });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().threadId, threadId);
    assert.equal((await ctx.threadStore.get(threadId)).pinned, false, 'replay must preserve a later manual unpin');
    assert.equal(births.length, 1);
    await ctx.app.close();
  });
}

test('approval pin keeps owner authentication and strict boolean validation', async () => {
  const ctx = await createProposalTestContext();
  const source = await ctx.threadStore.create('alice', 'Source');
  const { proposalId } = (await ctx.propose({ userId: 'alice', threadId: source.id })).json();
  const count = ctx.threadStore.size;
  assert.equal((await ctx.approve('bob', proposalId, { pinned: true })).statusCode, 403);
  assert.equal(
    (await ctx.app.inject({ method: 'POST', url: `/api/proposals/${proposalId}/approve`, payload: { pinned: true } }))
      .statusCode,
    401,
  );
  assert.equal((await ctx.approve('alice', proposalId, { pinned: 'true' })).statusCode, 400);
  assert.equal(ctx.threadStore.size, count);
  assert.equal((await ctx.proposalStore.get(proposalId)).status, 'pending');
  await ctx.app.close();
});

test('stale approval recovers its already-created pin without applying retry preferences', async () => {
  const ctx = await createProposalTestContext();
  const source = await ctx.threadStore.create('alice', 'Source');
  const { proposalId } = (await ctx.propose({ userId: 'alice', threadId: source.id })).json();
  ctx.proposalStore.claimForApproval({ proposalId, approvedBy: 'alice' });
  const created = ctx.threadStore.create(
    'alice',
    'Created before interruption',
    undefined,
    undefined,
    undefined,
    undefined,
    { pinned: true },
  );
  ctx.proposalStore.recordCreatedThread(proposalId, created.id);
  ctx.proposalStore.proposals.get(proposalId).claimedAt = Date.now() - 60_000;
  const count = ctx.threadStore.size;
  const response = await ctx.approve('alice', proposalId, { pinned: false });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().threadId, created.id);
  assert.equal(response.json().recovered, true);
  assert.equal((await ctx.threadStore.get(created.id)).pinned, true);
  assert.equal(ctx.threadStore.size, count);
  await ctx.app.close();
});
