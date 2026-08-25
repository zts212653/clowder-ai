import { beforeEach, describe, expect, it } from 'vitest';
import { captureThreadWorkspaceState, hydrateThreadWorkspaceState, useChatStore } from '../chatStore';

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
      workspaceMode: 'dev',
      workspaceSurface: 'home',
      workspacePreview: { port: undefined, path: '/' },
      rightPanelMode: 'status',
      rightPanelOpen: false,
      pendingPreviewAutoOpen: null,
    });
  });

  it('leaves Approval history and reveals the Browser surface before acknowledging an active-thread preview', () => {
    useChatStore.setState({ workspaceMode: 'approval' });

    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5197, path: '/f120-delivery-probe' });

    expect(useChatStore.getState()).toMatchObject({
      workspaceMode: 'dev',
      workspaceSurface: 'browser',
      workspacePreview: { port: 5197, path: '/f120-delivery-probe' },
      rightPanelMode: 'workspace',
      rightPanelOpen: true,
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
    useChatStore.setState({ workspaceMode: 'approval' });
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
    expect(useChatStore.getState().workspaceMode).toBe('dev');
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

  it('hydrates the durable preview snapshot into the active thread after F5', () => {
    useChatStore.setState({ workspaceMode: 'approval' });
    const expected = captureThreadWorkspaceState(useChatStore.getState(), 'thread-a');
    const snapshot = {
      revision: expected.revision + 1,
      workspaceWorktreeId: 'wt-a',
      workspaceMode: 'dev',
      workspaceSurface: 'browser',
      workspacePreview: { port: 5196, path: '/dev/monthly-cat-atlas' },
      rightPanelMode: 'workspace',
      rightPanelOpen: true,
    } satisfies Parameters<typeof hydrateThreadWorkspaceState>[1];

    expect(hydrateThreadWorkspaceState('thread-a', snapshot, expected)).toBe(true);

    const restored = useChatStore.getState();
    expect(restored.workspaceWorktreeId).toBe('wt-a');
    expect(restored.workspaceMode).toBe('dev');
    expect(restored.workspaceSurface).toBe('browser');
    expect(restored.workspacePreview).toEqual({ port: 5196, path: '/dev/monthly-cat-atlas' });
    expect(restored.rightPanelMode).toBe('workspace');
    expect(restored.rightPanelOpen).toBe(true);
  });

  it('does not let a stale IDB snapshot overwrite a newer live preview event', () => {
    const expected = captureThreadWorkspaceState(useChatStore.getState(), 'thread-a');
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 7001, path: '/newer' });

    expect(
      hydrateThreadWorkspaceState(
        'thread-a',
        {
          revision: expected.revision,
          workspaceWorktreeId: 'wt-old',
          workspaceSurface: 'browser',
          workspacePreview: { port: 5196, path: '/stale' },
          rightPanelMode: 'workspace',
          rightPanelOpen: true,
        },
        expected,
      ),
    ).toBe(false);
    expect(useChatStore.getState().workspacePreview).toEqual({ port: 7001, path: '/newer' });
  });

  it('does not let an older IDB snapshot overwrite a preview queued before hydration started', () => {
    useChatStore.getState().queueThreadPreview('thread-b', { port: 7002, path: '/queued-newer' });
    const expected = captureThreadWorkspaceState(useChatStore.getState(), 'thread-b');

    expect(
      hydrateThreadWorkspaceState(
        'thread-b',
        {
          revision: expected.revision - 1,
          workspaceWorktreeId: null,
          workspaceSurface: 'home',
          workspacePreview: { port: undefined, path: '/' },
          rightPanelMode: 'status',
          rightPanelOpen: false,
        },
        expected,
      ),
    ).toBe(false);

    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspacePreview).toEqual({ port: 7002, path: '/queued-newer' });
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
