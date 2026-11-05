import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

describe('chatStore viewMode + split pane state', () => {
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

  it('toggles viewMode between single and split', () => {
    expect(useChatStore.getState().viewMode).toBe('single');
    useChatStore.getState().setViewMode('split');
    expect(useChatStore.getState().viewMode).toBe('split');
    useChatStore.getState().setViewMode('single');
    expect(useChatStore.getState().viewMode).toBe('single');
  });

  it('preserves splitPaneThreadIds across viewMode toggles', () => {
    useChatStore.getState().setSplitPaneThreadIds(['t1', 't2', 't3']);
    useChatStore.getState().setViewMode('single');
    expect(useChatStore.getState().splitPaneThreadIds).toEqual(['t1', 't2', 't3']);
    useChatStore.getState().setViewMode('split');
    expect(useChatStore.getState().splitPaneThreadIds).toEqual(['t1', 't2', 't3']);
  });

  it('preserves splitPaneTargetId across viewMode toggles', () => {
    useChatStore.getState().setSplitPaneTarget('t2');
    useChatStore.getState().setViewMode('single');
    expect(useChatStore.getState().splitPaneTargetId).toBe('t2');
    useChatStore.getState().setViewMode('split');
    expect(useChatStore.getState().splitPaneTargetId).toBe('t2');
  });

  it('splitPaneThreadIds are independent from thread switches', () => {
    useChatStore.getState().setSplitPaneThreadIds(['x1', 'x2']);
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().splitPaneThreadIds).toEqual(['x1', 'x2']);
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().splitPaneThreadIds).toEqual(['x1', 'x2']);
  });

  it('updateThreadCatStatus reflects in getThreadState for split pane', () => {
    useChatStore.getState().setSplitPaneThreadIds(['thread-a', 'thread-b']);
    // Update background thread
    useChatStore.getState().updateThreadCatStatus('thread-b', 'opus', 'streaming');
    const ts = useChatStore.getState().getThreadState('thread-b');
    expect(ts.catStatuses.opus).toBe('streaming');
  });
});
