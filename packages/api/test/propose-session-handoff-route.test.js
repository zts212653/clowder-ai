/**
 * F225 ②a propose-session-handoff callback route tests.
 * 走真实 callbacksRoutes（含 callback auth hook）→ inject，验证薄 wire：
 * gate 路径（no-active / already-pending 不 seal）、确认卡 append + cardMessageId、
 * card-append 失败 → delete phantom（不 pin A4 slot）、schema 校验、stale guard。
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('propose-session-handoff route (F225 ②a)', () => {
  let InvocationRegistry;
  let MessageStore;
  let InMemorySessionHandoffProposalStore;
  let callbacksRoutes;

  beforeEach(async () => {
    ({ InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'));
    ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
    ({ InMemorySessionHandoffProposalStore } = await import(
      '../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js'
    ));
    ({ callbacksRoutes } = await import('../dist/routes/index.js'));
  });

  const ACTIVE = { id: 'sess_active', status: 'active', catId: 'opus', threadId: 'thread_1', userId: 'user_1' };

  async function buildCtx({ messageStoreOverride, sessionChainStoreOverride, handoffStoreOverride } = {}) {
    const registry = new InvocationRegistry();
    const messageStore = messageStoreOverride ?? new MessageStore();
    const handoffStore = handoffStoreOverride ?? new InMemorySessionHandoffProposalStore();
    const sessionChainStore = sessionChainStoreOverride ?? {
      getActive: async (catId, threadId) => (catId === ACTIVE.catId && threadId === ACTIVE.threadId ? ACTIVE : null),
    };
    const socketEvents = [];
    const socketManager = {
      emitToUser(userId, event, data) {
        socketEvents.push({ kind: 'user', userId, event, data });
      },
      broadcastToRoom(room, event, data) {
        socketEvents.push({ kind: 'room', room, event, data });
      },
    };
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      handoffProposalStore: handoffStore,
      sessionChainStore,
      evidenceStore: {
        ingestRaw() {},
        search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { reflect() {} },
    });

    async function propose({ userId = 'user_1', catId = 'opus', threadId = 'thread_1', body } = {}) {
      const { invocationId, callbackToken } = await registry.create(userId, catId, threadId);
      return app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-session-handoff',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: body ?? { done: 'wrote A1 store', nextSteps: 'wire route' },
      });
    }

    return { app, registry, messageStore, handoffStore, socketEvents, propose };
  }

  it('happy path: creates pending proposal + appends card + records cardMessageId + broadcasts', async () => {
    const ctx = await buildCtx();
    const res = await ctx.propose();
    assert.equal(res.statusCode, 200);
    const json = res.json();
    assert.ok(json.proposalId);
    assert.equal(json.status, 'pending');
    assert.ok(json.messageId);

    const stored = await ctx.handoffStore.get(json.proposalId);
    assert.equal(stored.sourceSessionId, 'sess_active', 'sealed session resolved from getActive');
    assert.equal(stored.cardMessageId, json.messageId, 'cardMessageId checkpoint recorded');

    const msgs = await ctx.messageStore.getByThread('thread_1', 50);
    const card = msgs.find((m) => m.id === json.messageId);
    assert.ok(card, 'card message appended to source thread');
    assert.equal(card.extra?.rich?.blocks?.[0]?.id, `handoff-${json.proposalId}`, 'confirmation card block present');

    assert.ok(
      ctx.socketEvents.some((e) => e.kind === 'room' && e.room === 'thread:thread_1'),
      'broadcast to thread room',
    );
  });

  it('no active session → gate rejected (200, not seal, not error)', async () => {
    const ctx = await buildCtx();
    const res = await ctx.propose({ catId: 'opus', threadId: 'thread_no_active' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'rejected');
    assert.equal(res.json().reason, 'no_active_session');
  });

  it('A4: second propose for same active session → already_pending (wire A4 guard)', async () => {
    const ctx = await buildCtx();
    const first = await ctx.propose();
    assert.equal(first.json().status, 'pending');
    const second = await ctx.propose();
    assert.equal(second.json().status, 'rejected');
    assert.equal(second.json().reason, 'already_pending');
  });

  it('invalid body (missing nextSteps) → 400', async () => {
    const ctx = await buildCtx();
    const res = await ctx.propose({ body: { done: 'only done' } });
    assert.equal(res.statusCode, 400);
  });

  it('云端 P2: transport retry (SAME clientRequestId) → deduped original, not already_pending', async () => {
    const ctx = await buildCtx();
    // callbackPost retries the SAME body on 408/429/5xx; the MCP handler pins one clientRequestId
    // per call, reused across that call's transport retries.
    const body = { done: 'wrote A1 store', nextSteps: 'wire route', clientRequestId: 'retry-key-1' };
    const first = await ctx.propose({ body });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, 'pending');
    const firstId = first.json().proposalId;

    const retry = await ctx.propose({ body }); // same clientRequestId = a transport retry
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().deduped, true, 'retry resolves to the original proposal, not a misleading rejection');
    assert.equal(retry.json().proposalId, firstId, 'same proposalId returned to the retry');
    assert.ok(retry.json().messageId, 'original card messageId surfaced (card already visible)');

    // A4 ≤1 holds: the retry created NO second proposal.
    const active = await ctx.handoffStore.listActiveBySession('sess_active');
    assert.equal(active.length, 1, 'transport retry did not create a duplicate proposal');
  });

  it('云端 P2: distinct MCP calls (different clientRequestId, same session) still hit A4 already_pending', async () => {
    const ctx = await buildCtx();
    const first = await ctx.propose({ body: { done: 'a', nextSteps: 'b', clientRequestId: 'key-A' } });
    assert.equal(first.json().status, 'pending');
    // different key = a genuinely new propose intent, NOT a transport retry → A4 must still guard.
    const second = await ctx.propose({ body: { done: 'c', nextSteps: 'd', clientRequestId: 'key-B' } });
    assert.equal(second.json().status, 'rejected');
    assert.equal(second.json().reason, 'already_pending', 'different key ≠ retry → A4 ≤1-pending preserved');
  });

  it('砚砚 P2-A: a throw AFTER reserve releases the dedup key — retry re-creates, not stuck on 503', async () => {
    // reserveDedup is SET NX (no overwrite). If proposeSessionHandoff throws after reserve and we do
    // NOT release, the key points at a never-created proposal and every retry 503s forever (InMemory).
    let calls = 0;
    const flakyChain = {
      getActive: async (catId, threadId) => {
        calls += 1;
        if (calls === 1) throw new Error('store blip after reserve, before create');
        return catId === ACTIVE.catId && threadId === ACTIVE.threadId ? ACTIVE : null;
      },
    };
    const ctx = await buildCtx({ sessionChainStoreOverride: flakyChain });
    const body = { done: 'a', nextSteps: 'b', clientRequestId: 'throw-key' };
    const first = await ctx.propose({ body });
    assert.equal(first.statusCode, 500, 'first attempt throws (getActive blip after reserve)');
    // retry with the SAME clientRequestId must re-create (key was released), not 503 on a phantom.
    const retry = await ctx.propose({ body });
    assert.equal(retry.statusCode, 200, 'retry is not stuck — the reserved key was released on throw');
    assert.equal(retry.json().status, 'pending', 'retry re-created a real proposal');
    assert.ok(retry.json().proposalId);
  });

  it('砚砚 P2-B: card appended but marker-write fails → retry self-heals to deduped (not 503)', async () => {
    // recordCheckpoint(cardMessageId) throws → proposal stays WITHOUT cardMessageId, but the card IS
    // appended + visible. A retry must scan the thread, find the card, and return deduped success.
    const handoffStore = new InMemorySessionHandoffProposalStore();
    const origRecordCheckpoint = handoffStore.recordCheckpoint.bind(handoffStore);
    handoffStore.recordCheckpoint = (id, patch) => {
      if (patch.cardMessageId) throw new Error('marker write blip');
      return origRecordCheckpoint(id, patch);
    };
    const ctx = await buildCtx({ handoffStoreOverride: handoffStore });
    const body = { done: 'a', nextSteps: 'b', clientRequestId: 'marker-key' };
    const first = await ctx.propose({ body });
    assert.equal(first.statusCode, 200, 'card appended despite marker-write failure (degraded to warning)');
    const firstMsgId = first.json().messageId;
    const pid = first.json().proposalId;
    assert.equal((await handoffStore.get(pid)).cardMessageId, undefined, 'marker not set (write failed)');

    const retry = await ctx.propose({ body });
    assert.equal(retry.statusCode, 200, 'retry self-heals from the visible card instead of 503');
    assert.equal(retry.json().deduped, true, 'deduped success, not a misleading in-flight 503');
    assert.equal(retry.json().messageId, firstMsgId, 'recovered the original visible card messageId');
  });

  it('card-append failure → phantom proposal deleted (frees A4 slot, not pinned)', async () => {
    const failingMessageStore = new MessageStore();
    failingMessageStore.append = async () => {
      throw new Error('append boom');
    };
    const ctx = await buildCtx({ messageStoreOverride: failingMessageStore });
    const res = await ctx.propose();
    assert.equal(res.statusCode, 500, 'route surfaces the append failure (fastify catches the re-throw)');
    // no phantom pending left → A4 ≤1 slot freed so a retry can re-create a visible card
    const active = await ctx.handoffStore.listActiveBySession('sess_active');
    assert.equal(active.length, 0, 'phantom proposal deleted after card-append failure');
  });
});
