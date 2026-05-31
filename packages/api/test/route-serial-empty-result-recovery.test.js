import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// 复现 Thread 2 (docs/bug-report/2026-05-29-invocation-stale-active-recovery)：
// A2A serial 链中一棒 cat 返回 "CLI success 但无有效产出 / 无 done 终止消息"
// （opus-4.8 长 context empty-result，stop_reason:null + result:""），
// 验证 thread 是否仍被永久标记 busy（用户消息发不出去 = hasActiveExecution 卡 true）。
//
// 红/绿区分根因：
//   - 红（tracker.has=true）→ A2A slot 残留是卡死根因（修 routeSerial 收尾）
//   - 绿（tracker.has=false）→ slot 已释放，卡死在别处（processingSlots/record/session）
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

describe('routeSerial empty-result slot recovery (Thread 2 regression)', () => {
  it('does not leave the thread busy when an A2A target returns empty-result without a terminal done', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

    const threadId = 'thread-empty-result-recovery';
    const userId = 'user-a';
    const tracker = new InvocationTracker();
    const controller = tracker.startAll(threadId, ['opus'], userId);

    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield { type: 'text', catId: 'opus', content: '@codex\n你接着说', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
      // A2A target：模拟 opus-4.8 empty-result — 有开场 text，但 CLI 截断、无 done 终止消息
      codex: {
        async *invoke() {
          yield { type: 'text', catId: 'codex', content: '我先翻翻记忆库……', timestamp: Date.now() };
          // 关键复现点：不 yield done（empty-result / 截断 / stop_reason:null + result:""）
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
        for (const c of catIds) tracker.completeSlot(tid, c, ctrl);
      },
    })) {
      if (msg.type === 'done' && msg.catId) tracker.completeSlot(threadId, msg.catId, controller);
    }

    // 期望：链结束后 thread 不再 busy（用户可继续发消息，不被永久排队）
    assert.equal(
      tracker.has(threadId),
      false,
      'thread must not stay busy after an A2A target returns empty-result without a terminal done',
    );
  });
});
