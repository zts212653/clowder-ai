import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

describe('F284 Files navigation hierarchy', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentThreadId: 'thread-files',
      currentProjectPath: '/tmp/project',
      threadStates: {},
      workspaceWorktreeId: 'wt-main',
      workspaceOpenTabs: [],
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceSurface: 'home',
      rightPanelMode: 'status',
      presentationLock: null,
    });
  });

  it('opens a file as a detail inside Files instead of replacing Files', () => {
    useChatStore.getState().setWorkspaceOpenFile('docs/guide.md', 12);

    expect(useChatStore.getState()).toMatchObject({
      workspaceSurface: 'files',
      rightPanelMode: 'workspace',
      workspaceOpenFilePath: 'docs/guide.md',
      workspaceOpenFileLine: 12,
    });
  });

  it('returns to the file tree after the final detail tab closes', () => {
    useChatStore.getState().setWorkspaceOpenFile('docs/guide.md');
    useChatStore.getState().closeWorkspaceTab('docs/guide.md');

    expect(useChatStore.getState()).toMatchObject({
      workspaceSurface: 'files',
      workspaceOpenTabs: [],
      workspaceOpenFilePath: null,
    });
  });

  it('keeps Files active when an explicit navigation clears the current file', () => {
    useChatStore.getState().setWorkspaceOpenFile('docs/guide.md');
    useChatStore.getState().setWorkspaceOpenFile(null);

    expect(useChatStore.getState().workspaceSurface).toBe('files');
  });

  describe('one navigation revision for every explicit Workspace navigation', () => {
    // Anything that ties itself to "the navigation I made" (a receipt's candidate ask) can only retire when a later
    // navigation is visible as a later revision, so opening a file the ordinary way has to advance it too.
    beforeEach(() => {
      useChatStore.setState({ workspaceOpenRevision: 7, workspaceOpenRequest: null });
    });

    it('advances when an ordinary file link or search result opens a file in the same worktree', () => {
      useChatStore.getState().setWorkspaceOpenFile('docs/guide.md', 3);
      expect(useChatStore.getState().workspaceOpenRevision).toBe(8);
      useChatStore.getState().setWorkspaceOpenFile('docs/other.md');
      expect(useChatStore.getState().workspaceOpenRevision).toBe(9);
    });

    it('advances when the file lives in another worktree', () => {
      useChatStore.getState().setWorkspaceOpenFile('docs/guide.md', null, 'wt-other');
      expect(useChatStore.getState().workspaceOpenRevision).toBe(8);
      expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-other');
    });

    it('advances together with an explicit open request, never backwards', () => {
      useChatStore.getState().setWorkspaceOpenFile('docs/guide.md');
      expect(
        useChatStore
          .getState()
          .openWorkspacePath('thread-files', { kind: 'file', worktreeId: 'wt-main', path: 'a.md' }),
      ).toBe(true);
      expect(useChatStore.getState().workspaceOpenRevision).toBe(9);
      expect(useChatStore.getState().workspaceOpenRequest?.revision).toBe(9);
      useChatStore.getState().setWorkspaceOpenFile('b.md');
      expect(useChatStore.getState().workspaceOpenRevision).toBe(10);
    });

    it('retires an earlier open request that the Workbench has not consumed yet, so it cannot reopen the old file later', () => {
      // Pending request for A (the Workbench is not hydrated or mounted yet) ...
      useChatStore.getState().openWorkspacePath('thread-files', { kind: 'file', worktreeId: 'wt-main', path: 'a.md' });
      expect(useChatStore.getState().workspaceOpenRequest?.revision).toBe(8);
      // ... then the person opens B the ordinary way: the newest explicit navigation wins, atomically.
      useChatStore.getState().setWorkspaceOpenFile('b.md');
      expect(useChatStore.getState().workspaceOpenRevision).toBe(9);
      expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
      expect(useChatStore.getState().workspaceOpenFilePath).toBe('b.md');
    });

    it('retires the earlier request when the ordinary navigation switches worktree too', () => {
      useChatStore.getState().openWorkspacePath('thread-files', { kind: 'file', worktreeId: 'wt-main', path: 'a.md' });
      useChatStore.getState().setWorkspaceOpenFile('b.md', null, 'wt-other');
      expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
      expect(useChatStore.getState().workspaceOpenRevision).toBe(9);
    });

    it('keeps the newest request when an explicit open comes after the ordinary navigation', () => {
      useChatStore.getState().setWorkspaceOpenFile('b.md');
      useChatStore.getState().openWorkspacePath('thread-files', { kind: 'file', worktreeId: 'wt-main', path: 'c.md' });
      expect(useChatStore.getState().workspaceOpenRequest).toMatchObject({ revision: 9, target: { path: 'c.md' } });
    });

    it('leaves a pending request alone when the file is merely cleared', () => {
      useChatStore.getState().openWorkspacePath('thread-files', { kind: 'file', worktreeId: 'wt-main', path: 'a.md' });
      useChatStore.getState().setWorkspaceOpenFile(null);
      expect(useChatStore.getState().workspaceOpenRequest?.revision).toBe(8);
    });

    it('does not move for clearing the current file, and a refused open request leaves it alone', () => {
      useChatStore.getState().setWorkspaceOpenFile(null);
      expect(useChatStore.getState().workspaceOpenRevision).toBe(7);
      expect(
        useChatStore
          .getState()
          .openWorkspacePath('another-thread', { kind: 'file', worktreeId: 'wt-main', path: 'a.md' }),
      ).toBe(false);
      expect(useChatStore.getState().workspaceOpenRevision).toBe(7);
    });
  });
});
