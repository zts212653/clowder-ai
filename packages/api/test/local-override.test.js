import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { resolveWithLocalOverlay } = await import('../dist/utils/local-override.js');

const TMP = join(tmpdir(), `local-override-test-${Date.now()}`);

describe('resolveWithLocalOverlay (#603)', () => {
  beforeEach(async () => {
    await mkdir(TMP, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('returns base content when no overlay files exist', async () => {
    const basePath = join(TMP, 'rules.md');
    await writeFile(basePath, 'base content');

    const result = await resolveWithLocalOverlay(basePath);
    assert.equal(result.content, 'base content');
    assert.equal(result.source, 'base');
    assert.equal(result.path, basePath);
  });

  it('returns hardcoded base when provided and no overlay exists', async () => {
    const basePath = join(TMP, 'rules.md');
    const result = await resolveWithLocalOverlay(basePath, 'hardcoded digest');
    assert.equal(result.content, 'hardcoded digest');
    assert.equal(result.source, 'base');
  });

  it('uses .local-override.md when it exists (full replace)', async () => {
    const basePath = join(TMP, 'rules.md');
    await writeFile(basePath, 'base content');
    await writeFile(join(TMP, 'rules.local-override.md'), 'override content');

    const result = await resolveWithLocalOverlay(basePath);
    assert.equal(result.content, 'override content');
    assert.equal(result.source, 'override');
    assert.ok(result.path.includes('local-override'));
  });

  it('appends .local.md content after base (merge)', async () => {
    const basePath = join(TMP, 'rules.md');
    await writeFile(basePath, 'base content');
    await writeFile(join(TMP, 'rules.local.md'), 'local additions');

    const result = await resolveWithLocalOverlay(basePath);
    assert.ok(result.content.startsWith('base content'));
    assert.ok(result.content.includes('local additions'));
    assert.equal(result.source, 'local');
  });

  it('override takes precedence over local when both exist', async () => {
    const basePath = join(TMP, 'rules.md');
    await writeFile(basePath, 'base');
    await writeFile(join(TMP, 'rules.local.md'), 'local');
    await writeFile(join(TMP, 'rules.local-override.md'), 'override wins');

    const result = await resolveWithLocalOverlay(basePath);
    assert.equal(result.content, 'override wins');
    assert.equal(result.source, 'override');
  });

  it('works with hardcoded base + local merge', async () => {
    const basePath = join(TMP, 'rules.md');
    await writeFile(join(TMP, 'rules.local.md'), 'extra rules');

    const result = await resolveWithLocalOverlay(basePath, 'hardcoded');
    assert.ok(result.content.includes('hardcoded'));
    assert.ok(result.content.includes('extra rules'));
    assert.equal(result.source, 'local');
  });

  it('throws on non-ENOENT errors instead of silently falling back', async () => {
    const dirPath = join(TMP, 'is-a-dir.md');
    await mkdir(dirPath, { recursive: true });

    await assert.rejects(
      () => resolveWithLocalOverlay(dirPath),
      (err) => err.code !== 'ENOENT',
    );
  });
});
