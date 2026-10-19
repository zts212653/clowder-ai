import { describe, expect, it } from 'vitest';
import { contentModificationTakeoverSchema, MediaContextAttachmentSchema } from '../index.js';

const gallery = {
  threadId: 'original-chat',
  messageId: 'original-five-images',
  messageRevision: '7',
  item: { kind: 'media-gallery', blockId: 'five-images', itemIndex: 3 },
  index: 3,
  count: 5,
};
const media = {
  v: 1,
  id: 'image-four',
  kind: 'media',
  title: '第四张',
  mediaType: 'image/png',
  source: { kind: 'artifact-review', reviewId: 'original-four', round: 2, expectedReviewRevision: 4 },
  selections: [{ id: '3', selection: { kind: 'image-point', x: 40, y: 60 }, instruction: '这一处' }],
  gallery,
};

describe('gallery origin is bounded navigation metadata on the original media attachment', () => {
  it('round trips group position without replacing the work source, version, anchor or words', () => {
    expect(MediaContextAttachmentSchema.parse(media)).toEqual(media);
  });
  it('rejects positions outside the group and empty or unversioned original-message coordinates', () => {
    for (const invalid of [
      { ...gallery, index: 5 },
      { ...gallery, index: -1 },
      { ...gallery, count: 0 },
      { ...gallery, messageId: '' },
      { ...gallery, messageRevision: 'latest' },
    ]) {
      expect(MediaContextAttachmentSchema.safeParse({ ...media, gallery: invalid }).success).toBe(false);
    }
  });
});

describe('explicit work selection on the existing Human message takeover', () => {
  const original = { sourceMessageId: 'one-human-send', operationId: '94ae8c88-4ea5-4c40-a093-244c83789bfb' };
  it('keeps legacy single-source input and accepts one named existing attachment', () => {
    expect(contentModificationTakeoverSchema.parse(original)).toEqual(original);
    const selected = { ...original, attachmentId: 'image-four' };
    expect(contentModificationTakeoverSchema.parse(selected)).toEqual(selected);
  });
  it('does not accept a path, batch list, empty selector or oversized attachment id', () => {
    for (const extra of [
      { path: '/tmp/other.png' },
      { attachmentIds: ['image-four'] },
      { attachmentId: '' },
      { attachmentId: 'x'.repeat(129) },
    ]) {
      expect(contentModificationTakeoverSchema.safeParse({ ...original, ...extra }).success).toBe(false);
    }
  });
});
