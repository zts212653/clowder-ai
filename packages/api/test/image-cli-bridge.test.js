import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { appendLocalImagePathHints, buildImageMediaItems, buildLocalImagePathHints, collectImageAccessDirectories } =
  await import('../dist/domains/cats/services/agents/providers/image-cli-bridge.js');

test('buildLocalImagePathHints returns empty string for no images', () => {
  assert.equal(buildLocalImagePathHints([]), '');
});

test('buildLocalImagePathHints formats local path lines', () => {
  const result = buildLocalImagePathHints(['/tmp/a.png', '/tmp/b.jpg']);
  assert.equal(result, '[Local image path: /tmp/a.png]\n[Local image path: /tmp/b.jpg]');
});

test('appendLocalImagePathHints appends hints after prompt', () => {
  const result = appendLocalImagePathHints('describe', ['/tmp/a.png']);
  assert.equal(result, 'describe\n\n[Local image path: /tmp/a.png]');
});

test('collectImageAccessDirectories deduplicates by parent directory', () => {
  const dirs = collectImageAccessDirectories(['/tmp/images/a.png', '/tmp/images/b.png', '/tmp/other/c.jpg']);
  assert.deepEqual(dirs, ['/tmp/images', '/tmp/other']);
});

// F211 REG3 Layer C: read local image files into Antigravity media items so the
// cascade can actually SEE the image (base64 bytes + mimeType), not just a path hint.
test('buildImageMediaItems reads files into base64 media items with mimeType', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-items-'));
  const pngPath = path.join(dir, 'shot.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  fs.writeFileSync(pngPath, bytes);
  const jpgPath = path.join(dir, 'pic.jpeg');
  const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 9, 8, 7]);
  fs.writeFileSync(jpgPath, jpgBytes);

  const items = await buildImageMediaItems([pngPath, jpgPath]);

  assert.deepEqual(items, [
    { mimeType: 'image/png', inlineData: bytes.toString('base64') },
    { mimeType: 'image/jpeg', inlineData: jpgBytes.toString('base64') },
  ]);
});

test('buildImageMediaItems skips unreadable paths and unsupported extensions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-skip-'));
  const txtPath = path.join(dir, 'note.txt');
  fs.writeFileSync(txtPath, 'not an image');
  const items = await buildImageMediaItems([path.join(dir, 'missing.png'), txtPath]);
  assert.deepEqual(items, []);
});
