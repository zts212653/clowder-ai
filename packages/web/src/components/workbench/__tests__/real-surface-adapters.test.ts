import type { ActiveExecutionProjection, GlobalArtifactDTO, ThreadArtifactDTO } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  createAgentRunSurface,
  createArtifactSurface,
  createBrowserSurface,
  createEvolutionProgramSurface,
  createFileSurface,
  createTeamWorkspaceSurface,
  createTerminalSurface,
  createWorkspaceDestinationSurface,
  resolveAgentRunTarget,
  resolveArtifactTarget,
  resolveBrowserTarget,
  resolveChangesTarget,
  resolveEvolutionProgramId,
  resolveFilesTarget,
  resolveFileTarget,
  resolveTeamWorkspaceTarget,
  resolveTerminalWorktreeId,
} from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-model';
import { restoreWorkbenchState } from '../workbench-restore';

describe('F307 real surface adapters', () => {
  it('restores a durable F311 Program by owner ref without copying Program state into layout', () => {
    const programId = `evolution-program:${'a'.repeat(32)}`;
    const surface = createEvolutionProgramSurface(programId);

    expect(surface).toMatchObject({
      id: `evolution-program:${programId}`,
      type: 'evolution-program',
      renderer: 'evolution-program',
      objectRef: { kind: 'evolution-program', id: programId },
      ownerStateRef: { owner: 'f311-capability-evolution-control', key: programId },
      resultTargetRef: { owner: 'f311-capability-evolution-control', key: programId },
    });
    expect(surface).not.toHaveProperty('program');
    expect(resolveEvolutionProgramId(surface)).toBe(programId);
    expect(restoreWorkbenchState(createInitialWorkbenchState([surface])).surfaces).toEqual([surface]);
  });

  it('rejects an owner-consistent descriptor whose Program id is not canonical', () => {
    expect(resolveEvolutionProgramId(createEvolutionProgramSurface('evolution-program:abc'))).toBeNull();
  });
  it('projects one F063 owner surface per worktree while refreshing the exact file target', () => {
    const first = createFileSurface({ worktreeId: 'worktree-main', path: 'README.md' });
    const code = createFileSurface({ worktreeId: 'worktree-main', path: 'packages/web/src/App.tsx' });

    expect(first).toMatchObject({
      id: 'file-owner:worktree-main',
      type: 'file',
      renderer: 'file-preview',
      objectRef: { kind: 'file', id: 'worktree-main' },
      ownerStateRef: { owner: 'f063-workspace-file', key: 'worktree-main' },
      resultTargetRef: { owner: 'f063-workspace-file', key: 'worktree-main:README.md' },
    });
    expect(code).toMatchObject({
      id: first.id,
      type: 'code',
      renderer: 'code-editor',
      objectRef: first.objectRef,
      resultTargetRef: {
        owner: 'f063-workspace-file',
        key: 'worktree-main:packages/web/src/App.tsx',
      },
    });
    expect(resolveFileTarget(first)).toEqual({ worktreeId: 'worktree-main', path: 'README.md', scrollToLine: null });
    expect(resolveFileTarget(code)).toEqual({
      worktreeId: 'worktree-main',
      path: 'packages/web/src/App.tsx',
      scrollToLine: null,
    });

    const searchMatch = createFileSurface({
      worktreeId: 'worktree-main',
      path: 'packages/web/src/App.tsx',
      scrollToLine: 37,
    });
    expect(resolveFileTarget(searchMatch)).toEqual({
      worktreeId: 'worktree-main',
      path: 'packages/web/src/App.tsx',
      scrollToLine: 37,
    });
    expect(restoreWorkbenchState(createInitialWorkbenchState([searchMatch])).surfaces).toEqual([searchMatch]);
  });

  it('keeps Browser and Terminal lifecycle keyed to their real owners', () => {
    const browser = createBrowserSurface({ ownerKey: 'worktree-main', port: 4173, path: '/settings' });
    const terminal = createTerminalSurface({ worktreeId: 'worktree-main' });

    expect(browser).toMatchObject({
      type: 'browser',
      renderer: 'browser-preview',
      objectRef: { kind: 'preview-session', id: 'worktree-main' },
      ownerStateRef: { owner: 'f120-browser-preview', key: 'worktree-main' },
      resultTargetRef: { owner: 'f120-browser-preview', key: '4173:/settings' },
    });
    expect(terminal).toMatchObject({
      type: 'terminal',
      renderer: 'terminal-session',
      ownerStateRef: { owner: 'f089-terminal-session', key: 'worktree-main' },
      resultTargetRef: { owner: 'f089-terminal-session', key: 'worktree-main' },
    });
    expect(resolveTerminalWorktreeId(terminal)).toBe('worktree-main');
    expect(resolveBrowserTarget(browser)).toEqual({ ownerKey: 'worktree-main', port: 4173, path: '/settings' });
  });

  it('keeps Team subject in the F293 owner descriptor and fails malformed deep links closed', () => {
    const detail = createTeamWorkspaceSurface({
      threadId: 'thread-f293',
      subject: { type: 'cat', id: 'codex-sol' },
    });

    expect(detail).toMatchObject({
      id: 'workspace:mode:team:thread-f293',
      objectRef: { kind: 'workspace-destination', id: 'mode:team' },
      ownerStateRef: { owner: 'f293-routing-context', key: 'thread-f293' },
      resultTargetRef: { owner: 'f293-routing-context' },
    });
    expect(resolveTeamWorkspaceTarget(detail)).toEqual({
      threadId: 'thread-f293',
      subject: { type: 'cat', id: 'codex-sol' },
    });
    expect(
      resolveTeamWorkspaceTarget({
        ...detail,
        resultTargetRef: { owner: 'f293-routing-context', key: encodeURIComponent('{"type":"quota_pool","id":"x"}') },
      }),
    ).toBeNull();
  });

  it('persists the exact Changes worktree and review Thread without consulting ambient host state', () => {
    const destination = {
      kind: 'surface' as const,
      id: 'changes' as const,
      label: '变更',
      description: '看看这次改了什么',
      searchTerms: 'changes diff',
    };
    const surface = createWorkspaceDestinationSurface(destination, 'thread-a', 'worktree-a');
    if (!surface) throw new Error('Changes destination requires a persisted worktree owner');

    expect(surface).toMatchObject({
      id: 'workspace:surface:changes:worktree-a',
      objectRef: { kind: 'workspace-destination', id: 'surface:changes' },
      ownerStateRef: { owner: 'f063-workspace-diff', key: 'worktree-a' },
      resultTargetRef: {
        owner: 'f063-workspace-diff',
        key: encodeURIComponent(JSON.stringify(['worktree-a', 'thread-a'])),
      },
    });
    expect(resolveChangesTarget(surface)).toEqual({ worktreeId: 'worktree-a', threadId: 'thread-a' });

    expect(
      resolveChangesTarget({
        ...surface,
        id: 'workspace:surface:changes',
        ownerStateRef: { owner: 'f284-workspace-launcher', key: 'surface:changes' },
        resultTargetRef: { owner: 'f284-workspace-launcher', key: 'thread-a:surface:changes' },
      }),
    ).toBeNull();

    const ambientLegacy = createWorkspaceDestinationSurface(destination, 'thread-a');
    expect(ambientLegacy).toBeNull();

    expect(
      resolveChangesTarget({
        ...surface,
        resultTargetRef: { owner: 'f063-workspace-diff', key: 'worktree-a' },
      }),
    ).toEqual({ worktreeId: 'worktree-a', threadId: null });
  });

  it('persists the exact Files worktree instead of falling back to the ambient Workspace', () => {
    const surface = createWorkspaceDestinationSurface(
      {
        kind: 'surface',
        id: 'files',
        label: '文件与代码',
        description: '浏览与打开工作区文件',
        searchTerms: 'files tree source',
      },
      'thread-a',
      'worktree-a',
    );
    if (!surface) throw new Error('Files destination requires a persisted worktree owner');

    expect(surface).toMatchObject({
      id: 'workspace:surface:files:worktree-a',
      ownerStateRef: { owner: 'f063-workspace-tree', key: 'worktree-a' },
      resultTargetRef: { owner: 'f063-workspace-tree', key: 'worktree-a' },
    });
    expect(resolveFilesTarget(surface)).toEqual({ worktreeId: 'worktree-a' });
  });

  it('uses a global Artifact owner thread instead of the ambient host Thread', () => {
    const artifact: GlobalArtifactDTO = {
      type: 'code',
      name: 'owner-b.ts',
      catId: 'codex-terra',
      createdAt: 1787880000001,
      sourceMessageId: 'message-owner-b',
      ref: 'packages/web/src/owner-b.ts',
      threadId: 'thread-b',
      threadTitle: 'Owner B',
    };

    const surface = createArtifactSurface({ threadId: 'thread-a', artifact });

    expect(surface.ownerStateRef).toEqual({ owner: 'f232-thread-artifacts', key: 'thread-b' });
    expect(surface.resultTargetRef).toEqual({ owner: 'thread-message', key: 'thread-b:message-owner-b' });
    expect(resolveArtifactTarget(surface)).toEqual({ threadId: 'thread-b', artifactId: surface.objectRef.id });
  });

  it('specializes a real PR artifact as Review and resolves the exact source target without copying its record', () => {
    const artifact: ThreadArtifactDTO = {
      type: 'pr',
      name: 'feat(F307): real adapters',
      catId: 'codex-sol',
      createdAt: 1787880000000,
      sourceMessageId: 'message-review-ready',
      ref: 'zts212653/cat-cafe#4030',
    };

    const surface = createArtifactSurface({ threadId: 'thread-f307', artifact });

    expect(surface).toMatchObject({
      type: 'review',
      renderer: 'review-summary',
      ownerStateRef: { owner: 'f232-thread-artifacts', key: 'thread-f307' },
      resultTargetRef: { owner: 'thread-message', key: 'thread-f307:message-review-ready' },
    });
    expect(surface).not.toHaveProperty('artifact');
    expect(resolveArtifactTarget(surface)).toEqual({ threadId: 'thread-f307', artifactId: surface.objectRef.id });
  });

  it('projects a real invocation with an exact Chat result target and reconstructs F299 input', () => {
    const execution: ActiveExecutionProjection = {
      kind: 'live_invocation',
      executionId: 'invocation-f307',
      threadId: 'thread-f307',
      threadTitle: 'F307 Phase C',
      catId: 'codex-sol',
      startedAt: 1787880000000,
      cancelability: { state: 'not_cancelable', reason: 'terminalizing' },
    };
    const surface = createAgentRunSurface({ execution, sourceMessageId: 'message-agent-run' });

    expect(surface).toMatchObject({
      type: 'agent-run',
      renderer: 'agent-run',
      objectRef: { kind: 'agent-run', id: 'invocation-f307' },
      ownerStateRef: { owner: 'f299-invocation-trajectory', key: 'thread-f307:invocation-f307' },
      resultTargetRef: { owner: 'thread-message', key: 'thread-f307:message-agent-run' },
    });
    expect(surface).not.toHaveProperty('execution');
    expect(resolveAgentRunTarget(surface)).toEqual({
      invocationId: 'invocation-f307',
      threadId: 'thread-f307',
      originRef: {
        kind: 'message',
        threadId: 'thread-f307',
        messageId: 'message-agent-run',
        viewportOffsetPx: 0,
      },
    });
  });
});
