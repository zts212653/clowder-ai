import { describe, expect, it } from 'vitest';
import { isArtifactWorkSurface, isWorkspaceFullWindowSurface } from '../artifact-work-presentation';
import { isRealSurfaceOwnerAvailable } from '../real-surface-adapters';
import { createVideoProjectSurface, resolveVideoProjectTarget } from '../video-project-surface';
import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';

const contentRef = `video-project:${'a'.repeat(64)}`;
const surface: WorkspaceSurfaceDescriptor = {
  id: `video-project:${contentRef}`,
  type: 'video-project',
  renderer: 'video-project-review',
  title: '醋醋喵 EP0',
  context: '审片',
  objectRef: { kind: 'video-project', id: contentRef },
  ownerStateRef: { owner: 'f138-video-project', key: JSON.stringify({ contentRef, screeningId: 'first' }) },
  resultTargetRef: { owner: 'f138-video-project', key: contentRef },
  capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
};

describe('video project in the ordinary workbench', () => {
  it('keeps the original screening and marked media position when a chat chip reopens the surface', () => {
    const selected = createVideoProjectSurface({
      contentRef,
      title: '原片',
      screeningId: 'older-film',
      position: { pts: 731648, requestId: 12 },
    });
    const restored = restoreWorkbenchState(
      { ...createInitialWorkbenchState(), surfaces: [selected], activeSurfaceId: selected.id },
      { isOwnerRefAvailable: isRealSurfaceOwnerAvailable },
    );
    const selectedSurface = restored.surfaces[0];
    if (!selectedSurface) throw new Error('Marked surface was not restored');
    expect(resolveVideoProjectTarget(selectedSurface)).toEqual({
      contentRef,
      screeningId: 'older-film',
      position: { pts: 731648, requestId: 12 },
    });
  });
  it('restores the selected frozen screening and remains a large artwork surface', () => {
    const restored = restoreWorkbenchState(
      { ...createInitialWorkbenchState(), surfaces: [surface], activeSurfaceId: surface.id },
      { isOwnerRefAvailable: isRealSurfaceOwnerAvailable },
    );
    expect(restored.surfaces).toEqual([surface]);
    expect(isArtifactWorkSurface(surface)).toBe(true);
    expect(isWorkspaceFullWindowSurface(surface, 'v2')).toBe(true);
  });

  it('refuses a forged project owner coordinate instead of restoring an unrelated object', () => {
    const forged = { ...surface, objectRef: { ...surface.objectRef, id: 'video-project:foreign' } };
    const restored = restoreWorkbenchState(
      { ...createInitialWorkbenchState(), surfaces: [forged], activeSurfaceId: forged.id },
      { isOwnerRefAvailable: isRealSurfaceOwnerAvailable },
    );
    expect(restored.surfaces).toEqual([]);
    expect(isRealSurfaceOwnerAvailable(forged as unknown as WorkspaceSurfaceDescriptor)).toBe(false);
  });
});
