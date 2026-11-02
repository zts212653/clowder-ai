import { expect, it } from 'vitest';
import { createCommitChangesSurface, resolveCommitChangesTarget } from '../commit-changes-surface';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';

it('restores the exact commit owner while keeping different commits and roots distinct', () => {
  const target = { sha: 'a'.repeat(40), worktreeId: 'registered', threadId: 'source' };
  const source = { kind: 'chat-file-link', threadId: 'source', messageId: 'message' } as const;
  const surfaces = [
    createCommitChangesSurface(target, source),
    createCommitChangesSurface({ ...target, sha: 'b'.repeat(40) }, source),
    createCommitChangesSurface({ ...target, worktreeId: 'second' }, source),
  ];
  const restored = restoreWorkbenchState(JSON.parse(JSON.stringify(createInitialWorkbenchState(surfaces))));
  expect(restored.surfaces).toHaveLength(3);
  expect(new Set(restored.surfaces.map((s) => s.id)).size).toBe(3);
  expect(resolveCommitChangesTarget(restored.surfaces[0])).toEqual(target);
  expect(restored.surfaces[0].navigationOrigin).toEqual(source);
  expect(
    resolveCommitChangesTarget({ ...surfaces[0], ownerStateRef: { ...surfaces[0].ownerStateRef, key: 'foreign' } }),
  ).toBeNull();
});
