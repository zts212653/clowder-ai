/**
 * F173 Phase A — ThreadRuntimeWriter mirror invariant
 *
 * 现状：chatStore 中所有 setThreadX 方法都有 `if (threadId === currentThreadId) 写 flat else 写 threadStates` 分叉。
 * Active thread 写入只更新 flat，**不**镜像到 threadStates → snapshotActive 之前 threadStates[currentThread]
 * 就是 stale，是 ghost bubble / liveness 漂移的结构性原因（F081 Risk #1）。
 *
 * F173 Phase A 不变量（Mirror Invariant）：
 *   对于任何 thread T，调用 setThreadX(T, payload) 后必须满足：
 *     - threadStates[T].<field> 反映 payload（无论 T 是否 active）
 *     - 若 T === currentThreadId，flat state.<field> 也反映 payload（compat mirror）
 *
 * 这是 KD-2/KD-4 的可执行表达：先收口写入，flat 由 writer 同步镜像，不在本 phase 删 flat。
 *
 * 这些测试在引入 ThreadRuntimeWriter 之前应该全部 RED，证明分叉缺口存在；GREEN 后保护回归。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDebugEvents, configureDebug } from '@/debug/invocationEventDebug';
import { DEFAULT_THREAD_STATE, useChatStore } from '../chatStore';

const ACTIVE_TID = 'thread-active';
const BG_TID = 'thread-background';

function resetStore() {
  useChatStore.setState({
    messages: [],
    isLoading: false,
    isLoadingHistory: false,
    hasMore: true,
    hasActiveInvocation: false,
    hasDraft: false,
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catInvocations: {},
    activeInvocations: {},
    currentGame: null,
    threadStates: {},
    viewMode: 'single',
    splitPaneThreadIds: [],
    splitPaneTargetId: null,
    currentThreadId: ACTIVE_TID,
    currentProjectPath: 'default',
    threads: [],
    isLoadingThreads: false,
  });
}

describe('F173 Phase A — ThreadRuntimeWriter mirror invariant', () => {
  beforeEach(() => {
    clearDebugEvents();
    configureDebug({ enabled: false });
    resetStore();
  });

  describe('setThreadCatInvocation', () => {
    it('active thread: writes flat AND mirrors to threadStates', () => {
      useChatStore.getState().setThreadCatInvocation(ACTIVE_TID, 'opus', { invocationId: 'inv-1' });

      const s = useChatStore.getState();
      // flat (existing behavior)
      expect(s.catInvocations.opus?.invocationId).toBe('inv-1');
      // mirror to threadStates (new invariant — RED until Phase A)
      expect(s.threadStates[ACTIVE_TID]?.catInvocations?.opus?.invocationId).toBe('inv-1');
    });

    it('background thread: writes threadStates and does NOT touch flat', () => {
      useChatStore.getState().setThreadCatInvocation(BG_TID, 'opus', { invocationId: 'inv-bg' });

      const s = useChatStore.getState();
      expect(s.threadStates[BG_TID]?.catInvocations?.opus?.invocationId).toBe('inv-bg');
      expect(s.catInvocations.opus).toBeUndefined();
    });

    it('active thread: a new parent without a child clears the previous child identity', () => {
      const store = useChatStore.getState();
      store.setThreadCatInvocation(ACTIVE_TID, 'opus', {
        invocationId: 'parent-old',
        turnInvocationId: 'child-old',
      });
      store.setThreadCatInvocation(ACTIVE_TID, 'opus', { invocationId: 'parent-new' });

      const s = useChatStore.getState();
      expect(s.catInvocations.opus?.invocationId).toBe('parent-new');
      expect(s.catInvocations.opus?.turnInvocationId).toBeUndefined();
      expect(s.threadStates[ACTIVE_TID]?.catInvocations?.opus?.turnInvocationId).toBeUndefined();
    });

    it('background thread: a new parent without a child clears the previous child identity', () => {
      const store = useChatStore.getState();
      store.setThreadCatInvocation(BG_TID, 'opus', {
        invocationId: 'parent-bg-old',
        turnInvocationId: 'child-bg-old',
      });
      store.setThreadCatInvocation(BG_TID, 'opus', { invocationId: 'parent-bg-new' });

      const invocation = useChatStore.getState().threadStates[BG_TID]?.catInvocations?.opus;
      expect(invocation?.invocationId).toBe('parent-bg-new');
      expect(invocation?.turnInvocationId).toBeUndefined();
    });

    it('same-parent authoritative replacement clears an explicitly absent child identity', () => {
      const store = useChatStore.getState();
      store.setThreadCatInvocation(ACTIVE_TID, 'opus', {
        invocationId: 'parent-same',
        turnInvocationId: 'child-old',
      });
      store.setThreadCatInvocation(ACTIVE_TID, 'opus', {
        invocationId: 'parent-same',
        turnInvocationId: undefined,
      });

      const state = useChatStore.getState();
      expect(state.catInvocations.opus).toMatchObject({
        invocationId: 'parent-same',
        turnInvocationId: undefined,
      });
      expect(state.threadStates[ACTIVE_TID]?.catInvocations?.opus?.turnInvocationId).toBeUndefined();
    });
  });

  describe('setCatInvocation identity boundary', () => {
    it('clears the previous child when the active parent changes without a child', () => {
      const store = useChatStore.getState();
      store.setCatInvocation('opus', {
        invocationId: 'parent-direct-old',
        turnInvocationId: 'child-direct-old',
      });
      store.setCatInvocation('opus', { invocationId: 'parent-direct-new' });

      expect(useChatStore.getState().catInvocations.opus).toMatchObject({
        invocationId: 'parent-direct-new',
        turnInvocationId: undefined,
      });
    });

    it('preserves the child for a telemetry-only patch on the same parent', () => {
      const store = useChatStore.getState();
      store.setCatInvocation('opus', {
        invocationId: 'parent-direct',
        turnInvocationId: 'child-direct',
      });
      store.setCatInvocation('opus', { durationMs: 42 });

      expect(useChatStore.getState().catInvocations.opus).toMatchObject({
        invocationId: 'parent-direct',
        turnInvocationId: 'child-direct',
        durationMs: 42,
      });
    });

    it('clears the previous app-server lifecycle when the parent rebinds without new lifecycle evidence', () => {
      const store = useChatStore.getState();
      store.setCatInvocation('opus', {
        invocationId: 'parent-old',
        turnInvocationId: 'child-old',
        appServerLifecycle: {
          stage: 'active',
          lastActivityAt: Date.now() - 60_000,
          recoveryAttempt: 0,
          turnStartSent: true,
          turnAccepted: true,
          itemObserved: true,
        },
      });
      // Mirrors the invocation_created patch shape (useAgentMessages active + background):
      // new parent identity, no lifecycle payload.
      store.setCatInvocation('opus', { invocationId: 'parent-new', turnInvocationId: undefined });

      const info = useChatStore.getState().catInvocations.opus;
      expect(info?.invocationId).toBe('parent-new');
      expect(info?.appServerLifecycle).toBeUndefined();
    });

    it('preserves the lifecycle for a telemetry-only patch on the same parent', () => {
      const store = useChatStore.getState();
      const lifecycle = {
        stage: 'active' as const,
        lastActivityAt: Date.now(),
        recoveryAttempt: 0,
        turnStartSent: true,
        turnAccepted: true,
        itemObserved: true,
      };
      store.setCatInvocation('opus', { invocationId: 'parent-same', appServerLifecycle: lifecycle });
      store.setCatInvocation('opus', { durationMs: 42 });

      expect(useChatStore.getState().catInvocations.opus?.appServerLifecycle).toMatchObject(lifecycle);
    });

    it('keeps lifecycle supplied in the same patch as the parent rebind', () => {
      const store = useChatStore.getState();
      store.setCatInvocation('opus', {
        invocationId: 'parent-old',
        appServerLifecycle: {
          stage: 'active',
          lastActivityAt: Date.now() - 60_000,
          recoveryAttempt: 0,
          turnStartSent: true,
          turnAccepted: true,
          itemObserved: true,
        },
      });
      store.setCatInvocation('opus', {
        invocationId: 'parent-new',
        appServerLifecycle: {
          stage: 'child_spawned',
          lastActivityAt: Date.now(),
          recoveryAttempt: 0,
          turnStartSent: false,
          turnAccepted: false,
          itemObserved: false,
        },
      });

      expect(useChatStore.getState().catInvocations.opus?.appServerLifecycle?.stage).toBe('child_spawned');
    });
  });

  describe('addThreadActiveInvocation', () => {
    it('active thread: writes flat activeInvocations AND mirrors to threadStates', () => {
      useChatStore.getState().addThreadActiveInvocation(ACTIVE_TID, 'inv-1', 'opus', 'execute');

      const s = useChatStore.getState();
      expect(s.activeInvocations['inv-1']?.catId).toBe('opus');
      expect(s.hasActiveInvocation).toBe(true);
      // mirror (RED)
      expect(s.threadStates[ACTIVE_TID]?.activeInvocations?.['inv-1']?.catId).toBe('opus');
      expect(s.threadStates[ACTIVE_TID]?.hasActiveInvocation).toBe(true);
    });
  });

  describe('setThreadLoading', () => {
    it('active thread: writes isLoading flat AND mirrors to threadStates', () => {
      useChatStore.getState().setThreadLoading(ACTIVE_TID, true);

      const s = useChatStore.getState();
      expect(s.isLoading).toBe(true);
      expect(s.threadStates[ACTIVE_TID]?.isLoading).toBe(true);
    });
  });

  describe('setThreadIntentMode', () => {
    it('active thread: writes intentMode flat AND mirrors to threadStates', () => {
      useChatStore.getState().setThreadIntentMode(ACTIVE_TID, 'execute');

      const s = useChatStore.getState();
      expect(s.intentMode).toBe('execute');
      expect(s.threadStates[ACTIVE_TID]?.intentMode).toBe('execute');
    });
  });

  describe('setThreadTargetCats', () => {
    it('active thread: writes targetCats flat AND mirrors to threadStates', () => {
      useChatStore.getState().setThreadTargetCats(ACTIVE_TID, ['opus', 'gpt52']);

      const s = useChatStore.getState();
      expect(s.targetCats).toContain('opus');
      expect(s.targetCats).toContain('gpt52');
      expect(s.threadStates[ACTIVE_TID]?.targetCats).toContain('opus');
      expect(s.threadStates[ACTIVE_TID]?.targetCats).toContain('gpt52');
    });
  });

  describe('addMessageToThread', () => {
    it('active thread: appends to flat messages AND mirrors to threadStates', () => {
      const msg = { id: 'm1', type: 'user' as const, content: 'hi', timestamp: Date.now() };
      useChatStore.getState().addMessageToThread(ACTIVE_TID, msg);

      const s = useChatStore.getState();
      expect(s.messages.find((m) => m.id === 'm1')).toBeDefined();
      // mirror (RED)
      expect(s.threadStates[ACTIVE_TID]?.messages.find((m) => m.id === 'm1')).toBeDefined();
    });
  });

  describe('hydrateThread (Phase C Task 5+6+7 — atomic hydration writer, 砚砚 P1)', () => {
    it('active thread: writes flat messages AND mirrors to threadStates', () => {
      const msgs = [{ id: 'h1', type: 'assistant' as const, catId: 'opus', content: 'hydrated', timestamp: 1 }];
      useChatStore.getState().hydrateThread(ACTIVE_TID, msgs, false);

      const s = useChatStore.getState();
      // flat (compat mirror)
      expect(s.messages.find((m) => m.id === 'h1')).toBeDefined();
      expect(s.hasMore).toBe(false);
      // threadStates (writer source) — same payload
      expect(s.threadStates[ACTIVE_TID]?.messages.find((m) => m.id === 'h1')).toBeDefined();
      expect(s.threadStates[ACTIVE_TID]?.hasMore).toBe(false);
    });

    it('background thread (never-seen): does NOT leak active liveness/queue/workspace into target (砚砚 P1 round 2)', () => {
      // Seed flat with active thread liveness — these fields must NOT bleed
      // into the never-seen background thread via snapshotActive fallback.
      useChatStore.setState({
        messages: [{ id: 'active-msg', type: 'user', content: 'active', timestamp: 0 }],
        hasActiveInvocation: true,
        intentMode: 'execute',
        targetCats: ['opus'],
        catStatuses: { opus: 'streaming' },
        catInvocations: { opus: { invocationId: 'active-inv', startedAt: 1 } },
        activeInvocations: { 'active-inv': { catId: 'opus', mode: 'execute' } },
      });
      const bgMsgs = [{ id: 'bg-1', type: 'assistant' as const, catId: 'opus', content: 'bg', timestamp: 1 }];

      useChatStore.getState().hydrateThread(BG_TID, bgMsgs, false);

      const bgState = useChatStore.getState().threadStates[BG_TID];
      expect(bgState).toBeDefined();
      expect(bgState?.messages.find((m) => m.id === 'bg-1')).toBeDefined();
      // Liveness must be DEFAULT (not active's liveness leaked via snapshotActive)
      expect(bgState?.hasActiveInvocation).toBe(false);
      expect(bgState?.intentMode).toBeNull();
      expect(bgState?.targetCats).toEqual([]);
      expect(bgState?.catStatuses).toEqual({});
      expect(bgState?.catInvocations).toEqual({});
      expect(bgState?.activeInvocations).toEqual({});
    });

    it('background thread: revokes blob URLs from prev messages dropped by hydration (云端 Codex P2)', () => {
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const blobUrl = 'blob:http://localhost/abc-123';
      // Seed BG thread with a message containing a blob: image URL
      useChatStore.setState({
        threadStates: {
          [BG_TID]: {
            ...DEFAULT_THREAD_STATE,
            messages: [
              {
                id: 'old-1',
                type: 'user',
                content: '',
                contentBlocks: [{ type: 'image', url: blobUrl }],
                timestamp: 1,
              },
            ],
            hasMore: true,
          },
        },
      });
      const newMsgs = [{ id: 'new-1', type: 'assistant' as const, catId: 'opus', content: 'hi', timestamp: 2 }];

      useChatStore.getState().hydrateThread(BG_TID, newMsgs, false);

      expect(revokeSpy).toHaveBeenCalledWith(blobUrl);
      revokeSpy.mockRestore();
    });

    it('background thread: writes only threadStates, does NOT touch flat', () => {
      // Seed flat with the active thread's existing messages so we can verify pollution
      useChatStore.setState({
        messages: [{ id: 'active-msg', type: 'user', content: 'active', timestamp: 0 }],
        hasMore: true,
      });
      const bgMsgs = [{ id: 'bg-1', type: 'assistant' as const, catId: 'opus', content: 'bg hydrated', timestamp: 1 }];
      useChatStore.getState().hydrateThread(BG_TID, bgMsgs, false);

      const s = useChatStore.getState();
      // threadStates[BG] has the bg payload
      expect(s.threadStates[BG_TID]?.messages.find((m) => m.id === 'bg-1')).toBeDefined();
      expect(s.threadStates[BG_TID]?.hasMore).toBe(false);
      // flat untouched — active thread's existing data preserved
      expect(s.messages.find((m) => m.id === 'active-msg')).toBeDefined();
      expect(s.messages.find((m) => m.id === 'bg-1')).toBeUndefined();
      expect(s.hasMore).toBe(true);
      // threadStates[ACTIVE] not affected by bg hydrate
      expect(s.threadStates[ACTIVE_TID]?.messages?.find((m) => m.id === 'bg-1')).toBeUndefined();
    });
  });

  describe('mirror enables ghost-free thread switch', () => {
    it('after writing to active, switching away preserves the same data without snapshotActive race', () => {
      useChatStore.getState().setThreadCatInvocation(ACTIVE_TID, 'opus', { invocationId: 'inv-1' });
      useChatStore.getState().addThreadActiveInvocation(ACTIVE_TID, 'inv-1', 'opus', 'execute');
      useChatStore.getState().setThreadLoading(ACTIVE_TID, true);

      // Mirror invariant means threadStates already has the truth — switching is a no-op for data fidelity
      const beforeSwitch = useChatStore.getState().threadStates[ACTIVE_TID];
      expect(beforeSwitch?.catInvocations?.opus?.invocationId).toBe('inv-1');
      expect(beforeSwitch?.activeInvocations?.['inv-1']).toBeDefined();
      expect(beforeSwitch?.isLoading).toBe(true);

      useChatStore.getState().setCurrentThread(BG_TID);

      const afterSwitch = useChatStore.getState().threadStates[ACTIVE_TID];
      expect(afterSwitch?.catInvocations?.opus?.invocationId).toBe('inv-1');
      expect(afterSwitch?.activeInvocations?.['inv-1']).toBeDefined();
      expect(afterSwitch?.isLoading).toBe(true);
    });
  });
});
