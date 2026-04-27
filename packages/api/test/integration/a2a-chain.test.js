/**
 * A2A Chain Integration Tests
 * 验证 A2A 链通过 AgentRouter → routeSerial → parseA2AMentions 完整链路
 *
 * 使用 mock services, 不需要真实 CLI。
 */

import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { migrateRouterOpts } from '../helpers/agent-registry-helpers.js';

// Mock service that yields specific text
function createMockService(catId, text) {
  return {
    invoke: mock.fn(async function* (_prompt) {
      yield { type: 'session_init', catId, sessionId: `${catId}-session`, timestamp: Date.now() };
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    }),
  };
}

function createMockRegistry() {
  let counter = 0;
  return {
    create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
  };
}

function createMockMessageStore() {
  const stored = [];
  return {
    _stored: stored,
    append: async (msg) => {
      stored.push(msg);
      return { id: `msg-${stored.length}`, ...msg };
    },
    getById: () => null,
    getRecent: () => [],
    getMentionsFor: () => [],
    getBefore: () => [],
    getByThread: () => [],
    getByThreadAfter: () => [],
    getByThreadBefore: () => [],
  };
}

describe('A2A Chain Integration (AgentRouter end-to-end)', () => {
  test('complete A2A chain: opus → @缅因猫 → codex invoked with previous context', async () => {
    const { AgentRouter } = await import('../../dist/domains/cats/services/agents/routing/AgentRouter.js');

    // opus responds with line-start @缅因猫 mention
    const mockOpus = createMockService('opus', '代码写好了\n@缅因猫 请 review 这段代码');
    const mockCodex = createMockService('codex', 'LGTM，代码没问题');
    const mockGemini = createMockService('gemini', 'unused');
    const messageStore = createMockMessageStore();

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockOpus,
        codexService: mockCodex,
        geminiService: mockGemini,
        registry: createMockRegistry(),
        messageStore,
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@opus 写个 hello world')) {
      messages.push(msg);
    }

    // Both opus and codex should be invoked
    assert.equal(mockOpus.invoke.mock.callCount(), 1, 'opus should be called once');
    assert.equal(mockCodex.invoke.mock.callCount(), 1, 'codex should be called via A2A');
    assert.equal(mockGemini.invoke.mock.callCount(), 0, 'gemini should not be called');

    // Prompt should include direct-message reply target hint for the A2A-invoked cat.
    const codexPrompt = mockCodex.invoke.mock.calls[0]?.arguments?.[0];
    assert.equal(typeof codexPrompt, 'string', 'codex invocation should receive a prompt string');
    assert.ok(
      codexPrompt.includes('Direct message from 布偶猫(opus)'),
      'codex prompt should instruct replying to 布偶猫(opus) (not the user)',
    );

    // Should have a2a_handoff event
    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 1, 'should yield exactly one a2a_handoff');
    assert.ok(handoffs[0].content.includes('→'), 'handoff shows arrow transition');

    // Messages from both cats present
    const opusText = messages.filter((m) => m.type === 'text' && m.catId === 'opus');
    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.ok(opusText.length > 0, 'should have opus text');
    assert.ok(codexText.length > 0, 'should have codex text');

    // isFinal should be true only on the last done (codex)
    const dones = messages.filter((m) => m.type === 'done');
    const opusDone = dones.find((m) => m.catId === 'opus');
    const codexDone = dones.find((m) => m.catId === 'codex');
    assert.ok(!opusDone.isFinal, 'opus done should NOT be isFinal');
    assert.ok(codexDone.isFinal, 'codex done (chain end) SHOULD be isFinal');

    // messageStore should have opus mentions = ['codex']
    const opusStored = messageStore._stored.find((m) => m.catId === 'opus');
    assert.ok(opusStored, 'opus message should be stored');
    assert.deepEqual(opusStored.mentions, ['codex'], 'opus should have codex mention stored');
  });

  test('A2A depth limit prevents excessive chaining', async () => {
    const { AgentRouter } = await import('../../dist/domains/cats/services/agents/routing/AgentRouter.js');

    // Chain: opus → @codex → @gemini → (blocked by depth=2)
    let _opusCalls = 0;
    const mockOpus = {
      invoke: mock.fn(async function* () {
        _opusCalls++;
        yield { type: 'session_init', catId: 'opus', sessionId: 'opus-s', timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: '开始\n@缅因猫 帮忙review', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };
    const mockCodex = createMockService('codex', '需要设计配合\n@暹罗猫 帮忙设计 UI');
    const mockGemini = createMockService('gemini', '还需要调整\n@布偶猫 请修复');
    const messageStore = createMockMessageStore();

    // Set MAX_A2A_DEPTH=2 via env (will be read by route-strategies)
    const prevDepth = process.env.MAX_A2A_DEPTH;
    process.env.MAX_A2A_DEPTH = '2';

    try {
      const router = new AgentRouter(
        await migrateRouterOpts({
          claudeService: mockOpus,
          codexService: mockCodex,
          geminiService: mockGemini,
          registry: createMockRegistry(),
          messageStore,
        }),
      );

      const messages = [];
      for await (const msg of router.route('user-1', '@opus implement feature')) {
        messages.push(msg);
      }

      // opus→codex (hop 1), codex→gemini (hop 2), gemini→opus (blocked — depth 2 exhausted)
      assert.equal(mockOpus.invoke.mock.callCount(), 1, 'opus called once (no return hop)');
      assert.equal(mockCodex.invoke.mock.callCount(), 1, 'codex called once');
      assert.equal(mockGemini.invoke.mock.callCount(), 1, 'gemini called once');

      // Exactly 2 handoffs
      const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
      assert.equal(handoffs.length, 2, 'should have exactly 2 A2A hops');
    } finally {
      if (prevDepth !== undefined) {
        process.env.MAX_A2A_DEPTH = prevDepth;
      } else {
        delete process.env.MAX_A2A_DEPTH;
      }
    }
  });

  test('P1: original pending target keeps replying to user (no direct-message override)', async () => {
    const { AgentRouter } = await import('../../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockOpus = createMockService('opus', '我先看一下\n@缅因猫 你也看看');
    const mockCodex = createMockService('codex', '我来补充结论');
    const mockGemini = createMockService('gemini', 'unused');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockOpus,
        codexService: mockCodex,
        geminiService: mockGemini,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@opus @codex 一起看这个问题')) {
      messages.push(msg);
    }

    assert.equal(mockOpus.invoke.mock.callCount(), 1, 'opus should be called once');
    assert.equal(mockCodex.invoke.mock.callCount(), 1, 'codex should be called once as original target');
    assert.equal(mockGemini.invoke.mock.callCount(), 0, 'gemini should not be called');

    const codexPrompt = mockCodex.invoke.mock.calls[0]?.arguments?.[0];
    assert.equal(typeof codexPrompt, 'string', 'codex invocation should receive a prompt string');
    assert.ok(
      !codexPrompt.includes('Direct message from 布偶猫(opus)'),
      'original target must not be forced to reply to another cat',
    );

    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 0, 'no new A2A handoff should be emitted for already-pending original target');
  });

  test('self-mention and non-line-start mention do not trigger A2A', async () => {
    const { AgentRouter } = await import('../../dist/domains/cats/services/agents/routing/AgentRouter.js');

    // opus mentions itself and mentions codex mid-line (not at line start)
    const mockOpus = createMockService('opus', '我是布偶猫 @布偶猫\n之前缅因猫说的 @缅因猫 方案不错');
    const mockCodex = createMockService('codex', 'should not be called');
    const mockGemini = createMockService('gemini', 'should not be called');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockOpus,
        codexService: mockCodex,
        geminiService: mockGemini,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@opus 分析一下')) {
      messages.push(msg);
    }

    // Only opus should be called
    assert.equal(mockOpus.invoke.mock.callCount(), 1, 'opus called');
    assert.equal(mockCodex.invoke.mock.callCount(), 0, 'codex NOT called');
    assert.equal(mockGemini.invoke.mock.callCount(), 0, 'gemini NOT called');

    // No handoffs
    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 0, 'no A2A handoffs');
  });
});

// --- F122 AC-A5/A6: queue behavior regression coverage ---
// These tests verify that queue gating behaves correctly during A2A activity.
// Primary coverage lives in dedicated test files; this section cross-references
// them as explicit regression anchors for F122.

describe('F122 regression: queue behavior during active invocations (AC-A5, AC-A6)', () => {
  test('AC-A5: user message during A2A must be queued (cross-ref: queue-gate-thread-level)', async () => {
    // Core test: queue-gate-thread-level.test.js → "cat B active → message to cat A queued"
    // This test verifies the same invariant via WorklistRegistry: when a worklist
    // is active (A2A chain running), the thread-level tracker check returns true,
    // so messages go through the queue path.
    const { registerWorklist, unregisterWorklist, hasWorklist } = await import(
      '../../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'f122-regression-a5';
    const entry = registerWorklist(threadId, ['opus', 'codex'], 10);
    try {
      // While worklist is active, hasWorklist should be true
      assert.equal(hasWorklist(threadId), true, 'worklist active during A2A chain');
      // This is the signal that messages.ts uses to decide queue vs immediate
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('AC-A6: pushToWorklist structured reason enables safe fallback (cross-ref: worklist-registry)', async () => {
    // Core test: worklist-registry.test.js → F122 PushResult structured reason tests
    // This test verifies that pushToWorklist returns actionable reasons that allow
    // enqueueA2ATargets (callback-a2a-trigger.ts) to make correct fallback decisions.
    const { pushToWorklist } = await import('../../dist/domains/cats/services/agents/routing/WorklistRegistry.js');

    const result = pushToWorklist('nonexistent-f122', ['opus']);
    assert.deepEqual(result.added, [], 'no targets added when worklist missing');
    assert.equal(result.reason, 'not_found', 'reason tells caller to fall back');
  });
});
