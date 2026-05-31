/**
 * F128 Proposal Flow — partial-commit, dedup race, and self-heal tests.
 * Split from proposal-flow.test.js to keep each file under the 350-line hard limit (AC-X1).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 partial-commit + dedup + self-heal', () => {
  test('initialMessage append failure does NOT roll back the thread or proposal (best-effort warning)', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    class FailingMessageStore extends MessageStore {
      append(msg) {
        if (msg.catId === null && msg.userId === 'alice') {
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

  test('self-heal works even when 60+ messages have accumulated after the marker failure', async () => {
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    class FlakyMarkerStore extends InMemoryProposalStore {
      constructor() {
        super();
        this.failNext = true;
      }
      setCardMessageId(proposalId, cardMessageId) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('synthetic marker failure');
        }
        return super.setCardMessageId(proposalId, cardMessageId);
      }
    }
    const ctx = await createProposalTestContext({ proposalStoreOverride: new FlakyMarkerStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await ctx.registry.create('alice', 'opus', source.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const payload = {
      title: 'Old card retry',
      reason: 'Marker fails then thread fills up',
      clientRequestId: 'old-card-key',
    };
    const send = () => ctx.app.inject({ method: 'POST', url: '/api/callbacks/propose-thread', headers, payload });
    const first = await send();
    assert.equal(first.statusCode, 200);
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
  });

  test('setCardMessageId failure: 200 with warning + retry self-heals via source thread scan', async () => {
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    class FlakyMarkerStore extends InMemoryProposalStore {
      constructor() {
        super();
        this.failNext = true;
      }
      setCardMessageId(proposalId, cardMessageId) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('synthetic marker write failure');
        }
        return super.setCardMessageId(proposalId, cardMessageId);
      }
    }
    const ctx = await createProposalTestContext({ proposalStoreOverride: new FlakyMarkerStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await ctx.registry.create('alice', 'opus', source.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const payload = {
      title: 'Marker fail test',
      reason: 'Marker write throws',
      clientRequestId: 'marker-fail-key',
    };
    const send = () => ctx.app.inject({ method: 'POST', url: '/api/callbacks/propose-thread', headers, payload });
    const first = await send();
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.ok(Array.isArray(firstBody.warnings));
    assert.ok(firstBody.warnings.some((w) => w.includes('setCardMessageId')));
    const stored = await ctx.proposalStore.get(firstBody.proposalId);
    assert.equal(stored.cardMessageId, undefined);
    const second = await send();
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.proposalId, firstBody.proposalId);
    assert.equal(secondBody.deduped, true);
    const healed = await ctx.proposalStore.get(firstBody.proposalId);
    assert.ok(healed.cardMessageId);
  });

  test('concurrent retry during in-flight card append returns 503 (not phantom 200 deduped)', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    let releaseFirstAppend;
    const firstAppendBlocked = new Promise((resolve) => {
      releaseFirstAppend = resolve;
    });
    let firstAppendSeen = false;
    class BlockingMessageStore extends MessageStore {
      async append(msg) {
        if (!firstAppendSeen && String(msg.content ?? '').startsWith('提议新建 thread')) {
          firstAppendSeen = true;
          await firstAppendBlocked;
        }
        return super.append(msg);
      }
    }
    const ctx = await createProposalTestContext({ messageStoreOverride: new BlockingMessageStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await ctx.registry.create('alice', 'opus', source.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const payload = {
      title: 'In-flight test',
      reason: 'Card append blocks',
      clientRequestId: 'inflight-key',
    };
    const send = () => ctx.app.inject({ method: 'POST', url: '/api/callbacks/propose-thread', headers, payload });
    const firstPromise = send();
    await new Promise((r) => setTimeout(r, 10));
    const second = await send();
    assert.equal(second.statusCode, 503, `expected 503 in-flight, got ${second.statusCode}: ${second.body}`);
    const body = JSON.parse(second.body);
    assert.equal(body.status, 'retryable');
    assert.notEqual(body.deduped, true);
    releaseFirstAppend();
    const first = await firstPromise;
    assert.equal(first.statusCode, 200);
    const winningId = JSON.parse(first.body).proposalId;
    const third = await send();
    assert.equal(third.statusCode, 200);
    const thirdBody = JSON.parse(third.body);
    assert.equal(thirdBody.proposalId, winningId);
    assert.equal(thirdBody.deduped, true);
  });

  test('card append failure cleans up proposal + releases dedup so retry creates a visible card', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    class FailFirstAppendStore extends MessageStore {
      constructor() {
        super();
        this.failNext = true;
      }
      append(msg) {
        if (this.failNext && msg.content && String(msg.content).startsWith('提议新建 thread')) {
          this.failNext = false;
          throw new Error('synthetic card append failure');
        }
        return super.append(msg);
      }
    }
    const ctx = await createProposalTestContext({ messageStoreOverride: new FailFirstAppendStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { invocationId, callbackToken } = await ctx.registry.create('alice', 'opus', source.id);
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
    const { invocationId, callbackToken } = await ctx.registry.create('alice', 'opus', source.id);
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
    const { invocationId, callbackToken } = await ctx.registry.create('alice', 'opus', source.id);
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
