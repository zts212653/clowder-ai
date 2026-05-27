/**
 * F128 Proposal Flow — core lifecycle tests (propose / approve / reject).
 * Concurrency + stale recovery: proposal-concurrency.test.js
 * Partial-commit + dedup + self-heal: proposal-resilience.test.js
 *
 * Covers AC-B7:
 *  - cat-auth propose happy path
 *  - stale invocation guard
 *  - cross-user parent ownership rejection
 *  - clientRequestId idempotency
 *  - user-auth approve happy path + double-approve idempotency
 *  - cross-user approve 403
 *  - approve-after-reject 409
 *  - reject happy path + reject-after-approve 409
 *  - audit metadata + socket payload shape
 *  - edit-on-approve applied to created thread
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 propose / approve / reject lifecycle', () => {
  test('propose creates a pending proposal without creating a thread', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const before = ctx.threadStore.size;
    const res = await ctx.propose({ userId: 'alice', threadId: source.id });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'pending');
    assert.match(body.proposalId, /^proposal_/);
    assert.equal(ctx.threadStore.size, before, 'no new thread should be created on propose');
    const stored = await ctx.proposalStore.get(body.proposalId);
    assert.equal(stored.sourceThreadId, source.id);
    assert.equal(stored.parentThreadId, source.id);
  });

  test('propose returns stale_ignored when a newer invocation supersedes', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const first = await ctx.registry.create('alice', 'opus', source.id);
    await ctx.registry.create('alice', 'opus', source.id);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-thread',
      headers: { 'x-invocation-id': first.invocationId, 'x-callback-token': first.callbackToken },
      payload: { title: 't', reason: 'r' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'stale_ignored');
  });

  test('propose rejects parentThreadId owned by another user (403)', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const foreign = await ctx.threadStore.create('bob', 'Foreign');
    const res = await ctx.propose({ userId: 'alice', threadId: source.id, body: { parentThreadId: foreign.id } });
    assert.equal(res.statusCode, 403);
  });

  test('propose is idempotent on clientRequestId', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const first = await ctx.propose({ userId: 'alice', threadId: source.id, body: { clientRequestId: 'req-1' } });
    const second = await ctx.propose({ userId: 'alice', threadId: source.id, body: { clientRequestId: 'req-1' } });
    const firstId = JSON.parse(first.body).proposalId;
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.proposalId, firstId);
    assert.equal(secondBody.deduped, true);
  });

  test('approve creates a new thread and marks proposal approved', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'approved');
    const newThread = await ctx.threadStore.get(body.threadId);
    assert.ok(newThread);
    assert.equal(newThread.title, 'New thread');
    assert.equal(newThread.parentThreadId, source.id);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.status, 'approved');
    assert.equal(proposal.createdThreadId, body.threadId);
    assert.equal(proposal.approvedBy, 'alice');
  });

  // Approve-side dispatch behaviours (queue processor wiring, preferredCats
  // fallback, intent default, fork-and-return header, explicit-mention
  // precedence) moved to proposal-approve-dispatch.test.js to keep this file
  // under the AC-X1 350-line cap.
  test('double approve returns the same thread (idempotent)', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const first = JSON.parse((await ctx.approve('alice', proposalId)).body);
    const second = JSON.parse((await ctx.approve('alice', proposalId)).body);
    assert.equal(second.threadId, first.threadId);
    assert.equal(second.deduped, true);
  });

  test('approve by a different user returns 403', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const res = await ctx.approve('bob', proposalId);
    assert.equal(res.statusCode, 403);
  });

  test('approve after reject returns 409', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    await ctx.reject('alice', proposalId);
    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 409);
  });

  test('reject marks proposal rejected without creating a thread', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const sizeBefore = ctx.threadStore.size;
    const res = await ctx.reject('alice', proposalId, { rejectionReason: 'not now' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'rejected');
    assert.equal(ctx.threadStore.size, sizeBefore);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.status, 'rejected');
    assert.equal(proposal.rejectionReason, 'not now');
  });

  test('reject after approve returns 409', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    await ctx.approve('alice', proposalId);
    const res = await ctx.reject('alice', proposalId);
    assert.equal(res.statusCode, 409);
  });

  test('approve writes audit metadata onto the created thread', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const { threadId } = JSON.parse((await ctx.approve('alice', proposalId)).body);
    const thread = await ctx.threadStore.get(threadId);
    assert.equal(thread.createdFromProposalId, proposalId);
    assert.equal(thread.sourceThreadId, source.id);
    assert.equal(thread.approvedBy, 'alice');
    assert.ok(typeof thread.approvedAt === 'number' && thread.approvedAt > 0);
  });

  test('thread_created socket event emits the Thread itself (no envelope wrapper)', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    ctx.socketEvents.length = 0;
    await ctx.approve('alice', proposalId);
    const evt = ctx.socketEvents.find((e) => e.event === 'thread_created');
    assert.ok(evt);
    assert.ok(evt.data && typeof evt.data.id === 'string', 'payload must have id at top level');
    assert.equal(typeof evt.data.thread, 'undefined', 'payload must NOT be wrapped in {thread}');
  });

  test('approve applies user overrides (title + initialMessage)', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          threadId: source.id,
          body: { title: 'orig title', initialMessage: 'orig msg' },
        })
      ).body,
    );
    const res = await ctx.approve('alice', proposalId, { title: 'edited title', initialMessage: 'edited msg' });
    assert.equal(res.statusCode, 200);
    const { threadId } = JSON.parse(res.body);
    const newThread = await ctx.threadStore.get(threadId);
    assert.equal(newThread.title, 'edited title');
    const msgs = await ctx.messageStore.getByThread(threadId);
    const userMsg = msgs.find((m) => m.userId === 'alice' && m.catId === null);
    assert.ok(userMsg);
    // Server injects "## 主 Thread" header; edited message is at the start.
    assert.ok(userMsg.content.startsWith('edited msg'), 'thread first message should start with user-edited content');
    assert.ok(userMsg.content.includes('## 主 Thread'), 'thread first message should include parent header');
  });
});
