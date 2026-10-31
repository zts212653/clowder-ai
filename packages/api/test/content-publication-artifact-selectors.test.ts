import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateThreadArtifacts } from '../src/domains/cats/services/agents/routing/thread-artifacts-aggregator.js';

test('artifact census keeps exact selectors for equal-URL gallery items and ordinary human PNG/MP4', () => {
  const items = aggregateThreadArtifacts({
    messages: [
      {
        id: 'source',
        catId: null,
        timestamp: 12,
        contentBlocks: [
          { type: 'image', url: '/uploads/a.png' },
          { type: 'file', url: '/uploads/a.mp4', fileName: '片段.mp4', mimeType: 'video/mp4', fileSize: 24 },
        ],
        extra: {
          rich: {
            blocks: [
              {
                kind: 'media_gallery',
                v: 1,
                id: 'gallery',
                items: [{ url: '/uploads/a.png' }, { url: '/uploads/a.png' }],
              },
            ],
          },
        },
      },
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((item) => item.publicationItem),
    [
      { kind: 'content-block', index: 0 },
      { kind: 'content-block', index: 1 },
      { kind: 'media-gallery', blockId: 'gallery', itemIndex: 0 },
      { kind: 'media-gallery', blockId: 'gallery', itemIndex: 1 },
    ],
  );
  assert.ok(items.every((item) => item.sourceMessageId === 'source' && item.createdAt === 12 && item.catId === null));
});
