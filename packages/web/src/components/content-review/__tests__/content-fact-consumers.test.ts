import { projectFileContent } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { messageArtworkItems } from '../message-artwork-gallery';

it.each([
  ['cover.ico', 'image'],
  ['cover.avif', 'image'],
  ['clip.mkv', 'video'],
  ['clip.avi', 'video'],
  ['clip.m4v', 'video'],
  ['clip.ogv', 'video'],
] as const)('Chat content and rich cards share the catalogue facts for %s', (name, kind) => {
  const url = `/uploads/${name}`;
  expect(projectFileContent({ name, url }).kind).toBe(kind);
  const items = messageArtworkItems({
    contentBlocks: [{ type: 'file', fileName: name, url, mimeType: 'application/octet-stream', fileSize: 0 }],
    extra: { rich: { v: 1, blocks: [{ id: 'file', kind: 'file', v: 1, fileName: name, url }] } },
  });
  expect(items.map((item) => item.mediaType)).toEqual([kind, kind]);
  expect(items.map((item) => item.item)).toEqual([
    { kind: 'content-block', index: 0 },
    { kind: 'rich-file', blockId: 'file' },
  ]);
});

it('a declared document MIME is not reclassified as gallery media by its misleading suffix', () => {
  const file = { url: '/uploads/report.mp4', fileName: 'report.mp4', mimeType: 'application/pdf', fileSize: 0 };
  expect(messageArtworkItems({ contentBlocks: [{ type: 'file', ...file }] })).toEqual([]);
});
