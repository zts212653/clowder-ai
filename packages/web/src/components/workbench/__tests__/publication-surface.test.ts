import { describe, expect, it } from 'vitest';
import { createMessagePublicationSurface, resolveMessagePublicationSource } from '../message-publication-surface';
import { createPublicationSurface, parsePublicationTarget, resolvePublicationTarget } from '../publication-surface';
import { artifactObjectId, isRealSurfaceOwnerAvailable, legacyArtifactObjectId } from '../real-surface-adapters';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';

const contentRef = `prepared-media:${'a'.repeat(64)}`;
describe('canonical publication Workspace target', () => {
  it('opens and restores a fixed independent work version without a source message or a new surface owner', () => {
    const workRef = `work:${'c'.repeat(64)}`;
    expect(parsePublicationTarget({ contentRef: workRef, ownerRevision: 3 })).toEqual({
      contentRef: workRef,
      ownerRevision: 3,
    });
    const surface = createPublicationSurface({ contentRef: workRef, ownerRevision: 3, title: '真实视频作品' });
    const restored = restoreWorkbenchState(
      { ...createInitialWorkbenchState(), surfaces: [surface], activeSurfaceId: surface.id },
      { isOwnerRefAvailable: isRealSurfaceOwnerAvailable },
    );
    expect(restored.surfaces.map(resolvePublicationTarget)).toEqual([{ contentRef: workRef, ownerRevision: 3 }]);
    expect(surface.ownerStateRef.owner).toBe('f138-publication');
    expect(surface.messagePublicationSource).toBeUndefined();
    expect(parsePublicationTarget({ contentRef: `widget:${'c'.repeat(64)}`, ownerRevision: 3 })).toBeNull();
  });
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
  it('carries the review a receipt is committed to as part of the exact target, and changes nothing for a plain open', () => {
    const reviewId = `review-${'b'.repeat(64)}`;
    const plain = createPublicationSurface({ contentRef, ownerRevision: 2, title: '晨光' });
    const bound = createPublicationSurface({ contentRef, ownerRevision: 2, reviewId, title: '晨光' });
    // One work stays one object however it was opened.
    expect(bound.id).toBe(plain.id);
    expect(resolvePublicationTarget(bound)).toEqual({ contentRef, ownerRevision: 2, reviewId });
    // A plain target, and every descriptor saved before there was a bound one, carry no review key at all.
    expect(plain.ownerStateRef.key).toBe(JSON.stringify({ contentRef, ownerRevision: 2 }));
    expect(resolvePublicationTarget(plain)).toEqual({ contentRef, ownerRevision: 2 });
    const restored = restoreWorkbenchState(
      { ...createInitialWorkbenchState(), surfaces: [bound], activeSurfaceId: bound.id },
      { isOwnerRefAvailable: isRealSurfaceOwnerAvailable },
    );
    expect(resolvePublicationTarget(restored.surfaces[0]!)).toEqual({ contentRef, ownerRevision: 2, reviewId });
  });
  it('refuses a review id that is not one, instead of carrying it to the owner', () => {
    const reviewId = `review-${'b'.repeat(64)}`;
    expect(parsePublicationTarget({ contentRef, ownerRevision: 2, reviewId })).toEqual({
      contentRef,
      ownerRevision: 2,
      reviewId,
    });
    expect(parsePublicationTarget({ contentRef, ownerRevision: 2, reviewId: 'not-a-review' })).toBeNull();
    expect(() =>
      createPublicationSurface({ contentRef, ownerRevision: 2, reviewId: 'not-a-review', title: '晨光' }),
    ).toThrow();
  });
});
