import { expect, it } from 'vitest';
import { ImageContentSchema } from '../schemas/message.schema.js';
import { MESSAGE_STICKER_CATALOG, messageStickerReference, messageStickerSchema } from '../types/message-stickers.js';

it('retains one immutable catalogue identity on ordinary image content', () => {
  const entry = MESSAGE_STICKER_CATALOG[0];
  expect(entry).toBeDefined();
  const sticker = messageStickerReference(entry.id);
  expect(ImageContentSchema.parse({ type: 'image', url: '/uploads/sticker.png', sticker }).sticker).toEqual(sticker);
  expect(messageStickerSchema.safeParse({ ...sticker, blobDigest: `sha256:${'0'.repeat(64)}` }).success).toBe(false);
  expect(messageStickerSchema.safeParse({ ...sticker, stickerId: '../not-a-catalogue-image' }).success).toBe(false);
});

it('keeps sticker characters as artwork choices rather than a participant roster', () => {
  expect(new Set(MESSAGE_STICKER_CATALOG.map((entry) => entry.id)).size).toBe(MESSAGE_STICKER_CATALOG.length);
  for (const entry of MESSAGE_STICKER_CATALOG) {
    expect(entry.assetFile).toMatch(/^[a-z0-9-]+\.png$/u);
    expect(entry.blobDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(entry.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(entry.label.zh).toBeTruthy();
    expect(entry.label.en).toBeTruthy();
    expect(entry).not.toHaveProperty('catId');
    expect(entry).not.toHaveProperty('humanId');
  }
});

it('uses the approved sixteen expressions without artwork that resembles a workflow status', () => {
  expect(MESSAGE_STICKER_CATALOG).toHaveLength(16);
  expect(MESSAGE_STICKER_CATALOG.some((entry) => entry.id.endsWith('-invalidated'))).toBe(false);
  for (const id of ['yanyan-working', 'shuoshuo-idea', 'momo-recall', 'momo-cheer']) {
    expect(MESSAGE_STICKER_CATALOG.find((entry) => entry.id === id)).toBeDefined();
  }
  for (const entry of MESSAGE_STICKER_CATALOG.filter((entry) => entry.id.endsWith('-applied'))) {
    expect(entry.label.zh).toContain('稳了');
  }
});
