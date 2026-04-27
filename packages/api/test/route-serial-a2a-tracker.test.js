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
});
