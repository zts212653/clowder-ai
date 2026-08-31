/**
 * sol R3 P1 补缺 — 四路径 mismatch gate 零副作用矩阵。
 *
 * 证明 checkRoutingMismatch 在以下四条执行路径上均在所有副作用之前触发：
 *   1. normal invocation-token（claim / buffer-consume / TTS 不触发）
 *   2. agent-key（claim / TTS 不触发）
 *   3. invocation-token + assign_work（DispatchProposal 不创建）
 *   4. invocation-token + freshness-enabled（deliveryCursorStore 不触及）
 *
 * 设计：每条路径注入可观测 spy mock，断言 HELD 返回 + spy 未被调用。
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';

function mkConfig(catId, patterns) {
  return {
    id: createCatId(catId),
    name: `${catId}-name`,
    displayName: `${catId}-display`,
    avatar: `/avatars/${catId}.png`,
    color: { primary: '#000000', secondary: '#ffffff' },
    mentionPatterns: patterns,
    clientId: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    mcpSupport: true,
  };
}

// Reuse same ambiguity pair as callback-ambiguity tests — already registered by setup
for (const [catId, patterns] of [
  ['cbk-amb-a', ['@cbk-amb-a', '@回名']],
  ['cbk-amb-b', ['@cbk-amb-b', '@回名']],
]) {
  if (!catRegistry.has(catId)) catRegistry.register(catId, mkConfig(catId, patterns));
}

/** Thread store supporting cross-thread access (two threads, same user). */
function makeXThreadStore() {
  const threads = {
    't-source': { id: 't-source', title: 'source', preferredCats: [], createdBy: 'user-1' },
    't-target': { id: 't-target', title: 'target', preferredCats: [], createdBy: 'user-1' },
    't-cbk': { id: 't-cbk', title: 'cbk', preferredCats: [], createdBy: 'user-1' },
  };
  return {
    get: (id) => threads[id] ?? null,
    list: () => Object.values(threads),
    getParticipants: () => ['opus', 'cbk-amb-a', 'cbk-amb-b'],
    addParticipants: () => {},
    getParticipantsWithActivity: () => [],
    updateParticipantActivity: () => {},
    updateLastActive: () => {},
  };
}

/** DispatchProposalStore spy — records create calls. */
function makeProposalSpy() {
  const calls = [];
  return {
    create: (input) => {
      calls.push(input);
      return input;
    },
    findByClientMessageId: () => null,
    getCalls: () => calls,
  };
}

/** DeliveryCursorStore spy — records all method calls. */
function makeCursorSpy() {
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push({ method: name, args });
      return null;
    };
  return {
    getSeenCursor: record('getSeenCursor'),
    ackSeenCursor: record('ackSeenCursor'),
    getMentionAckCursor: record('getMentionAckCursor'),
    ackMentionCursor: record('ackMentionCursor'),
    getCalls: () => calls,
  };
}

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser() {},
  };
}

function createMockRouter() {
  return {
    async *routeExecution(_uid, _msg, _tid, _umid, targets) {
      yield { type: 'done', catId: targets[0], isFinal: true, timestamp: Date.now() };
    },
  };
}

function createMockInvocationRecordStore() {
  return { create: () => ({ outcome: 'created', invocationId: 'inv-noop' }), update() {} };
}

function makeAgentKeyRegistry() {
  return {
    async verify() {
      return {
        ok: true,
        record: {
          agentKeyId: 'ak_matrix',
          catId: 'opus',
          userId: 'user-1',
          secretHash: 'x',
          salt: 'y',
          scope: 'user-bound',
          issuedAt: Date.now(),
          expiresAt: Date.now() + 86400000,
        },
      };
    },
    claimClientMessageId: () => true,
  };
}

/** Content with embedded cc_rich audio block (needs TTS synthesis: has text, no url). */
function audioContent(mention) {
  const block = JSON.stringify({ v: 1, blocks: [{ kind: 'audio', v: 1, id: 'aud-spy', text: '测试语音' }] });
  return `${mention} 给你\n\`\`\`cc_rich\n${block}\n\`\`\``;
}

/** Init VoiceBlockSynthesizer singleton with a counting mock TTS provider. */
async function initTtsSpy(cacheDir) {
  const { TtsRegistry } = await import('../dist/domains/cats/services/tts/TtsRegistry.js');
  const { initVoiceBlockSynthesizer } = await import('../dist/domains/cats/services/tts/VoiceBlockSynthesizer.js');
  const synthCalls = [];
  const mockProvider = {
    id: 'mock-tts',
    model: 'test-v1',
    async synthesize(req) {
      synthCalls.push(req);
      return {
        audio: new Uint8Array([0, 1]),
        format: 'wav',
        durationSec: 0.1,
        metadata: { provider: 'mock', model: 'test-v1', voice: req.voice },
      };
    },
  };
  const reg = new TtsRegistry();
  reg.register(mockProvider);
  initVoiceBlockSynthesizer(reg, cacheDir);
  return { getSynthCalls: () => synthCalls };
}

describe('sol R3 P1：4-path mismatch gate 零副作用矩阵', () => {
  let registry;
  let messageStore;
  let invocationQueue;
  let queueProcessor;
  let ttsCacheDir;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    invocationQueue = new InvocationQueue();
    queueProcessor = { async requestDrain() {} };
    ttsCacheDir = mkdtempSync(join(tmpdir(), 'tts-matrix-'));
  });

  afterEach(() => {
    if (ttsCacheDir) rmSync(ttsCacheDir, { recursive: true, force: true });
  });

  async function createApp(opts = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager: createMockSocketManager(),
      router: createMockRouter(),
      invocationRecordStore: createMockInvocationRecordStore(),
      invocationQueue,
      queueProcessor,
      ...opts,
    });
    return app;
  }

  // ── Path 1: normal invocation-token ──
  // Already covered by f257-fix1-callback-ambiguity.test.js (claim + buffer tests).
  // Include a reference assertion here to complete the matrix in one file.

  test('path-1 invocation-token normal：mismatch → HELD（claim 不触发）', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't-cbk');
    const cmid = 'cmid-path1-matrix';

    const held = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: '@cbk-amb-b 给你', targetCats: ['cbk-amb-a'], clientMessageId: cmid },
    });
    assert.equal(JSON.parse(held.body).status, 'held');
    assert.equal(JSON.parse(held.body).reason, 'routing_mismatch');

    // Proof: retry with SAME clientMessageId succeeds (claim was not consumed)
    const retry = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: '@cbk-amb-a 给你', targetCats: ['cbk-amb-a'], clientMessageId: cmid },
    });
    assert.notEqual(JSON.parse(retry.body).status, 'duplicate', 'claim must not fire before gate');
  });

  // ── Path 2: agent-key (claim + TTS) ──

  test('path-2a agent-key：mismatch + audio → HELD（real TTS provider spy：synthCalls===0）', async () => {
    const { getSynthCalls } = await initTtsSpy(ttsCacheDir);
    const agentKeyReg = makeAgentKeyRegistry();
    const claimCalls = [];
    agentKeyReg.claimClientMessageId = (...args) => {
      claimCalls.push(args);
      return true;
    };
    const app = await createApp({
      agentKeyRegistry: agentKeyReg,
      threadStore: makeXThreadStore(),
    });

    const held = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'valid-secret' },
      payload: {
        content: audioContent('@cbk-amb-b'),
        threadId: 't-cbk',
        targetCats: ['cbk-amb-a'],
        clientMessageId: 'cmid-p2a',
      },
    });
    const body = JSON.parse(held.body);
    assert.equal(body.status, 'held');
    assert.equal(body.reason, 'routing_mismatch');
    assert.equal(claimCalls.length, 0, 'claim must not fire before gate');
    assert.equal(getSynthCalls().length, 0, 'TTS provider must NOT be called on HELD — gate precedes TTS');
  });

  test('path-2b agent-key：concurrent same-key + audio → ok+duplicate, synthCalls===1, stored===1', async () => {
    const { getSynthCalls } = await initTtsSpy(ttsCacheDir);
    const claimed = new Set();
    const agentKeyReg = makeAgentKeyRegistry();
    agentKeyReg.claimClientMessageId = (_akId, cmid) => {
      if (claimed.has(cmid)) return false;
      claimed.add(cmid);
      return true;
    };
    const app = await createApp({
      agentKeyRegistry: agentKeyReg,
      threadStore: makeXThreadStore(),
    });
    const cmid = 'cmid-concurrent-tts';
    const payload = {
      content: audioContent('@cbk-amb-a'),
      threadId: 't-cbk',
      targetCats: ['cbk-amb-a'],
      clientMessageId: cmid,
    };
    const headers = { 'x-agent-key-secret': 'valid-secret' };

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload }),
      app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload }),
    ]);
    const b1 = JSON.parse(r1.body);
    const b2 = JSON.parse(r2.body);
    const statuses = [b1.status, b2.status].sort();
    assert.deepEqual(statuses, ['duplicate', 'ok'], 'one ok + one duplicate');
    assert.equal(getSynthCalls().length, 1, 'TTS called exactly once — claim deduplicates before TTS');
    const stored = messageStore.getByThread('t-cbk');
    assert.equal(stored.length, 1, 'exactly one message stored');
  });

  // ── Path 3: assign_work (cross-thread + effectClass) ──

  test('path-3 assign_work：mismatch → HELD（DispatchProposal 不创建）', async () => {
    const proposalSpy = makeProposalSpy();
    const app = await createApp({
      threadStore: makeXThreadStore(),
      dispatchProposalStore: proposalSpy,
    });
    // Invocation in t-source; request routes to t-target (cross-thread)
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't-source');

    const held = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '@cbk-amb-b 这个任务给你',
        threadId: 't-target',
        targetCats: ['cbk-amb-a'],
        effectClass: 'assign_work',
      },
    });
    const body = JSON.parse(held.body);
    assert.equal(body.status, 'held', 'assign_work with mismatch must be HELD');
    assert.equal(body.reason, 'routing_mismatch');
    assert.equal(proposalSpy.getCalls().length, 0, 'no DispatchProposal created — gate fires before intercept');
  });

  // ── Path 4: freshness-enabled ──

  test('path-4 freshness-enabled：mismatch → HELD（deliveryCursorStore 不触及）', async () => {
    const cursorSpy = makeCursorSpy();
    const app = await createApp({
      deliveryCursorStore: cursorSpy,
    });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't-cbk');

    const held = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: '@cbk-amb-b 给你', targetCats: ['cbk-amb-a'] },
    });
    const body = JSON.parse(held.body);
    assert.equal(body.status, 'held', 'freshness-enabled path with mismatch must be HELD');
    assert.equal(body.reason, 'routing_mismatch', 'must be routing_mismatch, not freshness hold');
    assert.equal(
      cursorSpy.getCalls().length,
      0,
      'deliveryCursorStore must not be touched — gate fires before freshness',
    );
  });
});
