import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleNavigateEvent, shouldAcceptNavigate } from '@/hooks/useWorkspaceNavigate';
import { useChatStore } from '@/stores/chatStore';

describe('workspace navigate store (F131)', () => {
  afterEach(() => {
    useChatStore.setState({
      workspaceRevealPath: null,
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      rightPanelMode: 'status',
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

describe('handleNavigateEvent (P2-1: reveal + worktree switching)', () => {
  it('switches worktree before reveal when target differs from current', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    handleNavigateEvent({ path: 'packages/api/data/logs/', worktreeId: 'runtime' }, 'main-wt', actions);

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

  it('delegates to setWorkspaceOpenFile for action=open', () => {
    const actions = {
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceRevealPath: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    };

    handleNavigateEvent({ path: 'src/index.ts', worktreeId: 'wt-1', action: 'open', line: 42 }, 'wt-2', actions);

    expect(actions.setWorkspaceOpenFile).toHaveBeenCalledWith('src/index.ts', 42, 'wt-1');
    expect(actions.setWorkspaceWorktreeId).not.toHaveBeenCalled();
    expect(actions.setWorkspaceRevealPath).not.toHaveBeenCalled();
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
