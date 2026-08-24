/**
 * F086/F216 (#1291 field incident): multi-target A2A dispatch intent must be EXPLICIT and HONEST.
 *
 * Field evidence: a cat wrote two line-start @mentions in one reply and stated "并行，不串行" in
 * prose. route-serial pushed both onto ONE ordered worklist and only the first target ever got an
 * invocation — but the projection layer emitted two identical "A → B" pills at the same
 * millisecond, so the reader saw a fan-out that never happened (silent semantic downgrade).
 *
 * Contract locked here:
 *  1. Scheduling mode is carried STRUCTURALLY on every handoff — never inferred from how many
 *     targets appeared or in what order.
 *  2. Inline line-start @mentions are serial BY CONTRACT, and the runtime SAYS SO (requirement 4:
 *     legacy multi-@ may not keep silently impersonating parallel). No NLP over the message body.
 *  3. The user-visible projection distinguishes "serial 第 N/M 棒" from "parallel fan-out".
 *  4. Serial execution really is strictly ordered: target 2 starts only after target 1 terminates.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const REPO_TEMPLATE_PATH = fileURLToPath(new URL('../../../cat-template.json', import.meta.url));

/** Records interleaving so "started before the sibling terminated" is observable, not assumed. */
function createTimelineService(catId, text, timeline) {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      timeline.push(`start:${catId}`);
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      timeline.push(`end:${catId}`);
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

function withClaimedA2ASlot(options = {}) {
  return {
    invocationController: new AbortController(),
    trackA2ASlot: () => true,
    completeA2ASlots: () => {},
    ...options,
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

async function runTwoTargetTurn(threadId) {
  const timeline = [];
  const opusService = createTimelineService('opus', 'ok\n\n@codex\n车道1\n\n@gemini\n车道2', timeline);
  const codexService = createTimelineService('codex', '接了车道1', timeline);
  const geminiService = createTimelineService('gemini', '接了车道2', timeline);
  const deps = createMockDeps({ opus: opusService, codex: codexService, gemini: geminiService });

  const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
  const events = [];
  for await (const msg of routeSerial(
    deps,
    ['opus'],
    'two-target dispatch',
    'user1',
    threadId,
    withClaimedA2ASlot({ thinkingMode: 'play' }),
  )) {
    events.push(msg);
  }
  return { events, timeline, opusService, codexService, geminiService };
}

describe('F086/F216: multi-target A2A scheduling intent is explicit and honest', { concurrency: false }, () => {
  test('two line-start @mentions → structured SERIAL projection on every handoff', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { events } = await runTwoTargetTurn('thread-a2a-mode-serial');
      const handoffs = events.filter((e) => e.type === 'a2a_handoff');

      assert.strictEqual(handoffs.length, 2, 'both dispatched targets must be announced');

      for (const h of handoffs) {
        assert.ok(
          h.routing,
          `handoff to ${h.targetCatId} must carry a structured routing mode — ` +
            'readers must never have to infer serial-vs-parallel from target ordering',
        );
        assert.strictEqual(h.routing.mode, 'serial', 'inline line-start @mentions are serial by contract');
        assert.strictEqual(h.routing.total, 2, 'group size must be explicit');
      }

      const [first, second] = handoffs;
      assert.strictEqual(first.routing.index, 1, 'first announced leg is 第 1 棒');
      assert.strictEqual(second.routing.index, 2, 'second announced leg is 第 2 棒');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });

  test('user-visible pill distinguishes the running leg from the queued leg', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { events } = await runTwoTargetTurn('thread-a2a-mode-pill');
      const [first, second] = events.filter((e) => e.type === 'a2a_handoff');

      assert.match(first.content, /串行 1\/2/, 'the running leg must say which leg it is');
      assert.match(second.content, /串行 2\/2/, 'the queued leg must say which leg it is');
      assert.match(second.content, /排队中/, 'the queued leg must not read as already dispatched');

      // The regression that shipped: two identical "→" arrows at the same millisecond.
      assert.notStrictEqual(
        first.content.replace(/[^→⇢⇉]/gu, ''),
        second.content.replace(/[^→⇢⇉]/gu, ''),
        'a queued serial leg must not draw the same arrow as the leg that actually started',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });

  test('legacy multi-@ is normalized to serial OUT LOUD (no silent downgrade, no NLP on body)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { events } = await runTwoTargetTurn('thread-a2a-mode-notice');
      const notice = events.find(
        (e) =>
          e.type === 'system_info' &&
          typeof e.content === 'string' &&
          e.content.includes('a2a_multi_target_serialized'),
      );
      assert.ok(notice, 'multi-target inline @ must emit an explicit serialization notice');

      const payload = JSON.parse(notice.content);
      assert.strictEqual(payload.mode, 'serial');
      assert.deepStrictEqual(payload.order, ['codex', 'gemini'], 'the notice states the real serial order');
      assert.match(payload.message, /cat_cafe_multi_mention/, 'the structured parallel escape hatch must be named');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });

  // ── 砚砚 R1 P1: a notice with no registered visible/persistent consumer is not a notice ──
  // (live readability is covered in packages/web/src/hooks/__tests__/system-info-visible.test.ts)
  test('the serialization notice survives refresh (persisted as a user-facing notice)', async () => {
    const { isUserFacingSystemInfoContent } = await import(
      '../dist/domains/cats/services/agents/routing/route-helpers.js'
    );
    const { persistUserFacingSystemInfoNotices } = await import(
      '../dist/domains/cats/services/agents/routing/persist-system-info-warnings.js'
    );
    const payload = JSON.stringify({
      type: 'a2a_multi_target_serialized',
      fromCatId: 'opus',
      mode: 'serial',
      order: ['codex', 'gemini'],
      message: '本回合有 2 个行首 @ 目标，已按 串行（serial） 调度',
    });
    assert.ok(isUserFacingSystemInfoContent(payload), 'payload must be on the user-facing whitelist');

    const appended = [];
    await persistUserFacingSystemInfoNotices({
      messageStore: {
        append: async (m) => {
          appended.push(m);
          return { id: 'm1', ...m };
        },
      },
      threadId: 't1',
      catId: 'opus',
      contents: [payload],
    });
    assert.equal(appended.length, 1, 'the notice must be written to history, not only streamed');
    assert.match(appended[0].content, /串行/);
    assert.equal(appended[0].source.meta.presentation, 'system_notice');
  });

  test('a real two-target turn persists the notice (both emit sites wired)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const appended = [];
      const timeline = [];
      const opusService = createTimelineService('opus', 'ok\n\n@codex\n车道1\n\n@gemini\n车道2', timeline);
      const deps = createMockDeps({
        opus: opusService,
        codex: createTimelineService('codex', '接了', timeline),
        gemini: createTimelineService('gemini', '接了', timeline),
      });
      let n = 0;
      deps.messageStore.append = async (m) => {
        appended.push(m);
        return { id: `msg-${n++}`, userId: '', catId: null, content: '', mentions: [], timestamp: 0, ...m };
      };

      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      for await (const _msg of routeSerial(
        deps,
        ['opus'],
        'persisted notice',
        'user1',
        'thread-a2a-notice-persist',
        withClaimedA2ASlot({ thinkingMode: 'play' }),
      )) {
        /* drain */
      }

      const persistedNotice = appended.find((m) => m.source?.connector === 'a2a-routing-mode');
      assert.ok(persistedNotice, 'the live notice must also land in durable history (F5 parity)');
      assert.match(persistedNotice.content, /cat_cafe_multi_mention/);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });

  // ── SAME-CLASS SWEEP (operator-directed), NEGATIVE RESULT + characterization guard.
  // Hypothesis: the serial handoff loop computes index/total from `worklist.length` while a later
  // leg can still be spliced out for losing its slot — i.e. the R1 "announced before admitted"
  // defect mirrored onto the path 砚砚 never probed.
  // It does NOT reproduce: `claimOrDeferA2ATarget` gates entry at worklist.push time and caches the
  // claim in `activeTrackedA2ASlots`, so the handoff-loop re-check is always a cache hit and the
  // splice branch is unreachable for A2A targets. A first version of this test "passed" both before
  // and after a speculative fix — a false green — which is what exposed the hypothesis as wrong.
  // The fix was reverted; this test stays as the guard that pins the mechanism actually relied on:
  // a target that fails slot admission never inflates the announced group size.
  test('a leg that fails slot admission never enters the announced group size', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const timeline = [];
      const deps = createMockDeps({
        opus: createTimelineService('opus', 'ok\n\n@codex\n车道1\n\n@gemini\n车道2', timeline),
        codex: createTimelineService('codex', '接了', timeline),
        gemini: createTimelineService('gemini', '接了', timeline),
      });

      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const events = [];
      for await (const msg of routeSerial(
        deps,
        ['opus'],
        'one leg loses its slot',
        'user1',
        'thread-a2a-splice',
        withClaimedA2ASlot({
          thinkingMode: 'play',
          // gemini's slot is already owned elsewhere → it is durably deferred and spliced out of
          // the worklist. The defer channel must exist, otherwise custody admission throws instead
          // of taking the branch under test.
          trackA2ASlot: (_threadId, catId) => catId !== 'gemini',
          deferA2AEnqueue: () => ({ outcome: 'enqueued', entry: { id: 'deferred-1' } }),
        }),
      )) {
        events.push(msg);
      }

      const handoffs = events.filter((e) => e.type === 'a2a_handoff');
      assert.strictEqual(handoffs.length, 1, 'precondition: only the admitted leg is announced');
      assert.strictEqual(handoffs[0].targetCatId, 'codex');
      assert.strictEqual(
        handoffs[0].routing.total,
        1,
        'a leg that never obtained a slot must not inflate the announced group size — ' +
          '"串行 1/2" with only one real leg is the same lie as #1291, one path over',
      );
      assert.strictEqual(handoffs[0].routing.index, 1);
      assert.doesNotMatch(handoffs[0].content, /1\/2/);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });

  test('declared serial really is serial: leg 2 starts only after leg 1 terminates', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { timeline, codexService, geminiService } = await runTwoTargetTurn('thread-a2a-mode-order');
      assert.strictEqual(codexService.calls.length, 1);
      assert.strictEqual(geminiService.calls.length, 1);
      assert.ok(
        timeline.indexOf('end:codex') < timeline.indexOf('start:gemini'),
        `serial contract violated — timeline was ${timeline.join(' | ')}`,
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });
});

describe('F086/F216: routing projection labels', { concurrency: false }, () => {
  test('parallel fan-out and serial worklist render as different shapes', async () => {
    const { formatA2AHandoffContent } = await import(
      '../dist/domains/cats/services/agents/routing/a2a-handoff-label.js'
    );
    const serial2 = formatA2AHandoffContent('a', 'b', undefined, undefined, {
      mode: 'serial',
      index: 2,
      total: 2,
    });
    const parallel2 = formatA2AHandoffContent('a', 'b', undefined, undefined, {
      mode: 'parallel',
      index: 2,
      total: 2,
    });
    assert.notStrictEqual(serial2, parallel2, 'serial and parallel must not render identically');
    assert.match(parallel2, /并行 2\/2/);
    assert.match(serial2, /串行 2\/2/);

    // Single-target handoffs keep the historical shape (no false precision).
    assert.strictEqual(formatA2AHandoffContent('a', 'b'), 'a → b');
    assert.strictEqual(
      formatA2AHandoffContent('a', 'b', undefined, undefined, { mode: 'serial', index: 1, total: 1 }),
      'a → b',
    );
  });

  test('isRoutingProjectionStartingNow separates announced from actually-started', async () => {
    const { isRoutingProjectionStartingNow } = await import('@cat-cafe/shared');
    assert.strictEqual(isRoutingProjectionStartingNow({ mode: 'serial', index: 1, total: 2 }), true);
    assert.strictEqual(isRoutingProjectionStartingNow({ mode: 'serial', index: 2, total: 2 }), false);
    assert.strictEqual(isRoutingProjectionStartingNow({ mode: 'parallel', index: 2, total: 2 }), true);
  });
});
