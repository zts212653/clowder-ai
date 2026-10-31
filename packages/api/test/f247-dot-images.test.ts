import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { validateDotPng } from '../src/domains/cats/services/cloud-bridge/dot/DotImageService.js';

test('image ingress verifies actual bytes, original dimensions, MIME and size rather than trusting a filename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-image-'));
  try {
    const bytes = await sharp({ create: { width: 12, height: 9, channels: 4, background: '#D4835A' } })
      .png()
      .toBuffer();
    const checked = await validateDotPng(bytes.toString('base64'));
    assert.deepEqual([checked.width, checked.height], [12, 9]);
    assert.equal(checked.bytes.equals(bytes), true, 'validation keeps exact original bytes');
    await assert.rejects(() => validateDotPng(Buffer.from('<svg onload="evil()"/>').toString('base64')), /invalid_png/);
    const jpeg = await sharp(bytes).jpeg().toBuffer();
    await assert.rejects(() => validateDotPng(jpeg.toString('base64')), /invalid_png/);
    await assert.rejects(() => validateDotPng(`${bytes.toString('base64')}!`), /invalid_base64/);
    await assert.rejects(
      () => validateDotPng(Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')),
      /image_too_large/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
