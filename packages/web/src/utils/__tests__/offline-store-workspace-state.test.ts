import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetDBForTest, loadThreadWorkspaceState, saveThreadWorkspaceState } from '../offline-store';

describe('preview workspace state survives an F5 reload', () => {
  beforeEach(async () => {
    await _resetDBForTest();
  });

  it('round-trips the exact thread, worktree, renderer, surface, preview and panel state', async () => {
    await saveThreadWorkspaceState('thread-preview', {
      revision: 42,
      workspaceWorktreeId: 'wt-preview',
      workspaceMode: 'dev',
      workspaceSurface: 'browser',
      workspacePreview: { port: 5196, path: '/dev/monthly-cat-atlas?month=2026-08' },
      rightPanelMode: 'workspace',
      rightPanelOpen: true,
    });

    await expect(loadThreadWorkspaceState('thread-preview')).resolves.toEqual({
      revision: 42,
      workspaceWorktreeId: 'wt-preview',
      workspaceMode: 'dev',
      workspaceSurface: 'browser',
      workspacePreview: { port: 5196, path: '/dev/monthly-cat-atlas?month=2026-08' },
      rightPanelMode: 'workspace',
      rightPanelOpen: true,
    });
  });

  it('does not invent workspace state for an unknown thread', async () => {
    await expect(loadThreadWorkspaceState('thread-unknown')).resolves.toBeNull();
  });

  it('rejects an out-of-order async write with an older workspace revision', async () => {
    await saveThreadWorkspaceState('thread-preview', {
      revision: 200,
      workspaceWorktreeId: 'wt-preview',
      workspaceSurface: 'browser',
      workspacePreview: { port: 7002, path: '/newer' },
      rightPanelMode: 'workspace',
      rightPanelOpen: true,
    });
    await saveThreadWorkspaceState('thread-preview', {
      revision: 100,
      workspaceWorktreeId: null,
      workspaceSurface: 'home',
      workspacePreview: { port: undefined, path: '/' },
      rightPanelMode: 'status',
      rightPanelOpen: false,
    });

    await expect(loadThreadWorkspaceState('thread-preview')).resolves.toMatchObject({
      revision: 200,
      workspacePreview: { port: 7002, path: '/newer' },
    });
  });
});
