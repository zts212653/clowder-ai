import { describe, expect, it } from 'vitest';
import { restoreWorkbenchState } from '@/components/workbench/workbench-model';
import { workspaceHomeDestinationToSurface } from '../workspace-home-adapter';

describe('F307 canonical Workspace Home adapter', () => {
  it('opens Capability Evolution as one owner-backed workspace, not as a copied Program', () => {
    const surface = workspaceHomeDestinationToSurface(
      {
        kind: 'workspace',
        id: 'capability-evolution',
        label: '能力进化',
        description: '让猫猫与系统持续变得更好',
        searchTerms: 'capability evolution 能力 进化',
      },
      { threadId: 'thread-f311', worktreeId: null, openFilePath: null, preview: { path: '/' } },
    );

    expect(surface).toMatchObject({
      id: 'workspace:capability-evolution',
      type: 'workspace',
      renderer: 'workspace-destination',
      objectRef: { kind: 'workspace-destination', id: 'workspace:capability-evolution' },
      ownerStateRef: { owner: 'f311-capability-evolution-control', key: 'workspace' },
      resultTargetRef: { owner: 'f311-capability-evolution-control', key: 'thread-f311' },
    });
    expect(surface).not.toHaveProperty('program');
  });

  it('turns a canonical mode selection into a restorable owner-backed descriptor', () => {
    const surface = workspaceHomeDestinationToSurface(
      {
        kind: 'mode',
        id: 'tasks',
        label: '任务',
        description: '管理任务与待办',
        searchTerms: 'tasks 任务 待办',
      },
      { threadId: 'thread-f307', worktreeId: 'worktree-main', openFilePath: null, preview: { path: '/' } },
    );

    expect(surface).toEqual(
      expect.objectContaining({
        id: 'workspace:mode:tasks',
        type: 'workspace',
        renderer: 'workspace-destination',
        ownerStateRef: { owner: 'f284-workspace-launcher', key: 'mode:tasks' },
        resultTargetRef: { owner: 'f284-workspace-launcher', key: 'thread-f307:mode:tasks' },
      }),
    );

    const restored = restoreWorkbenchState({
      schemaVersion: 1,
      layoutOwner: 'f307',
      surfaces: [surface],
      activeSurfaceId: surface?.id,
      split: null,
      recentlyClosed: [],
      activity: [],
    });
    expect(restored.surfaces).toEqual([surface]);
    expect(restored.activeSurfaceId).toBe(surface?.id);
  });

  it('mounts Status inside the Workbench instead of escaping to the legacy sibling host', () => {
    expect(
      workspaceHomeDestinationToSurface(
        {
          kind: 'host',
          id: 'status',
          label: '状态与会话',
          description: '查看运行详情',
          searchTerms: 'status session',
        },
        { threadId: 'thread-f307', worktreeId: null, openFilePath: null, preview: { path: '/' } },
      ),
    ).toMatchObject({
      id: 'workspace:host:status',
      type: 'workspace',
      renderer: 'workspace-destination',
      objectRef: { kind: 'workspace-destination', id: 'host:status' },
      ownerStateRef: { owner: 'f284-workspace-launcher', key: 'host:status' },
      resultTargetRef: { owner: 'f284-workspace-launcher', key: 'thread-f307:host:status' },
    });
  });

  it('binds Changes to the Home-selected worktree and fails closed without one', () => {
    const destination = {
      kind: 'surface' as const,
      id: 'changes' as const,
      label: '变更',
      description: '看看这次改了什么',
      searchTerms: 'changes diff',
    };

    expect(
      workspaceHomeDestinationToSurface(destination, {
        threadId: 'thread-a',
        worktreeId: 'worktree-a',
        openFilePath: null,
        preview: { path: '/' },
      }),
    ).toMatchObject({
      id: 'workspace:surface:changes:worktree-a',
      ownerStateRef: { owner: 'f063-workspace-diff', key: 'worktree-a' },
      resultTargetRef: {
        owner: 'f063-workspace-diff',
        key: encodeURIComponent(JSON.stringify(['worktree-a', 'thread-a'])),
      },
    });

    expect(
      workspaceHomeDestinationToSurface(destination, {
        threadId: 'thread-a',
        worktreeId: null,
        openFilePath: null,
        preview: { path: '/' },
      }),
    ).toBeNull();
  });

  it('opens the exact F063 file-tree owner when Home has no preselected file', () => {
    const destination = {
      kind: 'surface' as const,
      id: 'files' as const,
      label: '文件与代码',
      description: '浏览与打开工作区文件',
      searchTerms: 'files tree source',
    };

    expect(
      workspaceHomeDestinationToSurface(destination, {
        threadId: 'thread-a',
        worktreeId: 'worktree-a',
        openFilePath: null,
        preview: { path: '/' },
      }),
    ).toMatchObject({
      id: 'workspace:surface:files:worktree-a',
      renderer: 'workspace-destination',
      objectRef: { kind: 'workspace-destination', id: 'surface:files' },
      ownerStateRef: { owner: 'f063-workspace-tree', key: 'worktree-a' },
      resultTargetRef: { owner: 'f063-workspace-tree', key: 'worktree-a' },
    });

    expect(
      workspaceHomeDestinationToSurface(destination, {
        threadId: 'thread-a',
        worktreeId: null,
        openFilePath: null,
        preview: { path: '/' },
      }),
    ).toBeNull();
  });

  it('does not invent a generic Terminal surface before its worktree owner is known', () => {
    expect(
      workspaceHomeDestinationToSurface(
        {
          kind: 'surface',
          id: 'terminal',
          label: '终端',
          description: '回到当前 worktree 会话',
          searchTerms: 'terminal shell',
        },
        { threadId: 'thread-a', worktreeId: null, openFilePath: null, preview: { path: '/' } },
      ),
    ).toBeNull();
  });
});
