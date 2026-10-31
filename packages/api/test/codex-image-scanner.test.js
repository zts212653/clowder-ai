import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

describe('scanAndPublishCodexImages', () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeTempDir(prefix) {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('publishes images found in a codex generated_images session directory', async () => {
    const { scanAndPublishCodexImages } = await import(
      '../dist/domains/cats/services/agents/providers/codex-image-scanner.js'
    );

    const codexHome = await makeTempDir('codex-home-');
    const sessionId = 'test-session-001';
    const sessionDir = join(codexHome, 'generated_images', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'ig_abc123.png'), Buffer.from('fake-png'));

    const uploadDir = await makeTempDir('uploads-');

    const results = await scanAndPublishCodexImages({
      codexSessionId: sessionId,
      uploadDir,
      codexHome,
    });

    assert.equal(results.length, 1);
    assert.match(results[0].urlPath, /^\/uploads\//);
    assert.equal(results[0].richBlock.kind, 'media_gallery');
    assert.equal(results[0].provenance.provider, 'codex');
    assert.equal(results[0].provenance.toolName, 'image_gen');
  });

  it('returns empty array when session directory does not exist', async () => {
    const { scanAndPublishCodexImages } = await import(
      '../dist/domains/cats/services/agents/providers/codex-image-scanner.js'
    );

    const codexHome = await makeTempDir('codex-home-');
    const uploadDir = await makeTempDir('uploads-');

    const results = await scanAndPublishCodexImages({
      codexSessionId: 'nonexistent-session',
      uploadDir,
      codexHome,
    });

    assert.deepEqual(results, []);
  });

  it('returns empty array when session directory is empty', async () => {
    const { scanAndPublishCodexImages } = await import(
      '../dist/domains/cats/services/agents/providers/codex-image-scanner.js'
    );

    const codexHome = await makeTempDir('codex-home-');
    const sessionDir = join(codexHome, 'generated_images', 'empty-session');
    await mkdir(sessionDir, { recursive: true });

    const uploadDir = await makeTempDir('uploads-');

    const results = await scanAndPublishCodexImages({
      codexSessionId: 'empty-session',
      uploadDir,
      codexHome,
    });

    assert.deepEqual(results, []);
  });

  it('skips non-image files in the session directory', async () => {
    const { scanAndPublishCodexImages } = await import(
      '../dist/domains/cats/services/agents/providers/codex-image-scanner.js'
    );

    const codexHome = await makeTempDir('codex-home-');
    const sessionDir = join(codexHome, 'generated_images', 'mixed-session');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'ig_abc.png'), Buffer.from('fake-png'));
    await writeFile(join(sessionDir, 'notes.txt'), 'not an image');
    await writeFile(join(sessionDir, '.DS_Store'), 'mac junk');

    const uploadDir = await makeTempDir('uploads-');

    const results = await scanAndPublishCodexImages({
      codexSessionId: 'mixed-session',
      uploadDir,
      codexHome,
    });

    assert.equal(results.length, 1);
    assert.match(results[0].urlPath, /\.png$/);
  });

  it('publishes multiple images and each gets a unique publication key', async () => {
    const { scanAndPublishCodexImages } = await import(
      '../dist/domains/cats/services/agents/providers/codex-image-scanner.js'
    );

    const codexHome = await makeTempDir('codex-home-');
    const sessionDir = join(codexHome, 'generated_images', 'multi-session');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'ig_001.png'), Buffer.from('img1'));
    await writeFile(join(sessionDir, 'ig_002.jpeg'), Buffer.from('img2'));

    const uploadDir = await makeTempDir('uploads-');

    const results = await scanAndPublishCodexImages({
      codexSessionId: 'multi-session',
      uploadDir,
      codexHome,
    });

    assert.equal(results.length, 2);
    assert.notEqual(results[0].publicationKey, results[1].publicationKey);
    assert.notEqual(results[0].urlPath, results[1].urlPath);
  });

  it('returns only newly published images — second scan of same session returns empty', async () => {
    const { scanAndPublishCodexImages } = await import(
      '../dist/domains/cats/services/agents/providers/codex-image-scanner.js'
    );

    const codexHome = await makeTempDir('codex-home-');
    const sessionDir = join(codexHome, 'generated_images', 'replay-session');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'ig_replay.png'), Buffer.from('replay-img'));

    const uploadDir = await makeTempDir('uploads-');
    const opts = { codexSessionId: 'replay-session', uploadDir, codexHome };

    const first = await scanAndPublishCodexImages(opts);
    const second = await scanAndPublishCodexImages(opts);

    assert.equal(first.length, 1);
    assert.equal(second.length, 0, 'second scan should skip already-published images');
  });
});
