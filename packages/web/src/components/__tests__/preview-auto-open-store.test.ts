import { afterEach, describe, expect, it } from 'vitest';
import { shouldAcceptAutoOpen } from '@/hooks/usePreviewAutoOpen';
import { useChatStore } from '@/stores/chatStore';

describe('preview auto-open store', () => {
  afterEach(() => {
    // Reset store between tests
    useChatStore.setState({
      pendingPreviewAutoOpen: null,
      rightPanelMode: 'status',
    });
  });

  it('pendingPreviewAutoOpen defaults to null', () => {
    const state = useChatStore.getState();
    expect(state.pendingPreviewAutoOpen).toBeNull();
  });

  it('setPendingPreviewAutoOpen stores port and path', () => {
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5173, path: '/about' });
    const state = useChatStore.getState();
    expect(state.pendingPreviewAutoOpen).toEqual({ port: 5173, path: '/about' });
  });

  it('setPendingPreviewAutoOpen switches rightPanelMode to workspace', () => {
    useChatStore.setState({ rightPanelMode: 'status' });
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5173, path: '/' });
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');
  });

  it('consumePreviewAutoOpen returns and clears pending', () => {
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 3000, path: '/home' });
    const consumed = useChatStore.getState().consumePreviewAutoOpen();
    expect(consumed).toEqual({ port: 3000, path: '/home' });
    expect(useChatStore.getState().pendingPreviewAutoOpen).toBeNull();
  });

  it('consumePreviewAutoOpen returns null when nothing pending', () => {
    const consumed = useChatStore.getState().consumePreviewAutoOpen();
    expect(consumed).toBeNull();
  });
});

describe('shouldAcceptAutoOpen (room scope filter)', () => {
  // Session HAS worktreeId → accept exact match or global, reject other worktrees
  it('accepts when session worktreeId matches event worktreeId', () => {
    expect(shouldAcceptAutoOpen('wt-123', 'wt-123', 'thread-a', 'thread-a')).toBe(true);
  });

  it('rejects when session has worktreeId but event has different worktreeId', () => {
    expect(shouldAcceptAutoOpen('wt-123', 'wt-456', 'thread-a', 'thread-a')).toBe(false);
  });

  it('accepts global event when session has worktreeId (cat may omit worktreeId)', () => {
    expect(shouldAcceptAutoOpen('wt-123', undefined, 'thread-a', 'thread-a')).toBe(true);
  });

  it('rejects global event from a different thread even when worktree is omitted', () => {
    expect(shouldAcceptAutoOpen('wt-123', undefined, 'thread-a', 'thread-b')).toBe(false);
  });

  // Session has NO worktreeId → accept global only
  it('accepts global event when session has no worktreeId', () => {
    expect(shouldAcceptAutoOpen(null, undefined, 'thread-a', undefined)).toBe(true);
  });

  it('rejects worktree-scoped event when session has no worktreeId', () => {
    expect(shouldAcceptAutoOpen(null, 'wt-123', 'thread-a', 'thread-a')).toBe(false);
  });

  it('accepts global event when threadId matches', () => {
    expect(shouldAcceptAutoOpen(null, undefined, 'thread-a', 'thread-a')).toBe(true);
  });

  it('rejects global event when threadId differs', () => {
    expect(shouldAcceptAutoOpen(null, undefined, 'thread-a', 'thread-b')).toBe(false);
  });
});
