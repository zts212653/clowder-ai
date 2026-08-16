/**
 * P2 regression: background thread invocation lifecycle cleanup.
 *
 * When a background thread's invocation completes (done/isFinal or error/isFinal),
 * its hasActiveInvocation should be cleared in the threadStates map.
 * Otherwise, switching back to that thread would show stale "active" state.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

describe('chatStore background thread invocation lifecycle (P2 regression)', () => {
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

  it('clearThreadActiveInvocation clears hasActiveInvocation for background thread', () => {
    const store = useChatStore.getState();

    // Thread A active: set hasActiveInvocation=true, then switch to B
    store.setHasActiveInvocation(true);
    store.setCurrentThread('thread-b');
    // Thread A is now in background with hasActiveInvocation=true
    expect(useChatStore.getState().threadStates['thread-a']?.hasActiveInvocation).toBe(true);

    // Simulate background thread A completing
    useChatStore.getState().clearThreadActiveInvocation('thread-a');

    // Should be cleared in the map
    expect(useChatStore.getState().threadStates['thread-a']?.hasActiveInvocation).toBe(false);

    // Switch back to thread A — hasActiveInvocation should be false
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
  });

  it('clearThreadActiveInvocation works on active thread too (sets flat state)', () => {
    useChatStore.getState().setHasActiveInvocation(true);
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);

    useChatStore.getState().clearThreadActiveInvocation('thread-a');
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
  });

  it('clearThreadActiveInvocation is no-op for unknown thread', () => {
    useChatStore.getState().clearThreadActiveInvocation('thread-unknown');
    // Should not create a new entry in threadStates for unknown thread
    expect(useChatStore.getState().threadStates['thread-unknown']).toBeUndefined();
  });

  it('setThreadHasActiveInvocation retires a terminal-correlated slot but keeps the newer coarse active edge', () => {
    const store = useChatStore.getState();
    store.addActiveInvocation('inv-old', 'codex-sol', 'execute');
    store.setCatInvocation('codex-sol', {
      invocationId: 'inv-old',
      appServerLifecycle: {
        stage: 'closed',
        lastActivityAt: 123,
        recoveryAttempt: 0,
        turnStartSent: true,
        turnAccepted: true,
        itemObserved: true,
      },
    });
    store.setCurrentThread('thread-b');

    useChatStore.getState().setThreadHasActiveInvocation('thread-a', true);

    const background = useChatStore.getState().threadStates['thread-a'];
    expect(background?.activeInvocations).toEqual({});
    expect(background?.hasActiveInvocation).toBe(true);
  });

  it('setThreadHasActiveInvocation preserves a newer slot uncorrelated with the old terminal lifecycle', () => {
    const store = useChatStore.getState();
    store.addActiveInvocation('inv-new', 'codex-sol', 'execute');
    store.setCatInvocation('codex-sol', {
      invocationId: 'inv-old',
      appServerLifecycle: {
        stage: 'closed',
        lastActivityAt: 123,
        recoveryAttempt: 0,
        turnStartSent: true,
        turnAccepted: true,
        itemObserved: true,
      },
    });
    store.setCurrentThread('thread-b');

    useChatStore.getState().setThreadHasActiveInvocation('thread-a', true);

    const background = useChatStore.getState().threadStates['thread-a'];
    expect(background?.activeInvocations).toEqual({
      'inv-new': expect.objectContaining({ catId: 'codex-sol', mode: 'execute' }),
    });
    expect(background?.hasActiveInvocation).toBe(true);
  });

  it('setHasActiveInvocation applies the same terminal-slot retirement to the current thread mirror', () => {
    const store = useChatStore.getState();
    store.addActiveInvocation('inv-old', 'codex-sol', 'execute');
    store.setCatInvocation('codex-sol', {
      invocationId: 'inv-old',
      appServerLifecycle: {
        stage: 'closed',
        lastActivityAt: 123,
        recoveryAttempt: 0,
        turnStartSent: true,
        turnAccepted: true,
        itemObserved: true,
      },
    });

    useChatStore.getState().setHasActiveInvocation(true);

    const next = useChatStore.getState();
    expect(next.activeInvocations).toEqual({});
    expect(next.hasActiveInvocation).toBe(true);
    expect(next.threadStates['thread-a']?.activeInvocations).toEqual({});
    expect(next.threadStates['thread-a']?.hasActiveInvocation).toBe(true);
  });

  it('resetThreadInvocationState clears loading/intent/status for background thread before switching back', () => {
    const store = useChatStore.getState();

    // Start invocation on thread-a, then switch away.
    store.setLoading(true);
    store.setHasActiveInvocation(true);
    store.setIntentMode('execute');
    store.setCatStatus('codex', 'streaming');
    store.setCurrentThread('thread-b');

    // Background timeout path should reset invocation-scoped UI state.
    store.resetThreadInvocationState('thread-a');

    // Switch back — loading/intent/status should all be reset.
    store.setCurrentThread('thread-a');
    expect(useChatStore.getState().isLoading).toBe(false);
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
    expect(useChatStore.getState().intentMode).toBeNull();
    expect(useChatStore.getState().catStatuses).toEqual({});
  });
});
