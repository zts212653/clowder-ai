import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { canonicalLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import * as adapters from '../real-surface-adapters';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';

const pr: ThreadArtifactDTO = {
  type: 'pr',
  name: 'Exact PR',
  ref: 'Owner/Repo#1',
  catId: null,
  createdAt: 17,
  sourceMessageId: null,
};
const origin = {
  kind: 'workspace-home-artifact' as const,
  threadId: 'home-thread',
  artifactId: adapters.artifactObjectId(pr),
  viewportOffsetPx: -12.5,
};
const create = (artifact = pr) =>
  adapters.createPullRequestChangesSurface({
    artifact,
    threadId: 'home-thread',
    worktreeId: 'registered-root',
    navigationOrigin: { ...origin, artifactId: adapters.artifactObjectId(artifact) },
  });

describe('original Changes owner exact PR target', () => {
  it('opens a canonical repository/PR target without guessing a local diff', () => {
    const surface = create();
    expect(surface).not.toBeNull();
    expect(surface).toMatchObject({
      type: 'workspace',
      renderer: 'workspace-destination',
      ownerStateRef: { owner: 'f063-workspace-diff', key: 'registered-root' },
      navigationOrigin: origin,
    });
    expect(adapters.resolvePullRequestChangesTarget(surface!)).toEqual({
      kind: 'github-pr',
      v: 1,
      repoFullName: 'owner/repo',
      prNumber: 1,
      worktreeId: 'registered-root',
      threadId: 'home-thread',
    });
    expect(adapters.resolveChangesTarget(surface!)).toBeNull();
  });

  it('keeps local Changes and different exact PRs as four distinct objects through reload', () => {
    const local = adapters.createWorkspaceDestinationSurface(
      canonicalLauncherDestination('surface', 'changes'),
      'home-thread',
      'registered-root',
    );
    const surfaces = [
      local!,
      create()!,
      create({ ...pr, ref: 'owner/repo#2' })!,
      create({ ...pr, ref: 'other/repo#1' })!,
    ];
    expect(new Set(surfaces.map((surface) => surface.objectRef.id)).size).toBe(4);
    const restored = restoreWorkbenchState(JSON.parse(JSON.stringify(createInitialWorkbenchState(surfaces))));
    expect(restored.surfaces).toHaveLength(4);
    expect(restored.surfaces.slice(1).map((surface) => surface.navigationOrigin)).toEqual(
      surfaces.slice(1).map((surface) => surface.navigationOrigin),
    );
    expect(adapters.resolveChangesTarget(restored.surfaces[0])).toEqual({
      worktreeId: 'registered-root',
      threadId: 'home-thread',
    });
  });

  it.each([
    '#1',
    'owner/.#1',
    'owner/..#1',
    'owner/repo',
    'owner/repo#0',
    'owner/repo#01',
    'owner/repo#9007199254740992',
    'owner/repo#1 extra',
    'owner/repo#1/../2',
    'owner/repo/extra#1',
  ])('refuses incomplete or invalid producer ref %s', (ref) => {
    expect(create({ ...pr, ref })).toBeNull();
  });

  it('requires an existing root coordinate rather than inferring one from PR metadata', () => {
    expect(
      adapters.createPullRequestChangesSurface({ artifact: pr, threadId: 'home-thread', worktreeId: null }),
    ).toBeNull();
  });

  it('leaves non-PR works on their original content owners', () => {
    expect(create({ ...pr, type: 'file' })).toBeNull();
  });

  it.each([
    'surface',
    'object',
    'owner',
    'root',
    'result',
    'encoding',
  ])('rejects an inconsistent %s binding without a local fallback', (field) => {
    const surface = create()!;
    const corrupted = {
      ...surface,
      ...(field === 'surface' ? { id: 'workspace:surface:changes:registered-root' } : {}),
      ...(field === 'object' ? { objectRef: { ...surface.objectRef, id: 'surface:changes' } } : {}),
      ...(field === 'owner' ? { ownerStateRef: { ...surface.ownerStateRef, owner: 'f284-workspace-launcher' } } : {}),
      ...(field === 'root' ? { ownerStateRef: { ...surface.ownerStateRef, key: 'another-root' } } : {}),
      ...(field === 'result' ? { resultTargetRef: { ...surface.resultTargetRef!, key: 'registered-root' } } : {}),
      ...(field === 'encoding'
        ? { resultTargetRef: { ...surface.resultTargetRef!, key: `${surface.resultTargetRef!.key}%20` } }
        : {}),
    };
    expect(adapters.resolvePullRequestChangesTarget(corrupted)).toBeNull();
    expect(adapters.resolveChangesTarget(corrupted)).toBeNull();
    expect(restoreWorkbenchState(createInitialWorkbenchState([corrupted])).surfaces).toHaveLength(0);
  });
});
