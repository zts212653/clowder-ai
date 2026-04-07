/**
 * F108: Tests for multi-slot activeInvocations state.
 * Verifies that concurrent invocations are tracked independently
 * and hasActiveInvocation derives from activeInvocations.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

describe('chatStore multi-slot activeInvocations (F108)', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      activeInvocations: {},
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,

      threadStates: {},
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentThreadId: 'thread-a',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
  });

  it('addActiveInvocation sets hasActiveInvocation to true', () => {
    useChatStore.getState().addActiveInvocation('inv-1', 'opus', 'execute');
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);
    expect(useChatStore.getState().activeInvocations).toEqual({
      'inv-1': expect.objectContaining({ catId: 'opus', mode: 'execute' }),
    });
  });

  it('two active invocations → hasActiveInvocation stays true after one completes', () => {
    const store = useChatStore.getState();
    store.addActiveInvocation('inv-1', 'opus', 'execute');
    store.addActiveInvocation('inv-2', 'codex', 'execute');
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);
    expect(Object.keys(useChatStore.getState().activeInvocations)).toHaveLength(2);

    store.removeActiveInvocation('inv-1');
    expect(useChatStore.getState().hasActiveInvocation).toBe(true); // codex still active

    store.removeActiveInvocation('inv-2');
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
  });

  it('removeActiveInvocation is idempotent for unknown invocationId', () => {
    useChatStore.getState().removeActiveInvocation('nonexistent');
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
  });

  it('setHasActiveInvocation(true) still works for backward compat', () => {
    useChatStore.getState().setHasActiveInvocation(true);
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);
  });

  it('activeInvocations are preserved across thread switches', () => {
    useChatStore.getState().addActiveInvocation('inv-1', 'opus', 'execute');
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);

    // Switch to thread B — fresh thread
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
    expect(useChatStore.getState().activeInvocations).toEqual({});

    // Switch back to thread A — should be restored
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);
    expect(useChatStore.getState().activeInvocations).toEqual({
      'inv-1': expect.objectContaining({ catId: 'opus', mode: 'execute' }),
    });
  });

  it('#963: side-dispatch intent_mode must replace parent slot for same cat (no orphans)', () => {
    const store = useChatStore.getState();

    // Step 1: Parent intent_mode registers all cats
    store.addActiveInvocation('inv-A', 'opus', 'execute');
    store.addActiveInvocation('inv-A-gemini', 'gemini', 'execute');
    store.addActiveInvocation('inv-A-gpt52', 'gpt52', 'execute');
    expect(Object.keys(useChatStore.getState().activeInvocations)).toHaveLength(3);

    // Step 2: Callback intent_mode for gemini with new invocationId.
    // Preempt stale slot first (mirrors useSocket.ts registration-time fix).
    const cur = useChatStore.getState().activeInvocations;
    for (const [key, info] of Object.entries(cur)) {
      if (info.catId === 'gemini' && key !== 'inv-B') {
        useChatStore.getState().removeActiveInvocation(key);
      }
    }
    useChatStore.getState().addActiveInvocation('inv-B', 'gemini', 'execute');

    // Should have 3 slots: inv-A (opus), inv-B (gemini), inv-A-gpt52 (gpt52)
    const state = useChatStore.getState();
    expect(Object.keys(state.activeInvocations)).toHaveLength(3);
    expect(state.activeInvocations['inv-A']).toBeDefined();
    expect(state.activeInvocations['inv-B']).toBeDefined();
    expect(state.activeInvocations['inv-A-gpt52']).toBeDefined();
    expect(state.activeInvocations['inv-A-gemini']).toBeUndefined();

    // Step 3: Gemini finishes — removing inv-B leaves no gemini orphan
    useChatStore.getState().removeActiveInvocation('inv-B');
    const after = useChatStore.getState();
    expect(Object.keys(after.activeInvocations)).toHaveLength(2);
    expect(Object.values(after.activeInvocations).some((i) => i.catId === 'gemini')).toBe(false);
  });

  it('setThreadHasActiveInvocation works for background threads with slot tracking', () => {
    // Set up a background thread with active invocation
    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().addActiveInvocation('inv-bg', 'codex', 'execute');
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);

    // Switch away from thread-b
    useChatStore.getState().setCurrentThread('thread-a');

    // thread-b's state should be preserved in threadStates
    const bgState = useChatStore.getState().threadStates['thread-b'];
    expect(bgState?.hasActiveInvocation).toBe(true);
    expect(bgState?.activeInvocations).toEqual({
      'inv-bg': expect.objectContaining({ catId: 'codex', mode: 'execute' }),
    });
  });
});
