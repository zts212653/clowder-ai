import { expect, it } from 'vitest';
import { messagePublicationSource } from '@/components/content-review/usePublishedContent';
import { projectCanonicalBubbles } from '../bubble-projection';
import { storedRevisionPatch } from '../bubble-publication-origins';
import type { ChatMessage } from '../chat-types';

it('once the stored time is known, a settled bubble opens its media under the stored revision (F309 entry 20)', () => {
  // Real page 2026-09-24: done carried the stored id, the bubble was rekeyed, but the gallery item
  // still named the client clock (1790214966863) instead of the stored time, and was refused.
  const gallery = { kind: 'media-gallery' as const, blockId: 'g1', itemIndex: 0 };
  const settled: ChatMessage = {
    id: 'stored-1',
    type: 'assistant',
    catId: 'codex-sol',
    content: '',
    timestamp: 2000,
    projectionPublicationOrigins: {
      'media-gallery:g1:0': { messageId: 'stored-1', messageRevision: '2000', item: gallery },
      'content-block:0': {
        messageId: 'callback-1',
        messageRevision: '1900',
        item: { kind: 'content-block', index: 0 },
      },
    },
  };

  const patch = storedRevisionPatch(settled, 1500);

  expect(patch).toEqual({
    timestamp: 1500,
    projectionPublicationOrigins: {
      'media-gallery:g1:0': { messageId: 'stored-1', messageRevision: '1500', item: gallery },
      'content-block:0': {
        messageId: 'callback-1',
        messageRevision: '1900',
        item: { kind: 'content-block', index: 0 },
      },
    },
  });
  const next = { ...settled, ...patch };
  expect(
    messagePublicationSource(
      {
        threadId: 't',
        messageId: next.id,
        messageRevision: String(next.timestamp),
        origins: next.projectionPublicationOrigins,
      },
      gallery,
      '/uploads/a.png',
    ),
  ).toMatchObject({ messageId: 'stored-1', messageRevision: '1500' });
});

it('a bubble without folded origins only takes the stored time', () => {
  const plain: ChatMessage = { id: 'stored-2', type: 'assistant', content: 'x', timestamp: 3000 };
  expect(storedRevisionPatch(plain, 2500)).toEqual({ timestamp: 2500 });
});

it('opens each folded media item using its own persisted message, revision and original item index', () => {
  const first: ChatMessage = {
    id: 'first',
    type: 'assistant',
    catId: 'codex-astra',
    origin: 'stream',
    content: 'first',
    timestamp: 10,
    contentBlocks: [{ type: 'image', url: '/uploads/a.png' }],
    extra: {
      stream: { invocationId: 'inv' },
      rich: { v: 1, blocks: [{ kind: 'media_gallery', id: 'g1', v: 1, items: [{ url: '/uploads/a.png' }] }] },
    },
  };
  const second: ChatMessage = {
    ...first,
    id: 'second',
    content: 'second',
    timestamp: 20,
    contentBlocks: [{ type: 'file', url: '/uploads/b.mp4', fileName: 'b.mp4', mimeType: 'video/mp4', fileSize: 24 }],
    extra: {
      stream: { invocationId: 'inv' },
      rich: { v: 1, blocks: [{ kind: 'media_gallery', id: 'g2', v: 1, items: [{ url: '/uploads/c.png' }] }] },
    },
  };
  const projected = projectCanonicalBubbles({ records: [first, second] }).messages;
  expect(projected).toHaveLength(1);
  const bubble = projected[0]!;
  const coordinate = {
    threadId: 'thread',
    messageId: bubble.id,
    messageRevision: String(bubble.timestamp),
    origins: bubble.projectionPublicationOrigins,
  };
  expect(messagePublicationSource(coordinate, { kind: 'content-block', index: 1 }, '/uploads/b.mp4')).toEqual({
    kind: 'message',
    threadId: 'thread',
    messageId: 'second',
    messageRevision: '20',
    item: { kind: 'content-block', index: 0 },
    expectedUrl: '/uploads/b.mp4',
  });
  expect(
    messagePublicationSource(coordinate, { kind: 'media-gallery', blockId: 'g2', itemIndex: 0 }, '/uploads/c.png'),
  ).toEqual({
    kind: 'message',
    threadId: 'thread',
    messageId: 'second',
    messageRevision: '20',
    item: { kind: 'media-gallery', blockId: 'g2', itemIndex: 0 },
    expectedUrl: '/uploads/c.png',
  });
  expect(projectCanonicalBubbles({ records: [bubble] }).messages[0]?.projectionPublicationOrigins).toEqual(
    bubble.projectionPublicationOrigins,
  );
});
