/**
 * F128 Proposal Flow — partial-commit, dedup race, and self-heal tests.
 * Split from proposal-flow.test.js to keep each file under the 350-line hard limit (AC-X1).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

async function createInvocationWithOrigin(ctx, threadId) {
  const origin = await ctx.messageStore.append({
    userId: 'alice',
    catId: null,
    content: 'Please propose this child thread',
    mentions: [],
    timestamp: Date.now(),
    threadId,
  });
  return ctx.registry.create('alice', 'opus', threadId, undefined, origin.id);
}

describe('F128 partial-commit + dedup + self-heal', () => {
  test('initialMessage append failure does NOT roll back the thread or proposal (best-effort warning)', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    class FailingMessageStore extends MessageStore {
      append(msg) {
        if (String(msg.content ?? '').includes('will fail to post')) {
          throw new Error('synthetic append failure');
        }
        return super.append(msg);
      }
    }
    const ctx = await createProposalTestContext({ messageStoreOverride: new FailingMessageStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (await ctx.propose({ userId: 'alice', threadId: source.id, body: { initialMessage: 'will fail to post' } })).body,
    );
    const threadsBefore = ctx.threadStore.size;
    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'approved');
    assert.ok(Array.isArray(body.warnings));
    assert.ok(body.warnings.some((w) => w.includes('initialMessage')));
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.status, 'approved', 'proposal must NOT roll back to pending after thread creation');
    assert.equal(ctx.threadStore.size, threadsBefore + 1, 'thread must remain');
  });

  test('self-heal works even when 60+ messages accumulated after envelope commit failure', async () => {
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    class FlakyEnvelopeStore extends InMemoryProposalStore {
      constructor() {
        super();
        this.failNext = true;
      }
      commitEnvelope(proposalId, envelope) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('synthetic envelope failure');
        }
        return super.commitEnvelope(proposalId, envelope);
      }
    }
    const ctx = await createProposalTestContext({ proposalStoreOverride: new FlakyEnvelopeStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await createInvocationWithOrigin(ctx, source.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const payload = {
      title: 'Old card retry',
      reason: 'Marker fails then thread fills up',
      clientRequestId: 'old-card-key',
    };
    const send = () => ctx.app.inject({ method: 'POST', url: '/api/callbacks/propose-thread', headers, payload });
    const first = await send();
    assert.equal(first.statusCode, 500);
    for (let i = 0; i < 60; i++) {
      await ctx.messageStore.append({
        userId: 'alice',
        catId: null,
        content: `filler ${i}`,
        mentions: [],
        timestamp: Date.now() + i,
        threadId: source.id,
      });
    }
    const second = await send();
    assert.equal(second.statusCode, 200, `retry must self-heal old card, got ${second.statusCode}`);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);
    const healed = await ctx.proposalStore.get(secondBody.proposalId);
    assert.ok(healed.cardMessageId);
    assert.equal(healed.publication.state, 'anchored');
  });

  test('dedup retries keep returning a visible pre-Phase-I proposal without publication metadata', async () => {
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    class LegacyProposalStore extends InMemoryProposalStore {
      get(proposalId) {
        const proposal = super.get(proposalId);
        if (proposal) delete proposal.publication;
        return proposal;
      }
      getPublication() {
        return null;
      }
    }
    const proposalStore = new LegacyProposalStore();
    const ctx = await createProposalTestContext({ proposalStoreOverride: proposalStore });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await createInvocationWithOrigin(ctx, source.id);
    const legacy = proposalStore.create({
      proposalId: 'legacy-f128-proposal',
      sourceThreadId: source.id,
      sourceInvocationId: invocationId,
      sourceCatId: 'opus',
      title: 'Legacy proposal',
      reason: 'Created before Phase I',
      parentThreadId: source.id,
      preferredCats: [],
      projectPath: 'default',
      createdBy: 'alice',
    });
    const legacyCard = await ctx.messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'Legacy approval card',
      mentions: [],
      timestamp: Date.now(),
      threadId: source.id,
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: `proposal-${legacy.proposalId}`, kind: 'card', v: 1, title: 'Legacy proposal' }],
        },
      },
    });
    proposalStore.reserveDedup('alice', 'legacy-f128-key', legacy.proposalId);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-thread',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'Ignored retry body', reason: 'Dedup should win', clientRequestId: 'legacy-f128-key' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      proposalId: legacy.proposalId,
      status: 'pending',
      messageId: legacyCard.id,
      deduped: true,
    });
    assert.equal((await proposalStore.get(legacy.proposalId)).cardMessageId, legacyCard.id);
  });

  test('envelope failure leaves staged proposal undecidable until retry anchors the existing card', async () => {
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    class FlakyEnvelopeStore extends InMemoryProposalStore {
      constructor() {
        super();
        this.failNext = true;
      }
      commitEnvelope(proposalId, envelope) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('synthetic envelope write failure');
        }
        return super.commitEnvelope(proposalId, envelope);
      }
    }
    const ctx = await createProposalTestContext({ proposalStoreOverride: new FlakyEnvelopeStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await createInvocationWithOrigin(ctx, source.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const payload = {
      title: 'Marker fail test',
      reason: 'Marker write throws',
      clientRequestId: 'marker-fail-key',
    };
    const send = () => ctx.app.inject({ method: 'POST', url: '/api/callbacks/propose-thread', headers, payload });
    const first = await send();
    assert.equal(first.statusCode, 500);
    const [stored] = await ctx.proposalStore.listPending('alice');
    assert.equal(stored.publication.state, 'staged');
    assert.equal((await ctx.approve('alice', stored.proposalId)).statusCode, 409);
    const second = await send();
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.proposalId, stored.proposalId);
    assert.equal(secondBody.deduped, true);
    const healed = await ctx.proposalStore.get(stored.proposalId);
    assert.equal(healed.publication.state, 'anchored');
  });

  test('concurrent retry coalesces behind the in-flight card append and returns the same anchor', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    let releaseFirstAppend;
    const firstAppendBlocked = new Promise((resolve) => {
      releaseFirstAppend = resolve;
    });
    let signalFirstAppend;
    const firstAppendStarted = new Promise((resolve) => {
      signalFirstAppend = resolve;
    });
    let firstAppendSeen = false;
    class BlockingMessageStore extends MessageStore {
      async append(msg) {
        if (!firstAppendSeen && String(msg.content ?? '').startsWith('提议新建 thread')) {
          firstAppendSeen = true;
          signalFirstAppend();
          await firstAppendBlocked;
        }
        return super.append(msg);
      }
    }
    const ctx = await createProposalTestContext({ messageStoreOverride: new BlockingMessageStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await createInvocationWithOrigin(ctx, source.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const payload = {
      title: 'In-flight test',
      reason: 'Card append blocks',
      clientRequestId: 'inflight-key',
    };
    const send = () => ctx.app.inject({ method: 'POST', url: '/api/callbacks/propose-thread', headers, payload });
    const firstPromise = send();
    await firstAppendStarted;
    let secondSettled = false;
    const secondPromise = send().then((response) => {
      secondSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(secondSettled, false, 'retry waits for the canonical in-flight publication');
    releaseFirstAppend();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.statusCode, 200);
    const winningId = JSON.parse(first.body).proposalId;
    assert.equal(second.statusCode, 200);
    assert.equal(JSON.parse(second.body).proposalId, winningId);
    assert.equal(JSON.parse(second.body).deduped, true);
  });

  test('card append failure cleans up proposal + releases dedup so retry creates a visible card', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    class FailFirstAppendStore extends MessageStore {
      constructor() {
        super();
        this.failNext = true;
      }
      append(msg) {
        if (this.failNext && msg.idempotencyKey) {
          this.failNext = false;
          throw new Error('synthetic card append failure');
        }
        return super.append(msg);
      }
    }
    const ctx = await createProposalTestContext({ messageStoreOverride: new FailFirstAppendStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await createInvocationWithOrigin(ctx, source.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const payload = {
      title: 'Card retry test',
      reason: 'Verify card append cleanup',
      clientRequestId: 'card-retry-key',
    };
    const first = await ctx.app.inject({ method: 'POST', url: '/api/callbacks/propose-thread', headers, payload });
    assert.notEqual(first.statusCode, 200);
    const pendingAfterFirst = await ctx.proposalStore.listPending('alice');
    assert.equal(pendingAfterFirst.length, 0);
    const second = await ctx.app.inject({ method: 'POST', url: '/api/callbacks/propose-thread', headers, payload });
    assert.equal(second.statusCode, 200);
    const body = JSON.parse(second.body);
    assert.notEqual(body.deduped, true);
    assert.ok(body.proposalId);
    const sourceMessages = await ctx.messageStore.getByThread(source.id);
    const cardMessage = sourceMessages.find((m) => String(m.content ?? '').startsWith('提议新建 thread'));
    assert.ok(cardMessage);
  });

  test('reserve success + create failure releases dedup so retry can reclaim', async () => {
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    class FailFirstCreateStore extends InMemoryProposalStore {
      constructor() {
        super();
        this.createCalls = 0;
      }
      create(input) {
        this.createCalls += 1;
        if (this.createCalls === 1) throw new Error('synthetic create failure');
        return super.create(input);
      }
    }
    const ctx = await createProposalTestContext({ proposalStoreOverride: new FailFirstCreateStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await createInvocationWithOrigin(ctx, source.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const payload = {
      title: 'Retry test',
      reason: 'Need to verify dedup release',
      clientRequestId: 'retry-key',
    };
    const first = await ctx.app.inject({ method: 'POST', url: '/api/callbacks/propose-thread', headers, payload });
    assert.notEqual(first.statusCode, 200);
    const second = await ctx.app.inject({ method: 'POST', url: '/api/callbacks/propose-thread', headers, payload });
    assert.equal(second.statusCode, 200);
    const body = JSON.parse(second.body);
    assert.notEqual(body.deduped, true);
    assert.ok(body.proposalId);
    const stored = await ctx.proposalStore.get(body.proposalId);
    assert.ok(stored);
    assert.equal(stored.status, 'pending');
  });

  test('dedup race: loser leaves no orphan proposal in the pending list', async () => {
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    class SlowReserveStore extends InMemoryProposalStore {
      async reserveDedup(userId, clientRequestId, proposalId) {
        await new Promise((r) => setTimeout(r, 30));
        return super.reserveDedup(userId, clientRequestId, proposalId);
      }
    }
    const ctx = await createProposalTestContext({ proposalStoreOverride: new SlowReserveStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await createInvocationWithOrigin(ctx, source.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-thread',
        headers,
        payload: {
          title: 'New thread',
          reason: 'Because',
          clientRequestId: 'race-key',
        },
      });
    const [first, second] = await Promise.all([send(), send()]);
    const firstBody = JSON.parse(first.body);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.proposalId, firstBody.proposalId);
    const pending = await ctx.proposalStore.listPending('alice');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].proposalId, firstBody.proposalId);
  });
});
