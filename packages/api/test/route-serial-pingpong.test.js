/**
 * F167 L1: route-serial 消费 warnPingPong / blockPingPong
 *
 * streak=2+ → 下一只猫 prompt 注入"🏓 乒乓球"警告（pingPongWarning）。
 * streak=4 → route-serial 不 enqueue 下一棒 + emit a2a_pingpong_terminated system_info。
 *
 * 场景：opus ↔ codex 互相 @ 的 ping-pong 链。
 * - round 0: opus 跑（original）→ 出 @codex → enqueue codex (streak=1)
 * - round 1: codex 跑 → 出 @opus → enqueue opus (streak=2, warn)
 * - round 2: opus 跑（prompt 含 warn）→ 出 @codex → enqueue codex (streak=3, warn)
 * - round 3: codex 跑（prompt 含 warn）→ 出 @opus → streak=4 BLOCK, emit terminated, 不 enqueue
 * 共 4 次 invoke，opus 2 次、codex 2 次。
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const REPO_TEMPLATE_PATH = fileURLToPath(new URL('../../../cat-template.json', import.meta.url));

function createCapturingService(catId, text) {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

/**
 * F167 Phase D: service that emits a substantive tool_use before its text.
 * Used to verify the breaker exempts real work (read/edit/write/task) from streak++.
 */
function createSubstantiveToolService(catId, text, toolName = 'Edit') {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      yield {
        type: 'tool_use',
        catId,
        toolName,
        toolInput: {},
        id: `tool-${Date.now()}-${Math.random()}`,
        timestamp: Date.now(),
      };
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async () => ({
        id: `msg-${counter}`,
        userId: '',
        catId: null,
        content: '',
        mentions: [],
        timestamp: 0,
      }),
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig(REPO_TEMPLATE_PATH));
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

describe('F167 L1: route-serial ping-pong circuit breaker', { concurrency: false }, () => {
  test('streak=4 (opus↔codex × 4 rounds) → block enqueue + emit a2a_pingpong_terminated', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const opusService = createCapturingService('opus', '看了\n@codex review 一下');
      const codexService = createCapturingService('codex', '看了\n@opus 确认一下');
      const deps = createMockDeps({ opus: opusService, codex: codexService });

      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'ping-pong test', 'user1', 'thread-pp-block', {
        thinkingMode: 'play',
      })) {
        events.push(msg);
      }

      assert.strictEqual(opusService.calls.length, 2, 'opus should invoke 2 times (rounds 0, 2) before block');
      assert.strictEqual(codexService.calls.length, 2, 'codex should invoke 2 times (rounds 1, 3) before block');

      const terminated = events.find(
        (e) =>
          e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_pingpong_terminated'),
      );
      assert.ok(terminated, 'must emit a2a_pingpong_terminated system_info on streak=4');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('streak >= 2 → next cat prompt contains ping-pong warning', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const opusService = createCapturingService('opus', '看了\n@codex 确认一下');
      const codexService = createCapturingService('codex', '看了\n@opus 确认一下');
      const deps = createMockDeps({ opus: opusService, codex: codexService });

      for await (const _ of routeSerial(deps, ['opus'], 'warn test', 'user1', 'thread-pp-warn', {
        thinkingMode: 'play',
      })) {
      }

      // opus 第 2 次被 invoke 时（round 2），streakPair.count=2，prompt 应含警告
      assert.ok(opusService.calls.length >= 2, 'opus must be invoked at least twice');
      const secondOpusPrompt = JSON.stringify(opusService.calls[1]);
      assert.match(
        secondOpusPrompt,
        /乒乓球|连续.*轮|ping[- ]?pong/,
        'second opus prompt (after streak=2) must contain ping-pong warning text',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-D1: 4 rounds with substantive tool (Edit) every round → NO termination', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      // Each cat calls a substantive tool (Edit) before emitting its @mention.
      // Expected: breaker exempts every round → opus/codex each invoke 2+ times, no pingpong_terminated.
      const opusService = createSubstantiveToolService('opus', '修完\n@codex review 一下', 'Edit');
      const codexService = createSubstantiveToolService('codex', '补测试\n@opus 看看', 'Write');
      const deps = createMockDeps({ opus: opusService, codex: codexService });

      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'substantive review test', 'user1', 'thread-pp-substantive', {
        thinkingMode: 'play',
      })) {
        events.push(msg);
      }

      const terminated = events.find(
        (e) =>
          e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_pingpong_terminated'),
      );
      assert.ok(!terminated, 'substantive tool_use every round must exempt streak — no a2a_pingpong_terminated');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-D1: 4 rounds with long text (>200 chars) every round → NO termination', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      // Output text must be > 200 chars (UTF-16 code units) to trigger the long-text exemption.
      const longTextOpus = `${'架构讨论'.repeat(60)}\n@codex 这段你怎么看？`; // ~240+ code units
      const longTextCodex = `${'架构回应'.repeat(60)}\n@opus 我的观点如上`;
      const opusService = createCapturingService('opus', longTextOpus);
      const codexService = createCapturingService('codex', longTextCodex);
      const deps = createMockDeps({ opus: opusService, codex: codexService });

      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'long-text discussion test', 'user1', 'thread-pp-longtext', {
        thinkingMode: 'play',
      })) {
        events.push(msg);
      }

      const terminated = events.find(
        (e) =>
          e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_pingpong_terminated'),
      );
      assert.ok(
        !terminated,
        'long-text discussion (>200 chars) every round must exempt streak — no a2a_pingpong_terminated',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-E AC-E8: F172 愿景守护 replay — @gemini with "合入" in prior narrative must route normally (L3 retired)', async () => {
    // Exact reproduction of the bug:
    //   opus reports "PR #1355 已合入 main" + asks @gemini 做愿景守护.
    // Before Phase E: L3 regex matched "合入" anywhere in storedContent, a2a_role_rejected
    // emitted, gemini NEVER invoked.
    // After Phase E: no harness gate — gemini gets enqueued and invoked normally.
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const opusText = `PR #1355 已合入 main\n\nReview 历程：砚砚 review 2 轮放行 + 云端 review 3 轮（2 P1 + 2 P2 全修）\n\n请做愿景守护：对照 spec docs/features/F172-generated-image-publication.md 的 8 条需求点 (R1-R8)，判断交付物是否解决了co-creator的问题。\n\n@gemini`;
      const opusService = createCapturingService('opus', opusText);
      const geminiService = createCapturingService('gemini', '愿景守护完成，方向对上了');
      const deps = createMockDeps({ opus: opusService, gemini: geminiService });

      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'F172 愿景守护 replay', 'user1', 'thread-f172-replay', {
        thinkingMode: 'play',
      })) {
        events.push(msg);
      }

      // Gemini MUST have been invoked (L3 no longer pre-rejects based on "合入" text).
      assert.strictEqual(
        geminiService.calls.length,
        1,
        'gemini must be invoked for 愿景守护 despite "合入" in narrative',
      );
      // No a2a_role_rejected event should appear.
      const rejected = events.find(
        (e) => e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_role_rejected'),
      );
      assert.ok(!rejected, 'L3 retired — a2a_role_rejected must NOT be emitted anymore');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('streak=4 in deferred path (F185-B AC-B3a) → block deferred enqueue + emit a2a_pingpong_terminated', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const opusService = createCapturingService('opus', '看了\n@codex review 一下');
      const codexService = createCapturingService('codex', '看了\n@opus 确认一下');
      const deps = createMockDeps({ opus: opusService, codex: codexService });

      let callCount = 0;
      const deferredEntries = [];
      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'ping-pong deferred test', 'user1', 'thread-pp-defer', {
        thinkingMode: 'play',
        queueHasQueuedMessages: () => {
          callCount++;
          return callCount >= 4;
        },
        deferA2AEnqueue: (entry) => deferredEntries.push(entry),
      })) {
        events.push(msg);
      }

      assert.strictEqual(opusService.calls.length, 2, 'opus should invoke 2 times (rounds 0, 2)');
      assert.strictEqual(codexService.calls.length, 2, 'codex should invoke 2 times (rounds 1, 3)');

      assert.strictEqual(deferredEntries.length, 0, 'deferred enqueue must NOT be called when streak blocks');

      const terminated = events.find(
        (e) =>
          e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_pingpong_terminated'),
      );
      assert.ok(terminated, 'deferred path must emit a2a_pingpong_terminated on streak=4');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('no ping-pong (single handoff) → no warning, no termination', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const opusService = createCapturingService('opus', '看过了\n@codex 帮忙 review');
      const codexService = createCapturingService('codex', '看过了，没问题');
      const deps = createMockDeps({ opus: opusService, codex: codexService });

      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'single handoff', 'user1', 'thread-pp-single', {
        thinkingMode: 'play',
      })) {
        events.push(msg);
      }

      assert.strictEqual(opusService.calls.length, 1, 'opus invoked once (no ping back)');
      assert.strictEqual(codexService.calls.length, 1, 'codex invoked once');
      const terminated = events.find(
        (e) =>
          e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_pingpong_terminated'),
      );
      assert.ok(!terminated, 'single handoff must not emit a2a_pingpong_terminated');
      const firstCodexPrompt = JSON.stringify(codexService.calls[0]);
      assert.doesNotMatch(
        firstCodexPrompt,
        /乒乓球|连续.*轮/,
        'codex first prompt (streak=1) must NOT contain warning',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  // F216 P1-2 (砚砚 review): a multi-mention in ONE response must apply streak per-target IN ORDER.
  // Repro: build opus<->codex streak hot, then codex emits "@gemini @opus" (multi-mention).
  //   Correct (resolve+apply one cat at a time): processing @gemini first RESETS the pair → @opus is
  //     then evaluated against a fresh pair → enqueued, opus runs again, no termination.
  //   Stale-batch bug (resolve ALL decisions before any mutation): both peeks read the hot
  //     opus<->codex streak, so @opus is predicted to hit the block threshold and gets WRONGLY blocked.
  test('F216 P1-2: multi-mention applies streak per-target — gemini resets pair, @opus not stale-blocked', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      // Round-aware service: empty text after the scripted rounds → chain terminates deterministically.
      const roundAware = (catId, textsByCall) => {
        const calls = [];
        return {
          calls,
          async *invoke(prompt) {
            const i = calls.length;
            calls.push(prompt);
            const content = i < textsByCall.length ? textsByCall[i] : '';
            yield { type: 'text', catId, content, timestamp: Date.now() };
            yield { type: 'done', catId, timestamp: Date.now() };
          },
        };
      };
      // opus<->codex pings: R0 opus@codex(streak1), R1 codex@opus(2), R2 opus@codex(3),
      // R3 codex emits "@gemini @opus": gemini resets pair, @opus must enqueue (fresh pair=1).
      const opusService = roundAware('opus', ['看了\n@codex review 一下', '看了\n@codex review 一下']);
      const codexService = roundAware('codex', ['看了\n@opus 确认一下', '看了\n@gemini @opus 你们看看']);
      const geminiService = roundAware('gemini', ['看过了，没问题']);
      const deps = createMockDeps({ opus: opusService, codex: codexService, gemini: geminiService });

      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'multi-mention streak test', 'user1', 'thread-pp-multi', {
        thinkingMode: 'play',
      })) {
        events.push(msg);
      }

      const terminated = events.find(
        (e) =>
          e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_pingpong_terminated'),
      );
      assert.ok(!terminated, 'round-3 @opus must NOT be stale-blocked — gemini should reset the pair first');
      assert.ok(geminiService.calls.length >= 1, 'gemini must be invoked (enqueued from the multi-mention)');
      assert.strictEqual(opusService.calls.length, 3, 'opus must invoke 3x (rounds 0,2, + round-3 re-enqueue)');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  // F216 c2 (behavior-preservation lock for the deferred-path refactor): the deferred block was rewired
  // from a hand-written `for (nextCat of a2aMentions) { updateStreakOnPush per-iteration }` loop to the
  // unified resolveRoutingDecisions decision layer (consistent with inline c1.3). Both the old loop and
  // the new decision-driven loop apply streak PER-TARGET (mutate before evaluating the next cat), so this
  // test passes on BOTH — it is a preservation guard, NOT a red→green regression (main's deferred was
  // never the batch form that caused 砚砚's inline P1-2). It locks the per-target property so a future
  // refactor that accidentally batches the deferred peeks (freezing every peekStreak against the pre-loop
  // streakPair) would break here: rounds 0-2 build a hot opus<->codex streak inline, then round 3
  // (codex emits "@gemini @opus", deferred) must let gemini reset the pair first so @opus is not blocked.
  // Captured via deferA2AEnqueue (deferred path enqueues there, not into the worklist).
  test('F216 c2: deferred path preserves per-target streak — gemini resets pair, @opus not stale-blocked', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const roundAware = (catId, textsByCall) => {
        const calls = [];
        return {
          calls,
          async *invoke(prompt) {
            const i = calls.length;
            calls.push(prompt);
            const content = i < textsByCall.length ? textsByCall[i] : '';
            yield { type: 'text', catId, content, timestamp: Date.now() };
            yield { type: 'done', catId, timestamp: Date.now() };
          },
        };
      };
      const opusService = roundAware('opus', ['看了\n@codex review 一下', '看了\n@codex review 一下']);
      const codexService = roundAware('codex', ['看了\n@opus 确认一下', '看了\n@gemini @opus 你们看看']);
      const geminiService = roundAware('gemini', ['看过了，没问题']);
      const deps = createMockDeps({ opus: opusService, codex: codexService, gemini: geminiService });

      // Rounds 0-2 run INLINE (queue not pending) to build the opus<->codex streak to 3.
      // Round 3 (codex emits "@gemini @opus") runs DEFERRED (queue pending) — the path under test.
      let callCount = 0;
      const deferredEntries = [];
      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'deferred streak test', 'user1', 'thread-pp-defer-multi', {
        thinkingMode: 'play',
        queueHasQueuedMessages: () => {
          callCount++;
          return callCount >= 4; // rounds 0,1,2 inline (build streak); round 3 deferred (multi-mention)
        },
        deferA2AEnqueue: (entry) => deferredEntries.push(entry),
      })) {
        events.push(msg);
      }

      // Buggy batch-resolve: @opus in round 3 frozen against opus<->codex=3 → block_pingpong, terminated.
      // Fixed per-cat: gemini deferred first (resets pair), @opus deferred against fresh pair → no block.
      const terminated = events.find(
        (e) =>
          e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_pingpong_terminated'),
      );
      assert.ok(!terminated, 'deferred round-3 @opus must NOT be stale-blocked — gemini resets the pair first');
      const deferredCats = deferredEntries.flatMap((e) => e.targetCats);
      assert.ok(deferredCats.includes('gemini'), 'gemini must be deferred-enqueued from the multi-mention');
      assert.ok(deferredCats.includes('opus'), 'opus must be deferred-enqueued (not stale-blocked) in round 3');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
});
