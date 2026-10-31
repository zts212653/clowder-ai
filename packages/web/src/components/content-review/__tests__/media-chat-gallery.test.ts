import type { ArtifactReviewAnchor } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { addMediaSelection } from '../media-chat-selection';

const region: ArtifactReviewAnchor = { kind: 'image-region', x: 10, y: 20, width: 40, height: 30 };
const gallery = (index: number, messageId = 'original-five-images') => ({
  threadId: 'original-chat',
  messageId,
  messageRevision: '7',
  item: { kind: 'media-gallery' as const, blockId: 'five-images', itemIndex: index },
  index,
  count: 5,
});
const target = (index: number, messageId?: string) => ({
  title: `image-${index + 1}.png`,
  mediaType: 'image/png' as const,
  source: {
    kind: 'workspace' as const,
    locator: { worktreeId: 'wt-original', path: `art/image-${index + 1}.png` },
    expectedSourceRevision: `sha256:${'a'.repeat(64)}` as const,
    reviewId: `review-${index}`,
    expectedReviewRevision: 1,
  },
  gallery: gallery(index, messageId),
});
function added(result: ReturnType<typeof addMediaSelection>) {
  if (result.kind !== 'added') throw new Error(`Expected added selection; got ${result.kind}:${result.reason}`);
  return result.attachment;
}

describe('same-message gallery places in the one composer draft', () => {
  it('keeps exact separate work sources and numbers interleaved selections across images', () => {
    const image1 = added(addMediaSelection([], target(0), region, '图一的第一处'));
    const image4Result = addMediaSelection([image1], target(3), region, '图四这一处');
    expect(image4Result.kind).toBe('added');
    const image4 = added(image4Result);
    expect(image4.selections[0]?.id).toBe('2');
    const image1Again = added(addMediaSelection([image1, image4], target(0), region, '回到图一再圈'));
    expect(image1Again.source).toEqual(target(0).source);
    expect(image4.source).toEqual(target(3).source);
    expect(image1Again.selections.map((item) => item.id)).toEqual(['1', '3']);
    expect(image1Again).toMatchObject({ gallery: gallery(0) });
    expect(image4).toMatchObject({ gallery: gallery(3) });
    expect(image4.selections[0]?.instruction).toBe('图四这一处');
  });

  it('does not combine places from another source message even when filenames and positions match', () => {
    const image1 = added(addMediaSelection([], target(0), region));
    expect(addMediaSelection([image1], target(3, 'other-message'), region)).toEqual({
      kind: 'refused',
      reason: 'other_source',
    });
  });

  it('does not silently replace a circled original with a different version of the same gallery item', () => {
    const original = target(0);
    const pending = added(addMediaSelection([], original, region));
    const newer = { ...original, source: { ...original.source, expectedReviewRevision: 2 } };
    expect(addMediaSelection([pending], newer, region)).toEqual({ kind: 'refused', reason: 'other_source' });
  });
});
