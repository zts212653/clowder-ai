import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { artifactCardMetadata } from '../artifact-card-metadata';
import { workspaceV3Copy } from '../workspace-v3.shell-copy';

it('shows the current fixed version source time while preserving the import cursor timestamp', () => {
  const imported = new Date(2026, 9, 20, 22, 52).getTime();
  const created = new Date(2026, 9, 18, 10, 15).getTime();
  const artifact: ThreadArtifactDTO = {
    type: 'video',
    name: '片子',
    createdAt: imported,
    catId: null,
    sourceMessageId: null,
    work: {
      contentRef: 'work:film',
      ownerRevision: 4,
      currentOwnerRevision: 4,
      versionCreatedAt: created,
      versionTimeSource: 'release/current.mp4#mtime',
    },
  };
  expect(artifactCardMetadata(artifact, '', workspaceV3Copy.zh)).toContain('10/18 10:15');
  expect(artifact.createdAt).toBe(imported);
  delete artifact.work?.versionCreatedAt;
  expect(artifactCardMetadata(artifact, '', workspaceV3Copy.zh)).toContain('10/20 22:52');
});
