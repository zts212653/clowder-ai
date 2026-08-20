import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

/**
 * F120 × F284: Browser Preview per-thread restore.
 *
 * RED — today ThreadState only carries worktree/tabs/file; workspaceSurface,
 * workspacePreview and rightPanelMode are flat-only, so leaving a thread and
 * returning loses (or leaks) the browser preview.
 */
describe('browser preview per-thread restore (F120 × F284)', () => {
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
      workspaceWorktreeId: null,
      workspaceOpenTabs: [],
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      presentationLock: null,
      workspaceSurface: 'home',
      workspacePreview: { port: undefined, path: '/' },
      rightPanelMode: 'status',
      pendingPreviewAutoOpen: null,
    });
  });

  it('restores browser surface + preview + panel when returning to a thread', () => {
    // Cat auto-opens a preview on thread-a
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5173, path: '/dash' });
    expect(useChatStore.getState().workspaceSurface).toBe('browser');
    expect(useChatStore.getState().workspacePreview).toEqual({ port: 5173, path: '/dash' });
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');

    // Leave for thread-b — thread-a's preview must not leak into thread-b
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceSurface).toBe('home');
    expect(useChatStore.getState().workspacePreview).toEqual({ port: undefined, path: '/' });
    expect(useChatStore.getState().rightPanelMode).toBe('status');

    // Return to thread-a — preview, surface and panel visibility are restored
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().workspaceSurface).toBe('browser');
    expect(useChatStore.getState().workspacePreview).toEqual({ port: 5173, path: '/dash' });
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');
  });

  it('restores a folded panel as folded while keeping the browser surface', () => {
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5173, path: '/' });
    // User folds the panel (explicit close exits workspace mode)
    useChatStore.getState().closeRightPanel();
    expect(useChatStore.getState().rightPanelMode).toBe('status');
    expect(useChatStore.getState().workspaceSurface).toBe('browser');

    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().setCurrentThread('thread-a');

    // Surface + preview survive; panel stays folded as the user left it
    expect(useChatStore.getState().workspaceSurface).toBe('browser');
    expect(useChatStore.getState().workspacePreview).toEqual({ port: 5173, path: '/' });
    expect(useChatStore.getState().rightPanelMode).toBe('status');
  });

  it('queueThreadPreview writes browser preview into an inactive thread and reveals it on return', () => {
    useChatStore.getState().queueThreadPreview('thread-b', { port: 3000, path: '/settings' });

    // Active thread is untouched
    expect(useChatStore.getState().currentThreadId).toBe('thread-a');
    expect(useChatStore.getState().workspaceSurface).toBe('home');
    expect(useChatStore.getState().rightPanelMode).toBe('status');

    // Returning to thread-b reveals the queued preview with the panel open
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceSurface).toBe('browser');
    expect(useChatStore.getState().workspacePreview).toEqual({ port: 3000, path: '/settings' });
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');
  });

  it('presentation lock: thread switch keeps the locked view instead of restoring target surface', () => {
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5173, path: '/' });
    useChatStore.getState().enablePresentationLock();

    useChatStore.getState().setCurrentThread('thread-b');
    // Visible workspace stays the locked browser preview, not thread-b's (empty) state
    expect(useChatStore.getState().workspaceSurface).toBe('browser');
    expect(useChatStore.getState().workspacePreview).toEqual({ port: 5173, path: '/' });
  });

  it('presentation lock: locked surface does not pollute other threads saved state', () => {
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5173, path: '/' });
    useChatStore.getState().enablePresentationLock();

    // Visit thread-b and leave again while locked
    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().setCurrentThread('thread-c');

    const savedB = useChatStore.getState().threadStates['thread-b'];
    expect(savedB).toBeDefined();
    expect(savedB?.workspaceSurface).toBe('home');
    expect(savedB?.workspacePreview).toEqual({ port: undefined, path: '/' });
    expect(savedB?.rightPanelMode).toBe('status');
  });

  it('presentation lock: unlock on a non-owner thread restores that thread surface/preview/panel', () => {
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5173, path: '/' });
    useChatStore.getState().enablePresentationLock();

    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().disablePresentationLock();

    // thread-b never opened a preview — the lock view must not linger
    expect(useChatStore.getState().workspaceSurface).toBe('home');
    expect(useChatStore.getState().workspacePreview).toEqual({ port: undefined, path: '/' });
    expect(useChatStore.getState().rightPanelMode).toBe('status');
  });
});

describe('panel visibility per thread (F284 review P1-2)', () => {
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
      presentationLock: null,
      workspaceSurface: 'home',
      workspacePreview: { port: undefined, path: '/' },
      rightPanelMode: 'status',
      rightPanelOpen: false,
      pendingPreviewAutoOpen: null,
    });
  });

  it('A-open → B-closed → A-restored: panel visibility is canonical per-thread', () => {
    // Thread A: cat auto-open reveals the panel
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5173, path: '/' });
    expect(useChatStore.getState().rightPanelOpen).toBe(true);
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');

    // Thread B never opened the panel — visibility must not leak
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().rightPanelOpen).toBe(false);
    expect(useChatStore.getState().rightPanelMode).toBe('status');

    // Back to A — panel reopens with the preview
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().rightPanelOpen).toBe(true);
    expect(useChatStore.getState().workspaceSurface).toBe('browser');
  });

  it('visible Status panel ≠ folded: open state survives independent of mode', () => {
    // Thread A: user views the status panel (mode=status, panel open)
    useChatStore.getState().setRightPanelOpen(true);
    expect(useChatStore.getState().rightPanelMode).toBe('status');

    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().rightPanelOpen).toBe(false);

    // Back to A — status panel visible again, still in status mode
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().rightPanelOpen).toBe(true);
    expect(useChatStore.getState().rightPanelMode).toBe('status');
  });

  it('closeRightPanel closes canonical visibility; switch restores closed', () => {
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5173, path: '/' });
    useChatStore.getState().closeRightPanel();
    expect(useChatStore.getState().rightPanelOpen).toBe(false);
    expect(useChatStore.getState().rightPanelMode).toBe('status');

    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState().rightPanelOpen).toBe(false);
    // surface/preview survive the fold
    expect(useChatStore.getState().workspaceSurface).toBe('browser');
    expect(useChatStore.getState().workspacePreview).toEqual({ port: 5173, path: '/' });
  });

  it('queueThreadPreview reveals the panel when returning to the target thread', () => {
    useChatStore.getState().queueThreadPreview('thread-b', { port: 3000, path: '/' });
    expect(useChatStore.getState().rightPanelOpen).toBe(false);

    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().rightPanelOpen).toBe(true);
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');
    expect(useChatStore.getState().workspaceSurface).toBe('browser');
  });
});
