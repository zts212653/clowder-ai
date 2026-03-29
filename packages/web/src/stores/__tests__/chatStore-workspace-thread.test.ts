import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

describe('workspace state per-thread persistence', () => {
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
      currentGame: null,
      threadStates: {},
      currentThreadId: 'thread-a',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
      workspaceWorktreeId: 'wt-main',
      workspaceOpenTabs: [],
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
    });
  });

  it('preserves workspace open file across thread switch', () => {
    // Open a file in thread A
    useChatStore.getState().setWorkspaceOpenFile('README.md', 10);
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('README.md');
    expect(useChatStore.getState().workspaceOpenTabs).toContain('README.md');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(10);

    // Switch to thread B
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().currentThreadId).toBe('thread-b');
    // Thread B should have empty workspace
    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
    expect(useChatStore.getState().workspaceOpenTabs).toEqual([]);
    expect(useChatStore.getState().workspaceOpenFileLine).toBeNull();

    // Switch back to thread A — workspace should be restored
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('README.md');
    expect(useChatStore.getState().workspaceOpenTabs).toContain('README.md');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(10);
  });

  it('maintains independent workspace state per thread', () => {
    // Open file in thread A
    useChatStore.getState().setWorkspaceOpenFile('src/index.ts', 5);

    // Switch to thread B, open a different file
    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().setWorkspaceOpenFile('package.json', null);

    // Thread B has its own file
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('package.json');

    // Switch back to A — still has its file
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('src/index.ts');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(5);

    // Switch back to B — still has its file
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('package.json');
  });

  it('restores worktreeId when threads use different worktrees', () => {
    // Thread A uses worktree "wt-feat" and opens a file
    useChatStore.setState({ workspaceWorktreeId: 'wt-feat' });
    useChatStore.getState().setWorkspaceOpenFile('src/feature.ts', 1);

    // Switch to thread B, select a different worktree
    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.setState({ workspaceWorktreeId: 'wt-main' });
    useChatStore.getState().setWorkspaceOpenFile('README.md', null);

    expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-main');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('README.md');

    // Switch back to A — both worktreeId AND file should be restored
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-feat');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('src/feature.ts');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(1);

    // Switch back to B — B's worktree and file restored
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-main');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('README.md');
  });

  it('preserves multiple open tabs across thread switch', () => {
    // Open multiple files in thread A
    useChatStore.getState().setWorkspaceOpenFile('file1.ts');
    useChatStore.getState().setWorkspaceOpenFile('file2.ts');
    useChatStore.getState().setWorkspaceOpenFile('file3.ts');
    expect(useChatStore.getState().workspaceOpenTabs).toEqual(['file1.ts', 'file2.ts', 'file3.ts']);

    // Switch away and back
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceOpenTabs).toEqual([]);

    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().workspaceOpenTabs).toEqual(['file1.ts', 'file2.ts', 'file3.ts']);
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('file3.ts');
  });
});
