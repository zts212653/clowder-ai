/**
 * F101 Phase D: Race condition test for /game thread switch + loading cleanup.
 *
 * Scenario: User sends /game from thread A → loading=true on A → game:thread_created
 * navigates to thread B → HTTP response arrives → cleanup must clear A's loading,
 * not B's (which was never set).
 *
 * The fix: useSendMessage uses thread-scoped APIs (setThreadLoading) instead of
 * flat-state APIs (setLoading) for game_started cleanup, so the cleanup targets
 * the correct thread regardless of which thread is currently active.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

const SOURCE_THREAD = 'thread-source';
const GAME_THREAD = 'thread-game';

describe('game thread loading race condition', () => {
  beforeEach(() => {
    // Start on the source thread with clean state
    useChatStore.setState({
      currentThreadId: SOURCE_THREAD,
      messages: [],
      isLoading: false,
      hasActiveInvocation: false,
      threadStates: {},
    });
  });

  it('setThreadLoading clears source thread even after navigating away', () => {
    const store = useChatStore.getState();

    // Step 1: /game sent → loading set on source thread (currently active = flat state)
    store.setThreadLoading(SOURCE_THREAD, true);
    store.setThreadHasActiveInvocation(SOURCE_THREAD, true);
    expect(useChatStore.getState().isLoading).toBe(true);

    // Step 2: game:thread_created arrives → navigate to game thread
    // setCurrentThread snapshots source thread (isLoading=true) into threadStates
    store.setCurrentThread(GAME_THREAD);
    expect(useChatStore.getState().currentThreadId).toBe(GAME_THREAD);

    // Source thread's loading=true is now in threadStates (not flat)
    const savedSource = useChatStore.getState().threadStates[SOURCE_THREAD];
    expect(savedSource?.isLoading).toBe(true);

    // Step 3: HTTP response arrives → cleanup uses thread-scoped API
    // Since source != currentThread, this correctly writes to threadStates[source]
    store.setThreadLoading(SOURCE_THREAD, false);
    store.setThreadHasActiveInvocation(SOURCE_THREAD, false);

    // Verify: source thread loading is cleared in threadStates
    const cleanedSource = useChatStore.getState().threadStates[SOURCE_THREAD];
    expect(cleanedSource?.isLoading).toBe(false);
    expect(cleanedSource?.hasActiveInvocation).toBe(false);

    // Verify: game thread (now active) was never contaminated
    expect(useChatStore.getState().isLoading).toBe(false);
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
  });

  it('setThreadLoading clears source thread when still active (no navigation race)', () => {
    const store = useChatStore.getState();

    // /game sent → loading set on source thread
    store.setThreadLoading(SOURCE_THREAD, true);
    store.setThreadHasActiveInvocation(SOURCE_THREAD, true);

    // HTTP response arrives before game:thread_created (no navigation happened)
    // source is still active → thread-scoped API hits flat state
    store.setThreadLoading(SOURCE_THREAD, false);
    store.setThreadHasActiveInvocation(SOURCE_THREAD, false);

    expect(useChatStore.getState().isLoading).toBe(false);
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
  });
});
