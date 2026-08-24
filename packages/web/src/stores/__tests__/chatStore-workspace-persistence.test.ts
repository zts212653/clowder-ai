import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _closeDBForTest, loadThreadWorkspaceState } from '@/utils/offline-store';
import { useChatStore } from '../chatStore';

describe('workspace state write-through persistence', () => {
  beforeEach(async () => {
    await _closeDBForTest();
    useChatStore.setState({
      currentThreadId: 'thread-persist-preview',
      threadStates: {},
      presentationLock: null,
      workspaceWorktreeId: 'wt-persist',
      workspaceSurface: 'home',
      workspacePreview: { port: undefined, path: '/' },
      rightPanelMode: 'status',
      rightPanelOpen: false,
    });
  });

  it('writes the active preview context without waiting for a thread switch', async () => {
    useChatStore.getState().setPendingPreviewAutoOpen({ port: 5196, path: '/dev/monthly-cat-atlas' });

    await vi.waitFor(async () => {
      await expect(loadThreadWorkspaceState('thread-persist-preview')).resolves.toMatchObject({
        workspaceWorktreeId: 'wt-persist',
        workspaceSurface: 'browser',
        workspacePreview: { port: 5196, path: '/dev/monthly-cat-atlas' },
        rightPanelMode: 'workspace',
        rightPanelOpen: true,
      });
    });
  });
});
