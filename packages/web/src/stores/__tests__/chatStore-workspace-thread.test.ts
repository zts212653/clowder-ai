import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleNavigateEvent } from '@/hooks/useWorkspaceNavigate';
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

describe('presentation lock (AC-PL1~PL5)', () => {
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
      workspaceOpenTabs: ['README.md'],
      workspaceOpenFilePath: 'README.md',
      workspaceOpenFileLine: 42,
      presentationLock: null,
    });
  });

  it('AC-PL1: locked workspace persists across thread switch', () => {
    const s = useChatStore.getState();
    s.enablePresentationLock();

    // Lock should capture current workspace state
    const lock = useChatStore.getState().presentationLock;
    expect(lock).not.toBeNull();
    expect(lock!.filePath).toBe('README.md');
    expect(lock!.line).toBe(42);
    expect(lock!.worktreeId).toBe('wt-main');
    expect(lock!.tabs).toEqual(['README.md']);

    // Switch to thread B — workspace fields should still reflect locked state
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('README.md');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(42);
    expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-main');
    expect(useChatStore.getState().workspaceOpenTabs).toEqual(['README.md']);
  });

  it('AC-PL2: lock snapshot includes worktree + file + line + tabs', () => {
    useChatStore.setState({
      workspaceWorktreeId: 'wt-feat',
      workspaceOpenTabs: ['src/a.ts', 'src/b.ts'],
      workspaceOpenFilePath: 'src/b.ts',
      workspaceOpenFileLine: 100,
    });
    useChatStore.getState().enablePresentationLock();

    const lock = useChatStore.getState().presentationLock!;
    expect(lock.worktreeId).toBe('wt-feat');
    expect(lock.tabs).toEqual(['src/a.ts', 'src/b.ts']);
    expect(lock.filePath).toBe('src/b.ts');
    expect(lock.line).toBe(100);
  });

  it('AC-PL3: exiting lock restores current thread workspace', () => {
    // Open file in thread A, lock, switch to B
    useChatStore.getState().enablePresentationLock();
    useChatStore.getState().setCurrentThread('thread-b');

    // Thread B's own workspace should be saved independently
    // (but visible state shows lock override)
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('README.md'); // locked

    // Disable lock — should restore thread B's own (empty) state
    useChatStore.getState().disablePresentationLock();
    expect(useChatStore.getState().presentationLock).toBeNull();
    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
    expect(useChatStore.getState().workspaceOpenTabs).toEqual([]);
  });

  it('AC-PL4: locked fields do not pollute other threads threadStates', () => {
    useChatStore.getState().enablePresentationLock();

    // Switch to thread B while locked
    useChatStore.getState().setCurrentThread('thread-b');

    // Thread B's saved state should NOT contain the locked workspace fields
    // Switch to thread C so thread B gets saved
    useChatStore.getState().setCurrentThread('thread-c');
    const threadBState = useChatStore.getState().threadStates['thread-b'];
    expect(threadBState).toBeDefined();
    expect(threadBState.workspaceOpenFilePath).toBeNull();
    expect(threadBState.workspaceOpenTabs).toEqual([]);
  });

  it('AC-PL5: replacePresentationLockTarget updates locked snapshot', () => {
    useChatStore.getState().enablePresentationLock();
    expect(useChatStore.getState().presentationLock!.filePath).toBe('README.md');

    // User explicitly replaces locked target
    useChatStore.getState().replacePresentationLockTarget({
      ...useChatStore.getState().presentationLock!,
      filePath: 'docs/VISION.md',
      line: 10,
      tabs: ['docs/VISION.md'],
    });

    const lock = useChatStore.getState().presentationLock!;
    expect(lock.filePath).toBe('docs/VISION.md');
    expect(lock.line).toBe(10);
  });

  it('AC-PL5: navigate events suppressed when locked', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
      setWorkspaceMode: vi.fn(),
    };

    // Without lock: navigate proceeds
    const result1 = handleNavigateEvent(
      { path: 'src/new.ts', action: 'open', line: 5 },
      'wt-main',
      actions,
      null,
      false,
    );
    expect(result1).toBe(true);
    expect(actions.setWorkspaceOpenFile).toHaveBeenCalled();

    vi.clearAllMocks();

    // With lock: navigate suppressed
    const result2 = handleNavigateEvent(
      { path: 'src/new.ts', action: 'open', line: 5 },
      'wt-main',
      actions,
      null,
      true,
    );
    expect(result2).toBe(false);
    expect(actions.setWorkspaceOpenFile).not.toHaveBeenCalled();

    // Knowledge-feed still works when locked
    const result3 = handleNavigateEvent({ path: '', action: 'knowledge-feed' }, 'wt-main', actions, null, true);
    expect(result3).toBe(true);
    expect(actions.setWorkspaceMode).toHaveBeenCalledWith('recall');
  });

  it('lock survives multiple thread switches', () => {
    useChatStore.getState().enablePresentationLock();

    // Cycle through threads A → B → C → A
    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().setCurrentThread('thread-c');
    useChatStore.getState().setCurrentThread('thread-a');

    // Locked workspace persists through all switches
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('README.md');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(42);
    expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-main');
  });

  it('P1-fix: lock owner thread workspace preserved on round-trip', () => {
    // A opens README, locks, switches B, switches back A, unlocks
    useChatStore.getState().enablePresentationLock();
    expect(useChatStore.getState().presentationLock!.ownerThreadId).toBe('thread-a');

    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().setCurrentThread('thread-a');

    // Disable lock — should restore A's original workspace (README.md:42)
    useChatStore.getState().disablePresentationLock();
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('README.md');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(42);
    expect(useChatStore.getState().workspaceOpenTabs).toEqual(['README.md']);
  });

  it('P2-fix: replacePresentationLockTarget updates lock snapshot', () => {
    useChatStore.getState().enablePresentationLock();
    const lock = useChatStore.getState().presentationLock!;

    useChatStore.getState().replacePresentationLockTarget({
      ...lock,
      filePath: 'docs/SOP.md',
      line: 5,
      tabs: ['docs/SOP.md'],
    });

    // Switch thread — should show replaced target
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/SOP.md');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(5);
  });

  it('P2-fix: lock replacement must sync tabs (not spread stale snapshot)', () => {
    // Lock with README.md open
    useChatStore.getState().enablePresentationLock();
    expect(useChatStore.getState().presentationLock!.tabs).toEqual(['README.md']);

    // Simulate what updateLockTarget does: add new file to tabs
    const lock = useChatStore.getState().presentationLock!;
    const newPath = 'docs/SOP.md';
    const newTabs = lock.tabs.includes(newPath) ? lock.tabs : [...lock.tabs, newPath];
    useChatStore.getState().replacePresentationLockTarget({
      ...lock,
      filePath: newPath,
      line: 10,
      tabs: newTabs,
    });

    // Tabs should contain both old and new file
    const updated = useChatStore.getState().presentationLock!;
    expect(updated.tabs).toEqual(['README.md', 'docs/SOP.md']);
    expect(updated.filePath).toBe('docs/SOP.md');
    expect(updated.line).toBe(10);

    // Switch thread — locked state should show updated tabs
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceOpenTabs).toEqual(['README.md', 'docs/SOP.md']);
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/SOP.md');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(10);
  });

  it('R3 P2-fix: clicking existing tab updates lock filePath without mutating tabs', () => {
    // Lock with two tabs open, active on second
    useChatStore.setState({
      workspaceOpenTabs: ['src/a.ts', 'src/b.ts'],
      workspaceOpenFilePath: 'src/b.ts',
      workspaceOpenFileLine: 50,
    });
    useChatStore.getState().enablePresentationLock();

    const lock = useChatStore.getState().presentationLock!;
    expect(lock.tabs).toEqual(['src/a.ts', 'src/b.ts']);
    expect(lock.filePath).toBe('src/b.ts');

    // Simulate tab click on existing tab (what handleViewerTabSelect does)
    const clickedTab = 'src/a.ts';
    const tabs = lock.tabs.includes(clickedTab) ? lock.tabs : [...lock.tabs, clickedTab];
    useChatStore.getState().replacePresentationLockTarget({
      ...lock,
      filePath: clickedTab,
      line: null,
      tabs,
    });

    // filePath changed, tabs unchanged
    const updated = useChatStore.getState().presentationLock!;
    expect(updated.filePath).toBe('src/a.ts');
    expect(updated.line).toBeNull();
    expect(updated.tabs).toEqual(['src/a.ts', 'src/b.ts']);

    // Switch thread — locked state reflects the tab click
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('src/a.ts');
    expect(useChatStore.getState().workspaceOpenTabs).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('cloud-P1: lock then unlock on same thread preserves workspace', () => {
    // Thread A has README.md open, lock then immediately unlock (no thread switch)
    useChatStore.getState().enablePresentationLock();
    expect(useChatStore.getState().presentationLock).not.toBeNull();

    useChatStore.getState().disablePresentationLock();
    expect(useChatStore.getState().presentationLock).toBeNull();
    // Workspace must still show the original file
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('README.md');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(42);
    expect(useChatStore.getState().workspaceOpenTabs).toEqual(['README.md']);
    expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-main');
  });

  it('cloud-R3-P1-1: close non-last tab selects adjacent (not last) in lock', () => {
    useChatStore.setState({
      workspaceOpenTabs: ['a.ts', 'b.ts', 'c.ts'],
      workspaceOpenFilePath: 'a.ts',
      workspaceOpenFileLine: 1,
    });
    useChatStore.getState().enablePresentationLock();
    const lock = useChatStore.getState().presentationLock!;
    expect(lock.tabs).toEqual(['a.ts', 'b.ts', 'c.ts']);

    // Simulate closing the active first tab — store picks adjacent right (b.ts)
    useChatStore.getState().closeWorkspaceTab('a.ts');
    const oldTabs = lock.tabs;
    const tabs = oldTabs.filter((t: string) => t !== 'a.ts');
    const idx = oldTabs.indexOf('a.ts');
    const filePath = tabs[Math.min(idx, tabs.length - 1)] ?? null;
    useChatStore.getState().replacePresentationLockTarget({ ...lock, tabs, filePath, line: null });

    // Lock should point to b.ts (adjacent), not c.ts (last)
    const updated = useChatStore.getState().presentationLock!;
    expect(updated.filePath).toBe('b.ts');
    expect(updated.tabs).toEqual(['b.ts', 'c.ts']);

    // Thread switch should show b.ts
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('b.ts');
  });

  it('cloud-R3-P1-2: owner workspace stable after lock target edit + thread switch', () => {
    // Owner thread A: README.md:42
    useChatStore.getState().enablePresentationLock();
    const lock = useChatStore.getState().presentationLock!;
    expect(lock.ownerWorkspace.filePath).toBe('README.md');
    expect(lock.ownerWorkspace.line).toBe(42);

    // User navigates to a different file while locked
    useChatStore.getState().replacePresentationLockTarget({
      ...lock,
      filePath: 'docs/SOP.md',
      line: 99,
      tabs: ['README.md', 'docs/SOP.md'],
    });

    // Switch away from owner and back
    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().setCurrentThread('thread-a');

    // ownerWorkspace should still be the original README.md:42
    const lockAfter = useChatStore.getState().presentationLock!;
    expect(lockAfter.ownerWorkspace.filePath).toBe('README.md');
    expect(lockAfter.ownerWorkspace.tabs).toEqual(['README.md']);

    // Unlock on owner thread → restores original workspace, not the edited target
    useChatStore.getState().disablePresentationLock();
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('README.md');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(42);
    expect(useChatStore.getState().workspaceOpenTabs).toEqual(['README.md']);
  });

  it('cloud-R7-P2-1: lock tabs reset when setWorkspaceOpenFile switches worktree', () => {
    useChatStore.getState().enablePresentationLock();
    const lock = useChatStore.getState().presentationLock!;
    expect(lock.tabs).toEqual(['README.md']);
    expect(lock.worktreeId).toBe('wt-main');

    // Open file in a different worktree
    useChatStore.getState().setWorkspaceOpenFile('src/index.ts', 1, 'wt-feature');

    const updated = useChatStore.getState().presentationLock!;
    // Tabs must be reset to just the new file — old worktree tabs are invalid
    expect(updated.tabs).toEqual(['src/index.ts']);
    expect(updated.worktreeId).toBe('wt-feature');
    expect(updated.filePath).toBe('src/index.ts');
  });

  it('cloud-R7-P2-2: unlock on non-owner thread preserves worktree when thread has none', () => {
    useChatStore.getState().enablePresentationLock();

    // Switch to thread-b (fresh thread, never opened workspace — no saved worktreeId)
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-main');

    // Unlock on thread-b — should NOT wipe worktreeId to null
    useChatStore.getState().disablePresentationLock();
    expect(useChatStore.getState().presentationLock).toBeNull();
    expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-main');
  });

  it('cloud-R8-P2: setWorkspaceWorktreeId syncs lock snapshot', () => {
    useChatStore.getState().enablePresentationLock();
    expect(useChatStore.getState().presentationLock!.worktreeId).toBe('wt-main');
    expect(useChatStore.getState().presentationLock!.tabs).toEqual(['README.md']);

    // Switch worktree directly (without opening a file)
    useChatStore.getState().setWorkspaceWorktreeId('wt-feature');

    const lock = useChatStore.getState().presentationLock!;
    expect(lock.worktreeId).toBe('wt-feature');
    expect(lock.tabs).toEqual([]);
    expect(lock.filePath).toBeNull();

    // Thread switch should apply the updated lock, not snap back
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-feature');
    expect(useChatStore.getState().workspaceOpenTabs).toEqual([]);
  });

  it('AC-PL6: workspace mode unchanged by thread switch while lock active', () => {
    useChatStore.setState({ workspaceMode: 'dev' as const });
    useChatStore.getState().enablePresentationLock();

    // Switch to thread-b — mode must NOT change at store level
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceMode).toBe('dev');

    // Switch back to owner — mode still untouched
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().workspaceMode).toBe('dev');

    // Set mode to recall, then switch — mode persists through lock
    useChatStore.getState().setWorkspaceMode('recall' as const);
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceMode).toBe('recall');
  });

  // ── F063 Scroll Viewport Persist ──

  it('setPresentationLockViewport updates lock scrollTop', () => {
    useChatStore.getState().setWorkspaceOpenFile('main.ts', 1);
    useChatStore.getState().enablePresentationLock();

    useChatStore.getState().setPresentationLockViewport(420);

    const lock = useChatStore.getState().presentationLock!;
    expect(lock.scrollTop).toBe(420);
  });

  it('setPresentationLockViewport is no-op when lock is null', () => {
    expect(useChatStore.getState().presentationLock).toBeNull();
    // Should not throw
    useChatStore.getState().setPresentationLockViewport(100);
    expect(useChatStore.getState().presentationLock).toBeNull();
  });

  it('thread switch with lock restores scrollTop from lock snapshot', () => {
    useChatStore.getState().setWorkspaceOpenFile('app.ts', 5);
    useChatStore.getState().enablePresentationLock();
    useChatStore.getState().setPresentationLockViewport(300);

    // Switch to another thread — workspace overlay should include scrollTop
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceScrollTop).toBe(300);

    // Switch back to owner — scrollTop still from lock
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().workspaceScrollTop).toBe(300);
  });

  it('enablePresentationLock initializes scrollTop to null', () => {
    useChatStore.getState().setWorkspaceOpenFile('index.ts', 1);
    useChatStore.getState().enablePresentationLock();

    const lock = useChatStore.getState().presentationLock!;
    expect(lock.scrollTop).toBeNull();
  });

  it('disablePresentationLock clears workspaceScrollTop', () => {
    useChatStore.getState().setWorkspaceOpenFile('main.ts', 1);
    useChatStore.getState().enablePresentationLock();
    useChatStore.getState().setPresentationLockViewport(150);
    expect(useChatStore.getState().workspaceScrollTop).toBe(150);

    useChatStore.getState().disablePresentationLock();
    expect(useChatStore.getState().workspaceScrollTop).toBeNull();
    expect(useChatStore.getState().presentationLock).toBeNull();
  });

  it('P1-3: setWorkspaceOpenFile resets lock scrollTop when file changes', () => {
    useChatStore.getState().setWorkspaceOpenFile('main.ts', 1);
    useChatStore.getState().enablePresentationLock();
    useChatStore.getState().setPresentationLockViewport(500);
    expect(useChatStore.getState().presentationLock!.scrollTop).toBe(500);

    // Open a different file while locked — scrollTop must reset
    useChatStore.getState().setWorkspaceOpenFile('other.ts', 1);
    expect(useChatStore.getState().presentationLock!.filePath).toBe('other.ts');
    expect(useChatStore.getState().presentationLock!.scrollTop).toBeNull();
    expect(useChatStore.getState().workspaceScrollTop).toBeNull();
  });

  it('P1-3: setWorkspaceOpenFile preserves scrollTop when same file re-navigates', () => {
    useChatStore.getState().setWorkspaceOpenFile('main.ts', 1);
    useChatStore.getState().enablePresentationLock();
    useChatStore.getState().setPresentationLockViewport(200);

    // Same file, different line — scrollTop preserved
    useChatStore.getState().setWorkspaceOpenFile('main.ts', 50);
    expect(useChatStore.getState().presentationLock!.scrollTop).toBe(200);
  });
});
