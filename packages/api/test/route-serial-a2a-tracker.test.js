import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
        get: async () => undefined,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => ({
        id: `msg-${++counter}`,
        userId: msg.userId ?? '',
        catId: msg.catId ?? null,
        content: msg.content ?? '',
        mentions: [],
        timestamp: msg.timestamp ?? Date.now(),
      }),
      getById: async () => null,
      getRecent: async () => [],
      getMentionsFor: async () => [],
      getBefore: async () => [],
      getByThread: async () => [],
      getByThreadAfter: async () => [],
      getByThreadBefore: async () => [],
    },
  };
}

describe('routeSerial A2A tracker bridge', () => {
  it('keeps thread-level invocation tracking active after first cat hands off to A2A target', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

    const threadId = 'thread-a2a-tracker';
    const userId = 'user-a';
    const tracker = new InvocationTracker();
    const controller = tracker.startAll(threadId, ['opus'], userId);
    let sawOpusDone = false;

    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield { type: 'text', catId: 'opus', content: '@codex\n请接手继续', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
      codex: {
        async *invoke() {
          yield { type: 'text', catId: 'codex', content: '我接到了', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        },
      },
    });

    for await (const msg of routeSerial(deps, ['opus'], 'start', userId, threadId, {
      signal: controller.signal,
      invocationController: controller,
      trackA2ASlot: (tid, catId, uid, ctrl) => {
        tracker.trackExternalSlot(tid, catId, ctrl, uid, [catId]);
      },
      completeA2ASlots: (tid, catIds, ctrl) => {
        for (const catId of catIds) tracker.completeSlot(tid, catId, ctrl);
      },
    })) {
      if (msg.type === 'done' && msg.catId) {
        tracker.completeSlot(threadId, msg.catId, controller);
        if (msg.catId === 'opus') {
          sawOpusDone = true;
          assert.equal(
            tracker.has(threadId),
            true,
            'A2A child slot must keep the thread busy after the parent cat completes',
          );
          assert.equal(tracker.has(threadId, 'codex'), true, 'A2A target slot must be tracked before it executes');
        }
      }
    }

    assert.equal(sawOpusDone, true, 'test must exercise the handoff point');
    assert.equal(tracker.has(threadId), false, 'all slots must be cleaned up after the chain finishes');
  });

  it('re-registers an A2A target when the same cat is enqueued again after completion', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

    const threadId = 'thread-a2a-repeated-target';
    const userId = 'user-a';
    const tracker = new InvocationTracker();
    const controller = tracker.startAll(threadId, ['opus'], userId);
    let opusDoneCount = 0;
    let codexTrackCount = 0;

    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield { type: 'text', catId: 'opus', content: '@codex\n请继续', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
      codex: {
        async *invoke() {
          yield { type: 'text', catId: 'codex', content: '@opus\n请复核', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        },
      },
    });

    for await (const msg of routeSerial(deps, ['opus'], 'start', userId, threadId, {
      signal: controller.signal,
      invocationController: controller,
      maxA2ADepth: 3,
      trackA2ASlot: (tid, catId, uid, ctrl) => {
        if (catId === 'codex') codexTrackCount++;
        tracker.trackExternalSlot(tid, catId, ctrl, uid, [catId]);
      },
      completeA2ASlots: (tid, catIds, ctrl) => {
        for (const catId of catIds) tracker.completeSlot(tid, catId, ctrl);
      },
    })) {
      if (msg.type === 'done' && msg.catId) {
        tracker.completeSlot(threadId, msg.catId, controller);
        if (msg.catId === 'opus') {
          opusDoneCount++;
          assert.equal(tracker.has(threadId), true, `thread must stay busy after opus completion #${opusDoneCount}`);
          assert.equal(tracker.has(threadId, 'codex'), true, 'next codex slot must be tracked before it runs');
        }
      }
    }

    assert.equal(opusDoneCount, 2, 'test must exercise a repeated opus→codex handoff');
    assert.equal(codexTrackCount, 2, 'codex must be re-tracked for its second worklist entry');
    assert.equal(tracker.has(threadId), false, 'all repeated A2A slots must be cleaned up after the chain finishes');
  });

  it('tracks callback-pushed A2A targets when the parent turn emits no text', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { pushToWorklist } = await import('../dist/domains/cats/services/agents/routing/WorklistRegistry.js');
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

    const threadId = 'thread-a2a-callback-no-text';
    const userId = 'user-a';
    const tracker = new InvocationTracker();
    const controller = tracker.startAll(threadId, ['opus'], userId);
    let sawOpusDone = false;

    const deps = createMockDeps({
      opus: {
        async *invoke() {
          const result = pushToWorklist(threadId, ['codex'], 'opus');
          assert.deepEqual(result.added, ['codex'], 'callback A2A push must add codex to the active worklist');
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolName: 'cat_cafe_post_message',
            toolInput: { targetCats: ['codex'] },
            timestamp: Date.now(),
          };
          yield { type: 'tool_result', catId: 'opus', content: 'queued codex', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
      codex: {
        async *invoke() {
          yield { type: 'text', catId: 'codex', content: 'callback handoff received', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        },
      },
    });

    for await (const msg of routeSerial(deps, ['opus'], 'start', userId, threadId, {
      signal: controller.signal,
      invocationController: controller,
      trackA2ASlot: (tid, catId, uid, ctrl) => {
        tracker.trackExternalSlot(tid, catId, ctrl, uid, [catId]);
      },
      completeA2ASlots: (tid, catIds, ctrl) => {
        for (const catId of catIds) tracker.completeSlot(tid, catId, ctrl);
      },
    })) {
      if (msg.type === 'done' && msg.catId) {
        tracker.completeSlot(threadId, msg.catId, controller);
        if (msg.catId === 'opus') {
          sawOpusDone = true;
          assert.equal(
            tracker.has(threadId),
            true,
            'callback A2A child slot must keep the thread busy after a no-text parent completes',
          );
          assert.equal(tracker.has(threadId, 'codex'), true, 'callback A2A target slot must be tracked before it runs');
        }
      }
    }

    assert.equal(sawOpusDone, true, 'test must exercise the callback-only handoff point');
    assert.equal(tracker.has(threadId), false, 'callback A2A slot must be cleaned up after the chain finishes');
  });

  it('trackExternalSlot purges a canceled tombstone instead of preserving its aborted controller', async () => {
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

    const threadId = 'thread-tombstone-retrack';
    const userId = 'user-a';
    const tracker = new InvocationTracker();

    // Prior turn: codex started then cancelled → 'canceled' tombstone. getController() intentionally
    // still returns the now-ABORTED controller (pre-invoke cancel semantics, InvocationTracker.ts:290).
    tracker.startAll(threadId, ['codex'], userId);
    tracker.cancel(threadId, 'codex', userId, 'user_cancel');
    assert.equal(
      tracker.getController(threadId, 'codex')?.signal.aborted,
      true,
      'precondition: a canceled tombstone exposes an aborted controller',
    );

    // A2A handoff re-tracks the target via trackExternalSlot — the exact bridge route-serial uses
    // (trackA2ASlot → trackExternalSlot). The passed controller is the new turn's batch gate.
    const batchGate = new AbortController();
    tracker.trackExternalSlot(threadId, 'codex', batchGate, userId, ['codex']);

    // BUG: trackExternalSlot returns idempotently on the un-expired tombstone, so getController keeps
    // handing route-serial the aborted signal → the worklist loop skips codex at the top (route-serial
    // line 429). After the fix, re-track must replace the tombstone with a fresh active slot.
    assert.equal(
      tracker.getController(threadId, 'codex')?.signal.aborted,
      false,
      'A2A re-track must replace the canceled tombstone with a fresh active slot (controller not aborted)',
    );
  });

  it('ball.handed 记 original routed target + A2A target（云端 P1-1：不只 A2A handoff）', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const recorded = [];
    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield { type: 'text', catId: 'opus', content: '@codex\n请接手', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
      codex: {
        async *invoke() {
          yield { type: 'text', catId: 'codex', content: '我接到了', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        },
      },
    });
    // ball-custody ingest spy
    deps.ballCustody = {
      record: async (event) => {
        recorded.push(event);
      },
    };

    // currentUserMessageId 提供 original target 的 messageId 来源（用户消息 id）。
    for await (const _ of routeSerial(deps, ['opus'], 'start', 'user-a', 'thread-handed-p1', {
      currentUserMessageId: 'user-msg-1',
    })) {
      // drain
    }

    const handedTo = recorded.filter((e) => e.kind === 'ball.handed').map((e) => e.payload.toCatId);
    // 修复前：emit 只在 A2A handoff loop（`if (wi < targetCats.length) continue` skip original）→ original
    // opus 漏记 ball.handed。修复后：worklist 主循环接球时刻统一 emit → opus（original user→cat）+
    // codex（A2A cat→cat）都记。
    assert.ok(handedTo.includes('opus'), 'original routed target opus 必须记 ball.handed（P1-1 根因）');
    assert.ok(handedTo.includes('codex'), 'A2A target codex 也记 ball.handed');
  });
});
