import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('publishGeneratedImage', () => {
  let sourceDir;
  let uploadDir;
  let previousUploadDir;

  beforeEach(async () => {
    sourceDir = await mkdtemp(join(tmpdir(), 'cat-cafe-generated-image-source-'));
    uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-generated-image-upload-'));
    previousUploadDir = process.env.UPLOAD_DIR;
  });

  afterEach(async () => {
    if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
    if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUploadDir;
  });

  it('publishes a generated image as a canonical /uploads artifact with media_gallery block', async () => {
    const { publishGeneratedImage } = await import(
      '../dist/domains/cats/services/agents/providers/generated-image-publication.js'
    );

    const sourcePath = join(sourceDir, 'cat.png');
    await writeFile(sourcePath, Buffer.from('fake-png'));

    const published = await publishGeneratedImage({
      sourcePath,
      mimeType: 'image/png',
      publicationKey: 'codex-imagegen-001',
      provider: 'codex',
      toolName: 'image_gen',
      prompt: 'silver tabby maine coon cuddle',
      uploadDir,
      title: 'codex:image_gen',
      alt: 'generated image',
    });

    assert.match(published.urlPath, /^\/uploads\/codex-imagegen-001-[a-f0-9]{8}\.png$/);
    assert.equal(published.richBlock.kind, 'media_gallery');
    assert.equal(published.richBlock.items[0].url, published.urlPath);
    assert.equal(published.richBlock.items[0].alt, 'generated image');
    assert.equal(published.provenance.originalPath, sourcePath);
    assert.equal(published.provenance.publishedPath, published.urlPath);
    assert.equal(published.provenance.prompt, 'silver tabby maine coon cuddle');
  });

  it('returns the same published artifact on repeated publicationKey replay', async () => {
    const { publishGeneratedImage } = await import(
      '../dist/domains/cats/services/agents/providers/generated-image-publication.js'
    );

    const sourcePath = join(sourceDir, 'cat.png');
    await writeFile(sourcePath, Buffer.from('fake-png'));

    const input = {
      sourcePath,
      mimeType: 'image/png',
      publicationKey: 'codex-imagegen-001',
      provider: 'codex',
      toolName: 'image_gen',
      prompt: 'silver tabby maine coon cuddle',
      uploadDir,
      title: 'codex:image_gen',
      alt: 'generated image',
    };

    const first = await publishGeneratedImage(input);
    const second = await publishGeneratedImage(input);

    assert.equal(second.urlPath, first.urlPath);
    assert.equal(second.absPath, first.absPath);
    assert.equal((await readdir(uploadDir)).length, 1);
  });

  it('keeps publication idempotency when publicationKey sanitizes to empty', async () => {
    const { publishGeneratedImage } = await import(
      '../dist/domains/cats/services/agents/providers/generated-image-publication.js'
    );

    const sourcePath = join(sourceDir, 'cat.png');
    await writeFile(sourcePath, Buffer.from('fake-png'));

    const input = {
      sourcePath,
      mimeType: 'image/png',
      publicationKey: '!!!',
      provider: 'codex',
      toolName: 'image_gen',
      uploadDir,
    };

    const first = await publishGeneratedImage(input);
    const second = await publishGeneratedImage(input);

    assert.equal(second.urlPath, first.urlPath);
    assert.equal(second.richBlock.id, first.richBlock.id);
    assert.equal((await readdir(uploadDir)).length, 1);
  });

  it('does not reuse artifacts for distinct publicationKeys that sanitize to the same stem', async () => {
    const { publishGeneratedImage } = await import(
      '../dist/domains/cats/services/agents/providers/generated-image-publication.js'
    );

    const firstSourcePath = join(sourceDir, 'first.png');
    const secondSourcePath = join(sourceDir, 'second.png');
    await writeFile(firstSourcePath, Buffer.from('first-png'));
    await writeFile(secondSourcePath, Buffer.from('second-png'));

    const first = await publishGeneratedImage({
      sourcePath: firstSourcePath,
      mimeType: 'image/png',
      publicationKey: 'cat/image',
      provider: 'codex',
      toolName: 'image_gen',
      uploadDir,
    });
    const second = await publishGeneratedImage({
      sourcePath: secondSourcePath,
      mimeType: 'image/png',
      publicationKey: 'cat:image',
      provider: 'codex',
      toolName: 'image_gen',
      uploadDir,
    });

    assert.notEqual(second.urlPath, first.urlPath);
    assert.notEqual(second.richBlock.id, first.richBlock.id);
    assert.equal((await readdir(uploadDir)).length, 2);
  });

  it('does not collide when one key already looks like a derived publication stem', async () => {
    const { publishGeneratedImage } = await import(
      '../dist/domains/cats/services/agents/providers/generated-image-publication.js'
    );

    const firstSourcePath = join(sourceDir, 'first.png');
    const secondSourcePath = join(sourceDir, 'second.png');
    await writeFile(firstSourcePath, Buffer.from('first-png'));
    await writeFile(secondSourcePath, Buffer.from('second-png'));

    const first = await publishGeneratedImage({
      sourcePath: firstSourcePath,
      mimeType: 'image/png',
      publicationKey: 'cat/image',
      provider: 'codex',
      toolName: 'image_gen',
      uploadDir,
    });
    const firstStem = first.urlPath.replace('/uploads/', '').replace('.png', '');
    const second = await publishGeneratedImage({
      sourcePath: secondSourcePath,
      mimeType: 'image/png',
      publicationKey: firstStem,
      provider: 'codex',
      toolName: 'image_gen',
      uploadDir,
    });

    assert.notEqual(second.urlPath, first.urlPath);
    assert.notEqual(second.richBlock.id, first.richBlock.id);
    assert.equal((await readdir(uploadDir)).length, 2);
  });

  it('uses UPLOAD_DIR when uploadDir override is omitted', async () => {
    const { publishGeneratedImage } = await import(
      '../dist/domains/cats/services/agents/providers/generated-image-publication.js'
    );

    process.env.UPLOAD_DIR = uploadDir;

    const sourcePath = join(sourceDir, 'cat.png');
    await writeFile(sourcePath, Buffer.from('fake-png'));

    const published = await publishGeneratedImage({
      sourcePath,
      mimeType: 'image/png',
      publicationKey: 'env-upload-dir',
      provider: 'codex',
      toolName: 'image_gen',
    });

    assert.match(published.urlPath, /^\/uploads\/env-upload-dir-[a-f0-9]{8}\.png$/);
    assert.equal(published.absPath, join(uploadDir, published.urlPath.replace('/uploads/', '')));
  });

  it('bounds publication filenames for very long publicationKeys', async () => {
    const { publishGeneratedImage } = await import(
      '../dist/domains/cats/services/agents/providers/generated-image-publication.js'
    );

    const sourcePath = join(sourceDir, 'cat.png');
    await writeFile(sourcePath, Buffer.from('fake-png'));

    const published = await publishGeneratedImage({
      sourcePath,
      mimeType: 'image/png',
      publicationKey: `codex-${'very-long-key-'.repeat(40)}`,
      provider: 'codex',
      toolName: 'image_gen',
      uploadDir,
    });

    const filename = published.urlPath.replace('/uploads/', '');
    assert.ok(filename.length <= 245);
    assert.equal(published.richBlock.id, `generated-image-${filename.replace('.png', '')}`);
  });
});
