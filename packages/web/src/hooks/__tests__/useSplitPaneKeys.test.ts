import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

/**
 * Test split-pane shortcut state transitions directly (store-level logic only).
 */

describe('split-pane keyboard shortcuts (logic)', () => {
  beforeEach(() => {
    useChatStore.setState({
      viewMode: 'split',
      splitPaneThreadIds: ['t1', 't2', 't3', 't4'],
      splitPaneTargetId: null,
      currentThreadId: 't1',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
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
    });
  });

  it('Cmd+\\ toggles viewMode', () => {
    expect(useChatStore.getState().viewMode).toBe('split');

    // Simulate pressing Cmd+\
    const store = useChatStore.getState();
    store.setViewMode(store.viewMode === 'single' ? 'split' : 'single');
    expect(useChatStore.getState().viewMode).toBe('single');

    // Toggle back
    const store2 = useChatStore.getState();
    store2.setViewMode(store2.viewMode === 'single' ? 'split' : 'single');
    expect(useChatStore.getState().viewMode).toBe('split');
  });

  it('Cmd+1 selects pane 1', () => {
    const store = useChatStore.getState();
    const threadId = store.splitPaneThreadIds[0];
    store.setSplitPaneTarget(threadId);
    expect(useChatStore.getState().splitPaneTargetId).toBe('t1');
  });

  it('Cmd+3 selects pane 3', () => {
    const store = useChatStore.getState();
    const threadId = store.splitPaneThreadIds[2];
    store.setSplitPaneTarget(threadId);
    expect(useChatStore.getState().splitPaneTargetId).toBe('t3');
  });

  it('no-op when pane index has no thread', () => {
    useChatStore.setState({ splitPaneThreadIds: ['t1', 't2'] });
    const store = useChatStore.getState();
    // Index 2 is undefined
    const threadId = store.splitPaneThreadIds[2];
    expect(threadId).toBeUndefined();
    // setSplitPaneTarget should not be called
    expect(useChatStore.getState().splitPaneTargetId).toBeNull();
  });
});
