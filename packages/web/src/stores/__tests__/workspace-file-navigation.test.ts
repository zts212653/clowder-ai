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
});
