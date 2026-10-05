import { describe, expect, it } from 'vitest';
import { createMessagePublicationSurface, resolveMessagePublicationSource } from '../message-publication-surface';
import { createPublicationSurface, resolvePublicationTarget } from '../publication-surface';
import { artifactObjectId, isRealSurfaceOwnerAvailable, legacyArtifactObjectId } from '../real-surface-adapters';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';

const contentRef = `prepared-media:${'a'.repeat(64)}`;
describe('canonical publication Workspace target', () => {
  it('restores an unresolved exact item without inventing a publication or admitting a forged descriptor', () => {
    const source = {
      kind: 'message' as const,
      threadId: 't',
      messageId: 'm',
      messageRevision: '1',
      expectedUrl: '/uploads/a.png',
      item: { kind: 'content-block' as const, index: 1 },
    };
    const surface = createMessagePublicationSurface(source, '作品');
    const restored = restoreWorkbenchState(
      { ...createInitialWorkbenchState(), surfaces: [surface], activeSurfaceId: surface.id },
      { isOwnerRefAvailable: isRealSurfaceOwnerAvailable },
    );
    expect(restored.surfaces).toEqual([surface]);
    expect(resolveMessagePublicationSource(restored.surfaces[0]!)).toEqual(source);
    expect(resolveMessagePublicationSource({ ...surface, objectRef: { kind: 'artifact', id: 'foreign' } })).toBeNull();
  });
  it('equal URLs within one message are distinct artifacts, with old IDs available for unique restoration', () => {
    const base = {
      type: 'image' as const,
      name: 'image',
      url: '/uploads/a.png',
      createdAt: 12,
      sourceMessageId: 'm',
      catId: null,
    };
    const first = { ...base, publicationItem: { kind: 'media-gallery' as const, blockId: 'gallery', itemIndex: 0 } };
    const second = { ...first, publicationItem: { ...first.publicationItem, itemIndex: 1 } };
    expect(artifactObjectId(first)).not.toBe(artifactObjectId(second));
    expect(legacyArtifactObjectId(first)).toBe(artifactObjectId(base));
  });
  it('keeps one object across versions, restores the pinned version and exact chat origin', () => {
    const origin = { kind: 'chat-file-link' as const, threadId: 'source-thread', messageId: 'source-message' };
    const first = createPublicationSurface({ contentRef, ownerRevision: 1, title: '晨光', navigationOrigin: origin });
    const second = createPublicationSurface({ contentRef, ownerRevision: 2, title: '晨光' });
    expect(first.id).toBe(second.id);
    expect(first.ownerStateRef).not.toEqual(second.ownerStateRef);
    const restored = restoreWorkbenchState(
      {
        ...createInitialWorkbenchState(),
        surfaces: [first],
        activeSurfaceId: first.id,
      },
      { isOwnerRefAvailable: isRealSurfaceOwnerAvailable },
    );
    expect(restored.surfaces).toEqual([first]);
    expect(resolvePublicationTarget(restored.surfaces[0]!)).toEqual({ contentRef, ownerRevision: 1 });
    expect(resolvePublicationTarget({ ...first, objectRef: { ...first.objectRef, id: 'foreign' } })).toBeNull();
  });
});
