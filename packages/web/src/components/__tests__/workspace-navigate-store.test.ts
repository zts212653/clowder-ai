import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleNavigateEvent, shouldAcceptNavigate } from '@/hooks/useWorkspaceNavigate';
import { useChatStore } from '@/stores/chatStore';
import {
  areWorktreeIdsEquivalent,
  buildWorktreeAliasMap,
  getNavigateWorktreeRoomIds,
  hasEquivalentWorktreeId,
  resolveListedWorktreeId,
  resolveNavigateTargetWorktreeId,
  scopeWorktreeAliases,
} from '@/utils/worktree-id-alias';

const repoRootAliases = {
  '230809_cat-cafe': 'cat-cafe',
  '230809_cat-cafe-runtime': 'cat-cafe-runtime',
};

describe('workspace navigate store (F131)', () => {
  afterEach(() => {
    useChatStore.setState({
      workspaceRevealPath: null,
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceWorktreeId: null,
      workspaceWorktreeAliases: {},
      workspaceWorktreeAliasesProjectPath: null,
      workspaceOpenTabs: [],
      _workspaceFileSetAt: { ts: 0, threadId: null },
      rightPanelMode: 'status',
      currentProjectPath: 'default',
    });
  });

  it('setWorkspaceRevealPath stores path and switches to workspace mode', () => {
    useChatStore.getState().setWorkspaceRevealPath('docs/README.md');
    const state = useChatStore.getState();
    expect(state.workspaceRevealPath).toBe('docs/README.md');
    expect(state.rightPanelMode).toBe('workspace');
  });

  it('setWorkspaceOpenFile stores path with line and switches to workspace mode', () => {
    useChatStore.setState({ rightPanelMode: 'status' });
    useChatStore.getState().setWorkspaceOpenFile('src/index.ts', 42);
    const state = useChatStore.getState();
    expect(state.workspaceOpenFilePath).toBe('src/index.ts');
    expect(state.workspaceOpenFileLine).toBe(42);
    expect(state.rightPanelMode).toBe('workspace');
  });

  it('setWorkspaceWorktreeId skips destructive reset when id is unchanged', () => {
    useChatStore.getState().setWorkspaceOpenFile('src/app.ts', 10, 'cat-cafe');
    expect(useChatStore.getState().workspaceWorktreeId).toBe('cat-cafe');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('src/app.ts');
    expect(useChatStore.getState().workspaceOpenTabs).toEqual(['src/app.ts']);

    useChatStore.getState().setWorkspaceWorktreeId('cat-cafe');

    const state = useChatStore.getState();
    expect(state.workspaceWorktreeId).toBe('cat-cafe');
    expect(state.workspaceOpenFilePath).toBe('src/app.ts');
    expect(state.workspaceOpenTabs).toEqual(['src/app.ts']);
  });

  it('setWorkspaceWorktreeId clears file state when switching to a different worktree', () => {
    useChatStore.getState().setWorkspaceOpenFile('src/app.ts', 10, 'cat-cafe');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('src/app.ts');

    useChatStore.getState().setWorkspaceWorktreeId('cat-cafe-runtime');

    const state = useChatStore.getState();
    expect(state.workspaceWorktreeId).toBe('cat-cafe-runtime');
    expect(state.workspaceOpenFilePath).toBeNull();
    expect(state.workspaceOpenTabs).toEqual([]);
  });

  it('setWorkspaceOpenFile preserves prefixed worktree alias when navigate emits canonical id', () => {
    useChatStore.setState({
      currentProjectPath: '/tmp/current-project',
      workspaceWorktreeId: '230809_cat-cafe',
      workspaceWorktreeAliases: repoRootAliases,
      workspaceWorktreeAliasesProjectPath: '/tmp/current-project',
    });

    useChatStore.getState().setWorkspaceOpenFile('docs/study.md', 7, 'cat-cafe');

    const state = useChatStore.getState();
    expect(state.workspaceWorktreeId).toBe('230809_cat-cafe');
    expect(state.workspaceOpenFilePath).toBe('docs/study.md');
    expect(state.workspaceOpenFileLine).toBe(7);
    expect(state.workspaceOpenTabs).toEqual(['docs/study.md']);
  });

  it('setWorkspaceOpenFile does not preserve shaped worktree ids without alias metadata', () => {
    useChatStore.setState({ workspaceWorktreeId: 'abcdef_feature' });

    useChatStore.getState().setWorkspaceOpenFile('docs/study.md', 7, 'feature');

    const state = useChatStore.getState();
    expect(state.workspaceWorktreeId).toBe('feature');
    expect(state.workspaceOpenFilePath).toBe('docs/study.md');
    expect(state.workspaceOpenTabs).toEqual(['docs/study.md']);
  });

  it('setWorkspaceOpenFile ignores stale aliases from a different project', () => {
    useChatStore.setState({
      currentProjectPath: '/tmp/current-project',
      workspaceWorktreeId: '230809_cat-cafe',
      workspaceWorktreeAliases: repoRootAliases,
      workspaceWorktreeAliasesProjectPath: '/tmp/previous-project',
    });

    useChatStore.getState().setWorkspaceOpenFile('docs/study.md', 7, 'cat-cafe');

    const state = useChatStore.getState();
    expect(state.workspaceWorktreeId).toBe('cat-cafe');
    expect(state.workspaceOpenFilePath).toBe('docs/study.md');
    expect(state.workspaceOpenTabs).toEqual(['docs/study.md']);
  });

  it('normalizeWorkspaceWorktreeId preserves the open file and clears edit tokens while remapping equivalent ids', () => {
    useChatStore.setState({
      workspaceWorktreeId: 'cat-cafe',
      workspaceOpenFilePath: 'docs/study.md',
      workspaceOpenFileLine: 7,
      workspaceOpenTabs: ['docs/study.md'],
      workspaceEditToken: 'edit-token',
      workspaceEditTokenExpiry: 12345,
    });

    useChatStore.getState().normalizeWorkspaceWorktreeId('230809_cat-cafe');

    const state = useChatStore.getState();
    expect(state.workspaceWorktreeId).toBe('230809_cat-cafe');
    expect(state.workspaceOpenFilePath).toBe('docs/study.md');
    expect(state.workspaceOpenFileLine).toBe(7);
    expect(state.workspaceOpenTabs).toEqual(['docs/study.md']);
    expect(state.workspaceEditToken).toBeNull();
    expect(state.workspaceEditTokenExpiry).toBeNull();
  });

  it('setWorkspaceOpenFile stamps _workspaceFileSetAt with threadId', () => {
    useChatStore.setState({ currentThreadId: 'thread-x' });
    const before = Date.now();
    useChatStore.getState().setWorkspaceOpenFile('src/app.ts', 1);
    const { _workspaceFileSetAt: stamp } = useChatStore.getState();
    expect(stamp.ts).toBeGreaterThanOrEqual(before);
    expect(stamp.ts).toBeLessThanOrEqual(Date.now());
    expect(stamp.threadId).toBe('thread-x');
  });

  it('setWorkspaceRevealPath stamps _workspaceFileSetAt with threadId', () => {
    useChatStore.setState({ currentThreadId: 'thread-y' });
    const before = Date.now();
    useChatStore.getState().setWorkspaceRevealPath('docs/README.md');
    const { _workspaceFileSetAt: stamp } = useChatStore.getState();
    expect(stamp.ts).toBeGreaterThanOrEqual(before);
    expect(stamp.ts).toBeLessThanOrEqual(Date.now());
    expect(stamp.threadId).toBe('thread-y');
  });

  it('setWorkspaceOpenFile uses originThreadId when provided (async caller safety)', () => {
    useChatStore.setState({ currentThreadId: 'thread-current' });
    useChatStore.getState().setWorkspaceOpenFile('src/app.ts', 1, null, 'thread-origin');
    const { _workspaceFileSetAt: stamp } = useChatStore.getState();
    expect(stamp.threadId).toBe('thread-origin');
  });

  it('setWorkspaceRevealPath uses originThreadId when provided', () => {
    useChatStore.setState({ currentThreadId: 'thread-current' });
    useChatStore.getState().setWorkspaceRevealPath('docs/', 'thread-origin');
    const { _workspaceFileSetAt: stamp } = useChatStore.getState();
    expect(stamp.threadId).toBe('thread-origin');
  });
});

describe('worktree id aliases', () => {
  it('builds aliases only from explicit worktree metadata', () => {
    expect(
      buildWorktreeAliasMap([
        { id: '230809_cat-cafe', canonicalId: 'cat-cafe' },
        { id: 'abcdef_feature' },
        { id: 'cat-cafe-runtime', canonicalId: 'cat-cafe-runtime' },
      ]),
    ).toEqual({ '230809_cat-cafe': 'cat-cafe' });
  });

  it('treats repoRoot-prefixed worktree ids as aliases of their canonical id', () => {
    expect(areWorktreeIdsEquivalent('230809_cat-cafe', 'cat-cafe', repoRootAliases)).toBe(true);
    expect(areWorktreeIdsEquivalent('230809_cat-cafe-runtime', 'cat-cafe-runtime', repoRootAliases)).toBe(true);
    expect(areWorktreeIdsEquivalent('230809_cat-cafe', 'cat-cafe-runtime', repoRootAliases)).toBe(false);
  });

  it('uses the current alias when a navigate event targets the canonical id', () => {
    expect(resolveNavigateTargetWorktreeId('230809_cat-cafe', 'cat-cafe', repoRootAliases)).toBe('230809_cat-cafe');
    expect(resolveNavigateTargetWorktreeId('cat-cafe-runtime', 'cat-cafe', repoRootAliases)).toBe('cat-cafe');
  });

  it('joins both prefixed and canonical worktree rooms for repoRoot-scoped ids', () => {
    expect(getNavigateWorktreeRoomIds('230809_cat-cafe', repoRootAliases)).toEqual(['230809_cat-cafe', 'cat-cafe']);
    expect(getNavigateWorktreeRoomIds('cat-cafe', repoRootAliases)).toEqual(['cat-cafe']);
    expect(getNavigateWorktreeRoomIds(null, repoRootAliases)).toEqual([]);
  });

  it('does not infer repoRoot aliases from id shape without explicit metadata', () => {
    expect(areWorktreeIdsEquivalent('abcdef_feature', 'feature')).toBe(false);
    expect(resolveNavigateTargetWorktreeId('abcdef_feature', 'feature')).toBe('feature');
    expect(getNavigateWorktreeRoomIds('abcdef_feature')).toEqual(['abcdef_feature']);
  });

  it('treats a canonical selection as present when the list carries an explicit prefixed alias', () => {
    const worktrees = [
      { id: '230809_cat-cafe', canonicalId: 'cat-cafe' },
      { id: '230809_cat-cafe-runtime', canonicalId: 'cat-cafe-runtime' },
    ];
    const aliases = buildWorktreeAliasMap(worktrees);

    expect(hasEquivalentWorktreeId(worktrees, 'cat-cafe', aliases)).toBe(true);
    expect(hasEquivalentWorktreeId(worktrees, '230809_cat-cafe', aliases)).toBe(true);
    expect(hasEquivalentWorktreeId(worktrees, 'missing', aliases)).toBe(false);
  });

  it('resolves a canonical selection to the listed prefixed alias', () => {
    const worktrees = [
      { id: '230809_cat-cafe', canonicalId: 'cat-cafe' },
      { id: '230809_cat-cafe-runtime', canonicalId: 'cat-cafe-runtime' },
    ];
    const aliases = buildWorktreeAliasMap(worktrees);

    expect(resolveListedWorktreeId(worktrees, 'cat-cafe', aliases)).toBe('230809_cat-cafe');
    expect(resolveListedWorktreeId(worktrees, '230809_cat-cafe', aliases)).toBe('230809_cat-cafe');
    expect(resolveListedWorktreeId(worktrees, 'missing', aliases)).toBeNull();
  });

  it('scopes worktree aliases to the active project path', () => {
    expect(scopeWorktreeAliases(repoRootAliases, '/tmp/project-a', '/tmp/project-a')).toBe(repoRootAliases);
    expect(scopeWorktreeAliases(repoRootAliases, '/tmp/project-a', '/tmp/project-b')).toEqual({});
    expect(scopeWorktreeAliases(repoRootAliases, null, '/tmp/project-a')).toEqual({});
  });
});

describe('shouldAcceptNavigate (threadId-based session isolation)', () => {
  it('accepts when session threadId matches event threadId', () => {
    expect(shouldAcceptNavigate('thread-abc', 'thread-abc')).toBe(true);
  });

  it('rejects when event threadId differs from session threadId', () => {
    expect(shouldAcceptNavigate('thread-abc', 'thread-xyz')).toBe(false);
  });

  it('accepts when event has no threadId (legacy/global)', () => {
    expect(shouldAcceptNavigate('thread-abc', undefined)).toBe(true);
  });

  it('accepts when session has no threadId', () => {
    expect(shouldAcceptNavigate(null, 'thread-abc')).toBe(true);
  });

  it('accepts when neither has threadId', () => {
    expect(shouldAcceptNavigate(null, undefined)).toBe(true);
  });
});

describe('handleNavigateEvent (reveal + worktree switching)', () => {
  it('switches worktree before reveal when target differs from current', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const result = handleNavigateEvent({ path: 'packages/api/data/logs/', worktreeId: 'runtime' }, 'main-wt', actions);

    expect(result).toBe(true);
    expect(actions.setWorkspaceWorktreeId).toHaveBeenCalledWith('runtime');
    expect(actions.setWorkspaceRevealPath).toHaveBeenCalledWith('packages/api/data/logs/');
    expect(actions.setWorkspaceOpenFile).not.toHaveBeenCalled();
  });

  it('does not switch worktree for reveal when target matches current', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    handleNavigateEvent({ path: 'docs/README.md', worktreeId: 'same-wt' }, 'same-wt', actions);

    expect(actions.setWorkspaceWorktreeId).not.toHaveBeenCalled();
    expect(actions.setWorkspaceRevealPath).toHaveBeenCalledWith('docs/README.md');
  });

  it('does not switch worktree for reveal when target is the canonical alias of current', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const result = handleNavigateEvent(
      { path: 'docs/README.md', worktreeId: 'cat-cafe' },
      '230809_cat-cafe',
      actions,
      undefined,
      undefined,
      repoRootAliases,
    );

    expect(result).toBe(true);
    expect(actions.setWorkspaceWorktreeId).not.toHaveBeenCalled();
    expect(actions.setWorkspaceRevealPath).toHaveBeenCalledWith('docs/README.md');
  });

  it('delegates to setWorkspaceOpenFile for action=open', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const result = handleNavigateEvent(
      { path: 'src/index.ts', worktreeId: 'wt-1', action: 'open', line: 42 },
      'wt-2',
      actions,
    );

    expect(result).toBe(true);
    expect(actions.setWorkspaceOpenFile).toHaveBeenCalledWith('src/index.ts', 42, 'wt-1');
    expect(actions.setWorkspaceWorktreeId).not.toHaveBeenCalled();
    expect(actions.setWorkspaceRevealPath).not.toHaveBeenCalled();
  });

  it('delegates open events with current worktree alias when event carries canonical id', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const result = handleNavigateEvent(
      { path: 'docs/study.md', worktreeId: 'cat-cafe', action: 'open', line: 7 },
      '230809_cat-cafe',
      actions,
      undefined,
      undefined,
      repoRootAliases,
    );

    expect(result).toBe(true);
    expect(actions.setWorkspaceOpenFile).toHaveBeenCalledWith('docs/study.md', 7, '230809_cat-cafe');
    expect(actions.setWorkspaceWorktreeId).not.toHaveBeenCalled();
  });

  it('handles reveal without worktreeId (no switch needed)', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    handleNavigateEvent({ path: 'docs/README.md' }, null, actions);

    expect(actions.setWorkspaceWorktreeId).not.toHaveBeenCalled();
    expect(actions.setWorkspaceRevealPath).toHaveBeenCalledWith('docs/README.md');
  });
});

describe('handleNavigateEvent grace period (open→reveal suppression)', () => {
  it('suppresses reveal for same path+worktree within grace window after open', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const recentOpen = { path: 'src/index.ts', worktreeId: 'wt-1', ts: Date.now() - 500 };
    const result = handleNavigateEvent({ path: 'src/index.ts', worktreeId: 'wt-1' }, 'wt-1', actions, recentOpen);

    expect(result).toBe(false);
    expect(actions.setWorkspaceRevealPath).not.toHaveBeenCalled();
    expect(actions.setWorkspaceWorktreeId).not.toHaveBeenCalled();
  });

  it('allows reveal for different path even within grace window', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const recentOpen = { path: 'src/index.ts', worktreeId: 'wt-1', ts: Date.now() - 500 };
    const result = handleNavigateEvent({ path: 'src/other.ts' }, 'wt-1', actions, recentOpen);

    expect(result).toBe(true);
    expect(actions.setWorkspaceRevealPath).toHaveBeenCalledWith('src/other.ts');
  });

  it('allows reveal for same path but different worktree within grace window', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const recentOpen = { path: 'docs/README.md', worktreeId: 'wt-A', ts: Date.now() - 500 };
    const result = handleNavigateEvent({ path: 'docs/README.md', worktreeId: 'wt-B' }, 'wt-A', actions, recentOpen);

    expect(result).toBe(true);
    expect(actions.setWorkspaceWorktreeId).toHaveBeenCalledWith('wt-B');
    expect(actions.setWorkspaceRevealPath).toHaveBeenCalledWith('docs/README.md');
  });

  it('suppresses reveal for equivalent worktree aliases within grace window', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const recentOpen = { path: 'docs/study.md', worktreeId: '230809_cat-cafe', ts: Date.now() - 500 };
    const result = handleNavigateEvent(
      { path: 'docs/study.md', worktreeId: 'cat-cafe' },
      '230809_cat-cafe',
      actions,
      recentOpen,
      undefined,
      repoRootAliases,
    );

    expect(result).toBe(false);
    expect(actions.setWorkspaceRevealPath).not.toHaveBeenCalled();
    expect(actions.setWorkspaceWorktreeId).not.toHaveBeenCalled();
  });

  it('allows reveal for same path after grace window expires', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const recentOpen = { path: 'src/index.ts', worktreeId: 'wt-1', ts: Date.now() - 3000 };
    const result = handleNavigateEvent({ path: 'src/index.ts', worktreeId: 'wt-1' }, 'wt-1', actions, recentOpen);

    expect(result).toBe(true);
    expect(actions.setWorkspaceRevealPath).toHaveBeenCalledWith('src/index.ts');
  });

  it('allows reveal when no recent open exists', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const result = handleNavigateEvent({ path: 'src/index.ts' }, 'wt-1', actions, null);

    expect(result).toBe(true);
    expect(actions.setWorkspaceRevealPath).toHaveBeenCalledWith('src/index.ts');
  });

  it('open events are never suppressed by grace window', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    const recentOpen = { path: 'src/index.ts', worktreeId: 'wt-1', ts: Date.now() - 100 };
    const result = handleNavigateEvent({ path: 'src/index.ts', action: 'open', line: 10 }, 'wt-1', actions, recentOpen);

    expect(result).toBe(true);
    expect(actions.setWorkspaceOpenFile).toHaveBeenCalledWith('src/index.ts', 10, null);
  });
});
