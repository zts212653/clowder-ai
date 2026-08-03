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

    const originByRequest = new Map();
    async function propose({ userId = 'user_1', catId = 'opus', threadId = 'thread_1', body } = {}) {
      const payload = body ?? { done: 'wrote A1 store', nextSteps: 'wire route' };
      const key = payload.clientRequestId ? `${userId}:${catId}:${threadId}:${payload.clientRequestId}` : undefined;
      let origin = key ? originByRequest.get(key) : undefined;
      if (!origin) {
        origin = await messageStore.append({
          userId,
          catId: null,
          content: 'Please hand off this session',
          mentions: [],
          timestamp: Date.now(),
          threadId,
        });
        if (key) originByRequest.set(key, origin);
      }
      const { invocationId, callbackToken } = await registry.create(userId, catId, threadId, undefined, origin.id);
      return app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-session-handoff',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload,
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

  it('direct user invocation anchors the handoff to its exact prompt origin without an A2A trigger', async () => {
    const ctx = await buildCtx();
    const origin = await ctx.messageStore.append({
      userId: 'user_1',
      catId: null,
      content: 'Please hand off this session directly',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'thread_1',
    });
    const auth = await ctx.registry.create('user_1', 'opus', 'thread_1', undefined, undefined, undefined, origin.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-session-handoff',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { done: 'finished work', nextSteps: 'continue fresh' },
    });

    assert.equal(res.statusCode, 200);
    const stored = await ctx.handoffStore.get(res.json().proposalId);
    assert.deepEqual(stored.publication.envelope.originRef, {
      kind: 'message',
      threadId: 'thread_1',
      messageId: origin.id,
    });
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

  it('envelope commit failure leaves staged card recoverable by an idempotent retry', async () => {
    const handoffStore = new InMemorySessionHandoffProposalStore();
    const commitEnvelope = handoffStore.commitEnvelope.bind(handoffStore);
    let failCommit = true;
    handoffStore.commitEnvelope = (id, envelope) => {
      if (failCommit) {
        failCommit = false;
        throw new Error('envelope commit blip');
      }
      return commitEnvelope(id, envelope);
    };
    const ctx = await buildCtx({ handoffStoreOverride: handoffStore });
    const body = { done: 'a', nextSteps: 'b', clientRequestId: 'marker-key' };
    const invoke = async (content) => {
      const origin = await ctx.messageStore.append({
        userId: 'user_1',
        catId: null,
        content,
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_1',
      });
      const auth = await ctx.registry.create('user_1', 'opus', 'thread_1', undefined, undefined, undefined, origin.id);
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-session-handoff',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: body,
      });
      return { origin, response };
    };
    const first = await invoke('Original handoff trigger');
    assert.equal(first.response.statusCode, 500, 'proposal is not approvable before the envelope commit point');
    const [staged] = await handoffStore.listPendingByUser('user_1');
    assert.equal(staged.publication.state, 'staged');

    const retry = await invoke('Later callback reusing the handoff key');
    assert.equal(retry.response.statusCode, 200, 'retry self-heals from the visible card instead of 503');
    assert.equal(retry.response.json().deduped, true, 'deduped success, not a misleading in-flight 503');
    const healed = await handoffStore.get(staged.proposalId);
    assert.equal(healed.publication.state, 'anchored');
    assert.deepEqual(healed.publication.envelope.originRef, {
      kind: 'message',
      threadId: 'thread_1',
      messageId: first.origin.id,
    });
    const cards = (await ctx.messageStore.getByThread('thread_1', 50)).filter((message) =>
      (message.extra?.rich?.blocks ?? []).some((block) => block.id === `handoff-${staged.proposalId}`),
    );
    assert.equal(cards.length, 1, 'retry reuses the persisted card instead of duplicating it');
  });

  it('card-append failure → phantom proposal deleted (frees A4 slot, not pinned)', async () => {
    const failingMessageStore = new MessageStore();
    const append = failingMessageStore.append.bind(failingMessageStore);
    failingMessageStore.append = async (input) => {
      if (input.idempotencyKey) throw new Error('append boom');
      return append(input);
    };
    const ctx = await buildCtx({ messageStoreOverride: failingMessageStore });
    const res = await ctx.propose();
    assert.equal(res.statusCode, 500, 'route surfaces the append failure (fastify catches the re-throw)');
    // no phantom pending left → A4 ≤1 slot freed so a retry can re-create a visible card
    const active = await ctx.handoffStore.listActiveBySession('sess_active');
    assert.equal(active.length, 0, 'phantom proposal deleted after card-append failure');
  });
});
