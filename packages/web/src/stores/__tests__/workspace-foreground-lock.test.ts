import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserSurface, createFileSurface } from '@/components/workbench/real-surface-adapters';
import { DEFAULT_THREAD_STATE, useChatStore } from '../chatStore';

const file = createFileSurface({ worktreeId: 'worktree-a', path: 'README.md', scrollToLine: 12 });
const browser = createBrowserSurface({ ownerKey: 'worktree-b', port: 5324, path: '/browser-owner-probe' });
const visible = {
  surfaceId: file.id,
  worktreeId: 'worktree-a',
  filePath: 'README.md',
  line: 12,
  tabs: ['README.md'],
  scrollTop: 320,
};

beforeEach(() => {
  useChatStore.setState({
    currentThreadId: 'thread-a',
    threadStates: {
      'thread-b': {
        ...DEFAULT_THREAD_STATE,
        workspaceForegroundSurfaceId: browser.id,
        workspaceSurface: 'browser',
        workspacePreview: { port: 5324, path: '/browser-owner-probe' },
        workspaceWorktreeId: 'worktree-b',
        rightPanelMode: 'workspace',
        rightPanelOpen: true,
      },
    },
    workspaceForegroundSurfaceId: file.id,
    workspaceWorktreeId: 'legacy-worktree',
    workspaceOpenFilePath: 'stale-legacy.md',
    workspaceOpenFileLine: 1,
    workspaceOpenTabs: ['stale-legacy.md'],
    presentationLock: null,
    workspaceScrollTop: null,
  });
});

describe('original Workspace foreground reference and presentation lock', () => {
  it('captures the actual displayed owner and viewport rather than unrelated legacy file fields', () => {
    useChatStore.getState().enablePresentationLock(visible);
    expect(useChatStore.getState().presentationLock).toMatchObject(visible);
    expect(useChatStore.getState().presentationLock?.ownerWorkspace.workspaceForegroundSurfaceId).toBe(file.id);
  });

  it('keeps the locked reference on thread switch, then restores the current conversation reference on unlock', () => {
    useChatStore.getState().enablePresentationLock(visible);
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe(file.id);
    useChatStore.getState().disablePresentationLock();
    expect(useChatStore.getState().workspaceForegroundSurfaceId).toBe(browser.id);
    expect(useChatStore.getState().workspacePreview).toEqual({ port: 5324, path: '/browser-owner-probe' });
  });

  it('does not save the locked owner reference into another conversation', () => {
    useChatStore.getState().enablePresentationLock(visible);
    useChatStore.getState().setCurrentThread('thread-b');
    useChatStore.getState().setCurrentThread('thread-c');
    expect(useChatStore.getState().threadStates['thread-b'].workspaceForegroundSurfaceId).toBe(browser.id);
    expect(useChatStore.getState().threadStates['thread-a'].workspaceForegroundSurfaceId).toBe(file.id);
    useChatStore.getState().disablePresentationLock();
    expect(useChatStore.getState().workspaceForegroundSurfaceId).toBeNull();
  });
});
