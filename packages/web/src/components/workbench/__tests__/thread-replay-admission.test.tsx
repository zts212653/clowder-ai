import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { isArtifactWorkSurface } from '../artifact-work-presentation';
import { F307OwnerSurfaceRenderer } from '../F307OwnerSurfaceRenderer';
import { createThreadReplaySurface } from '../thread-replay-surface';
import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import { createInitialWorkbenchState } from '../workbench-initial-state';
import { restoreWorkbenchState } from '../workbench-restore';
import { workspaceHomeDestinationToSurface } from '../workspace-home-adapter';

vi.mock('@/components/story-player/TheaterReplayContent', () => ({
  TheaterReplayContent: ({ threadId }: { threadId: string }) => (
    <div data-testid="original-replay-owner" data-thread-id={threadId} />
  ),
}));

const destination = {
  kind: 'action' as const,
  id: 'theater' as const,
  label: '线程回放',
  description: '回看这段对话',
  searchTerms: 'replay',
};
const context = { threadId: 'thread-a', worktreeId: 'listed-a', openFilePath: null, preview: { path: '/' } };
// Independently specified persisted contract; the old parser must reject this unknown kind.
const replay = {
  id: 'thread-replay:thread-a',
  type: 'thread-replay',
  renderer: 'thread-replay',
  title: '线程回放',
  context: 'thread-a',
  objectRef: { kind: 'thread-replay', id: 'thread-a' },
  ownerStateRef: { owner: 'f252-thread-replay', key: 'thread-a' },
  resultTargetRef: { owner: 'f252-thread-replay', key: 'thread-a' },
  capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
} as unknown as WorkspaceSurfaceDescriptor;

describe('F322 real thread replay admission', () => {
  it('opens the current thread replay from real Home without an artifact or worktree alias', () => {
    const surface = workspaceHomeDestinationToSurface(destination, context);
    expect(surface).toMatchObject({
      id: replay.id,
      type: 'thread-replay',
      renderer: 'thread-replay',
      objectRef: replay.objectRef,
      ownerStateRef: replay.ownerStateRef,
      resultTargetRef: replay.resultTargetRef,
    });
    expect(workspaceHomeDestinationToSurface(destination, { ...context, worktreeId: 'listed-other' })?.id).toBe(
      surface?.id,
    );
    expect(workspaceHomeDestinationToSurface(destination, { ...context, threadId: undefined })).toBeNull();
  });
  it('shows only the supplied conversation title in chrome while retaining its opaque owner identity', () => {
    const known = createThreadReplaySurface('thread-a', '线程回放', 'Actual conversation');
    expect(known?.context).toBe('Actual conversation');
    expect(known?.objectRef.id).toBe('thread-a');
    expect(createThreadReplaySurface('thread-a')?.context).toBe('');
    expect(createThreadReplaySurface('thread-a', '线程回放', null)?.context).toBe('');
    expect(
      workspaceHomeDestinationToSurface(destination, { ...context, threadTitle: 'Actual conversation' })?.context,
    ).toBe('Actual conversation');
  });

  it('restores the canonical thread-only descriptor while rejecting a mismatched owner', () => {
    expect(restoreWorkbenchState(createInitialWorkbenchState([replay])).surfaces).toEqual([replay]);
    expect(
      restoreWorkbenchState(
        createInitialWorkbenchState([{ ...replay, resultTargetRef: { owner: 'f252-thread-replay', key: 'thread-b' } }]),
      ).surfaces,
    ).toEqual([]);
  });
  it('admits replay to existing host geometry using its own explicit kind', () => {
    expect(isArtifactWorkSurface(replay)).toBe(true);
    expect(replay.type).toBe('thread-replay');
    expect(isArtifactWorkSurface({ type: 'terminal' })).toBe(false);
  });
  it('keeps the original content node through host focus and visibility changes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (focusMode: boolean, surfaceVisible: boolean) => (
      <F307OwnerSurfaceRenderer
        surface={replay}
        focusMode={focusMode}
        surfaceVisible={surfaceVisible}
        onOpenSurface={() => {}}
        onOpenArtifactWithReturn={() => {}}
        onRefreshSurface={() => {}}
        onRequestDetach={() => {}}
      />
    );
    try {
      act(() => root.render(render(false, true)));
      const owner = container.querySelector('[data-testid="original-replay-owner"]');
      expect(owner?.getAttribute('data-thread-id')).toBe('thread-a');
      act(() => root.render(render(true, true)));
      expect(container.querySelector('[data-testid="original-replay-owner"]')).toBe(owner);
      act(() => root.render(render(false, false)));
      expect(container.querySelector('[data-testid="original-replay-owner"]')).toBe(owner);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
