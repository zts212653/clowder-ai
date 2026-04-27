import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('image-storage', () => {
  let uploadDir;
  let sourceDir;

  beforeEach(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-image-storage-upload-'));
    sourceDir = await mkdtemp(join(tmpdir(), 'cat-cafe-image-storage-source-'));
  });

  afterEach(async () => {
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
    if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
  });

  it('saves a validated image buffer to uploadDir and returns /uploads metadata', async () => {
    const { saveImageBufferToUploadDir } = await import('../dist/utils/image-storage.js');

    const result = await saveImageBufferToUploadDir({
      buffer: Buffer.from('fake-png'),
      mimeType: 'image/png',
      uploadDir,
      filenameStem: 'published-image',
    });

    assert.ok(result.absPath.startsWith(resolve(uploadDir)));
    assert.equal(result.urlPath, '/uploads/published-image.png');
    assert.equal(result.content.type, 'image');
    assert.equal(result.content.url, '/uploads/published-image.png');

    const content = await readFile(result.absPath);
    assert.equal(content.toString(), 'fake-png');
  });

  it('copies a local image file into uploadDir and returns canonical /uploads metadata', async () => {
    const { copyImageFileToUploadDir } = await import('../dist/utils/image-storage.js');

    const sourcePath = join(sourceDir, 'source.png');
    await writeFile(sourcePath, Buffer.from('source-png'));

    const result = await copyImageFileToUploadDir({
      sourcePath,
      mimeType: 'image/png',
      uploadDir,
      filenameStem: 'copied-image',
    });

    assert.ok(result.absPath.startsWith(resolve(uploadDir)));
    assert.equal(result.urlPath, '/uploads/copied-image.png');
    assert.equal(result.content.url, '/uploads/copied-image.png');

    const content = await readFile(result.absPath);
    assert.equal(content.toString(), 'source-png');
  });

  it('rejects copied image files exceeding 10MB', async () => {
    const { copyImageFileToUploadDir, ImageUploadError } = await import('../dist/utils/image-storage.js');

    const sourcePath = join(sourceDir, 'too-large.png');
    await writeFile(sourcePath, Buffer.alloc(10 * 1024 * 1024 + 1));

    await assert.rejects(
      () =>
        copyImageFileToUploadDir({
          sourcePath,
          mimeType: 'image/png',
          uploadDir,
          filenameStem: 'too-large',
        }),
      (error) => error instanceof ImageUploadError && error.message.includes('File too large'),
    );
  });

  it('throws on duplicate target when onExists is error', async () => {
    const { copyImageFileToUploadDir, saveImageBufferToUploadDir, ImageUploadError } = await import(
      '../dist/utils/image-storage.js'
    );

    const sourcePath = join(sourceDir, 'source.png');
    await writeFile(sourcePath, Buffer.from('source-png'));

    await copyImageFileToUploadDir({
      sourcePath,
      mimeType: 'image/png',
      uploadDir,
      filenameStem: 'duplicate-image',
      onExists: 'error',
    });

    await assert.rejects(
      () =>
        copyImageFileToUploadDir({
          sourcePath,
          mimeType: 'image/png',
          uploadDir,
          filenameStem: 'duplicate-image',
          onExists: 'error',
        }),
      (error) => error instanceof ImageUploadError && error.message.includes('already exists'),
    );

    await saveImageBufferToUploadDir({
      buffer: Buffer.from('source-png'),
      mimeType: 'image/png',
      uploadDir,
      filenameStem: 'duplicate-buffer',
      onExists: 'error',
    });
    await assert.rejects(
      () =>
        saveImageBufferToUploadDir({
          buffer: Buffer.from('source-png'),
          mimeType: 'image/png',
          uploadDir,
          filenameStem: 'duplicate-buffer',
          onExists: 'error',
        }),
      (error) => error instanceof ImageUploadError && error.message.includes('already exists'),
    );
  });

  it('reuses duplicate target when onExists is reuse', async () => {
    const { copyImageFileToUploadDir } = await import('../dist/utils/image-storage.js');

    const sourcePath = join(sourceDir, 'source.png');
    await writeFile(sourcePath, Buffer.from('source-png'));

    const first = await copyImageFileToUploadDir({
      sourcePath,
      mimeType: 'image/png',
      uploadDir,
      filenameStem: 'reused-image',
      onExists: 'reuse',
    });
    const second = await copyImageFileToUploadDir({
      sourcePath,
      mimeType: 'image/png',
      uploadDir,
      filenameStem: 'reused-image',
      onExists: 'reuse',
    });

    assert.equal(second.absPath, first.absPath);
    assert.equal(second.urlPath, first.urlPath);
    assert.equal((await readdir(uploadDir)).length, 1);
  });

  it('honors onExists when source path already equals the target path', async () => {
    const { copyImageFileToUploadDir, ImageUploadError } = await import('../dist/utils/image-storage.js');

    const sourcePath = join(uploadDir, 'same-path.png');
    await writeFile(sourcePath, Buffer.from('already-published'));

    await assert.rejects(
      () =>
        copyImageFileToUploadDir({
          sourcePath,
          mimeType: 'image/png',
          uploadDir,
          filenameStem: 'same-path',
          onExists: 'error',
        }),
      (error) => error instanceof ImageUploadError && error.message.includes('already exists'),
    );

    const reused = await copyImageFileToUploadDir({
      sourcePath,
      mimeType: 'image/png',
      uploadDir,
      filenameStem: 'same-path',
      onExists: 'reuse',
    });

    assert.equal(reused.absPath, resolve(sourcePath));
    assert.equal(reused.urlPath, '/uploads/same-path.png');
  });

  it('rejects missing same-path source instead of returning phantom metadata', async () => {
    const { copyImageFileToUploadDir } = await import('../dist/utils/image-storage.js');

    const missingSourcePath = join(uploadDir, 'missing-same-path.png');

    await assert.rejects(
      () =>
        copyImageFileToUploadDir({
          sourcePath: missingSourcePath,
          mimeType: 'image/png',
          uploadDir,
          filenameStem: 'missing-same-path',
          onExists: 'reuse',
        }),
      (error) => error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT',
    );
  });

  it('reuses an existing target when original source has been cleaned up', async () => {
    const { copyImageFileToUploadDir } = await import('../dist/utils/image-storage.js');

    const existingTargetPath = join(uploadDir, 'recovered-image.png');
    const missingSourcePath = join(sourceDir, 'already-cleaned-up.png');
    await writeFile(existingTargetPath, Buffer.from('published-before-replay'));

    const recovered = await copyImageFileToUploadDir({
      sourcePath: missingSourcePath,
      mimeType: 'image/png',
      uploadDir,
      filenameStem: 'recovered-image',
      onExists: 'reuse',
    });

    assert.equal(recovered.absPath, resolve(existingTargetPath));
    assert.equal(recovered.urlPath, '/uploads/recovered-image.png');
    assert.equal((await readdir(uploadDir)).length, 1);
  });
});
