import type { VideoProjectReviewAnchor, WorkspaceContentAnnotation } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { modificationBasis } from '../video-project/modification-inputs';

const anchor = (revision: number, segmentId: string): VideoProjectReviewAnchor => ({
  kind: 'video-project',
  baseRevision: `sha256:${String(revision).repeat(64)}`,
  baseOwnerRevision: revision,
  target: { kind: 'segment', segmentId },
});
const original = anchor(1, 'wrong-original'),
  located = anchor(2, 'actually-located'),
  later = anchor(4, 'later-location');
const annotation: WorkspaceContentAnnotation = {
  id: 'opinion',
  anchor: original,
  body: '位置要改',
  author: { kind: 'human', actorId: 'owner' },
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  state: 'open',
  projectHistory: [
    {
      kind: 'located',
      actor: { kind: 'cat', actorId: 'sol' },
      at: '2026-10-10T00:00:00.000Z',
      operationId: 'locate',
      targets: [located],
    },
    {
      kind: 'addressed',
      actor: { kind: 'cat', actorId: 'sol' },
      at: '2026-10-10T00:00:00.000Z',
      operationId: 'modified',
      result: { assetVersionRef: 'changed-artwork', ownerRevision: 3 },
    },
    {
      kind: 'located',
      actor: { kind: 'cat', actorId: 'sol' },
      at: '2026-10-10T00:00:00.000Z',
      operationId: 'later-locate',
      targets: [later],
    },
  ],
};
it('modification comparison binds the effective located set at the actual addressed event', () => {
  expect(modificationBasis(annotation).anchors).toEqual([located]);
});
