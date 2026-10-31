import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { parseFileNavigationOrigin } from '../file-navigation-origin';
import { artifactObjectId, createArtifactSurface, createFileSurface } from '../real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';

const artifact: ThreadArtifactDTO = {
  type: 'image',
  name: 'two works',
  catId: null,
  createdAt: 17,
  sourceMessageId: 'message',
  url: '/uploads/same.png',
  publicationItem: { kind: 'media-gallery', blockId: 'gallery', itemIndex: 0 },
};
const origin = (value = artifact) => ({
  kind: 'workspace-home-artifact' as const,
  threadId: 'home-thread',
  artifactId: artifactObjectId(value),
  viewportOffsetPx: -12.5,
});

describe('Home works canonical origin admission', () => {
  it('accepts actual producer selector property order without normalizing away identity', () => {
    const reordered = {
      ...artifact,
      publicationItem: { itemIndex: 0, blockId: 'gallery', kind: 'media-gallery' as const },
    };
    expect(parseFileNavigationOrigin(origin(reordered))).toEqual(origin(reordered));
  });
  it('keeps an exact full producer key and signed viewport offset', () => {
    expect(parseFileNavigationOrigin(origin())).toEqual(origin());
  });

  it('preserves legitimate producer keys longer than file-entrance limits and nullable ledger identity', () => {
    const ledger: ThreadArtifactDTO = {
      type: 'file',
      name: '作品'.repeat(5000),
      ref: 'guide.md',
      catId: null,
      createdAt: 23,
      sourceMessageId: null,
    };
    expect(origin(ledger).artifactId.length).toBeGreaterThan(16384);
    expect(parseFileNavigationOrigin(origin(ledger))).toEqual(origin(ledger));
  });

  it('distinguishes two publication items in the same message instead of degrading to legacy identity', () => {
    const second = {
      ...artifact,
      publicationItem: { kind: 'media-gallery' as const, blockId: 'gallery', itemIndex: 1 },
    };
    expect(origin().artifactId).not.toBe(origin(second).artifactId);
    expect(parseFileNavigationOrigin(origin())).toEqual(origin());
    expect(parseFileNavigationOrigin(origin(second))).toEqual(origin(second));
  });

  it('retains Home origin across file and original F232 artifact/review descriptor restore', () => {
    const navigationOrigin = origin() as WorkspaceSurfaceDescriptor['navigationOrigin'];
    const surfaces = [
      createFileSurface({ worktreeId: 'work', path: 'guide.md', navigationOrigin }),
      createArtifactSurface({ threadId: 'source-thread', artifact, navigationOrigin }),
      createArtifactSurface({ threadId: 'source-thread', artifact: { ...artifact, type: 'pr' }, navigationOrigin }),
    ];
    const restored = restoreWorkbenchState(JSON.parse(JSON.stringify(createInitialWorkbenchState(surfaces))));
    expect(restored.surfaces).toHaveLength(3);
    expect(restored.surfaces.map((surface) => surface.navigationOrigin)).toEqual(surfaces.map(() => origin()));
  });

  it.each([
    '',
    '%',
    'not-json',
    encodeURIComponent(JSON.stringify(['image', null, null, null, 0, 'name', 'extra'])),
    encodeURIComponent(JSON.stringify(['invented', null, null, null, 0, 'name'])),
    encodeURIComponent(JSON.stringify(['image', null, null, null, null, 'name'])),
    encodeURIComponent(
      JSON.stringify([
        artifactObjectId({ ...artifact, publicationItem: undefined }),
        { kind: 'media-gallery', blockId: 'gallery', itemIndex: 10001 },
      ]),
    ),
    encodeURIComponent(
      JSON.stringify([
        artifactObjectId({ ...artifact, publicationItem: undefined }),
        { kind: 'rich-file', blockId: 'gallery', extra: true },
      ]),
    ),
    decodeURIComponent(origin().artifactId),
    origin().artifactId.replace('%5B', '%5b'),
  ])('rejects malformed or noncanonical producer identity %s', (artifactId) => {
    expect(parseFileNavigationOrigin({ ...origin(), artifactId })).toBeNull();
  });

  it.each([Infinity, -Infinity, NaN, null, '12'])('rejects invalid signed geometry %s', (viewportOffsetPx) => {
    expect(parseFileNavigationOrigin({ ...origin(), viewportOffsetPx })).toBeNull();
  });

  it.each(['', 'bad\0thread', 'x'.repeat(257)])('rejects an invalid source host thread %s', (threadId) => {
    expect(parseFileNavigationOrigin({ ...origin(), threadId })).toBeNull();
  });
});
