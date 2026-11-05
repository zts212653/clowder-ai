/**
 * Tests for hasActiveInvocation state (A2A Stop button UX).
 * Verifies that hasActiveInvocation is preserved across thread switches
 * and correctly toggled by setHasActiveInvocation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

describe('chatStore hasActiveInvocation', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},

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

  it('defaults to false', () => {
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
  });

  it('can be set to true', () => {
    useChatStore.getState().setHasActiveInvocation(true);
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);
  });

  it('can be reset to false', () => {
    useChatStore.getState().setHasActiveInvocation(true);
    useChatStore.getState().setHasActiveInvocation(false);
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
  });

  it('preserves hasActiveInvocation across thread switches', () => {
    useChatStore.getState().setHasActiveInvocation(true);
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);

    // Switch to thread B — fresh thread should be false
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);

    // Switch back to thread A — should be restored to true
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);
  });

  it('is independent of isLoading', () => {
    // Set both true
    useChatStore.getState().setLoading(true);
    useChatStore.getState().setHasActiveInvocation(true);
    expect(useChatStore.getState().isLoading).toBe(true);
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);

    // Reset loading but keep active invocation
    useChatStore.getState().setLoading(false);
    expect(useChatStore.getState().isLoading).toBe(false);
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);
  });
});
