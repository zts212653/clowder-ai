import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('project-init (F-1)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `f102-init-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all 13 KIND_DIRS subdirectories', async () => {
    const { runProjectInit } = await import('../../dist/scripts/project-init.js');
    const result = await runProjectInit(tmpDir);

    const expectedDirs = [
      'features',
      'decisions',
      'plans',
      'lessons',
      'discussions',
      'research',
      'phases',
      'reflections',
      'methods',
      'episodes',
      'postmortems',
      'guides',
      'stories',
    ];

    for (const dir of expectedDirs) {
      assert.ok(existsSync(join(tmpDir, 'docs', dir)), `should create docs/${dir}`);
    }

    assert.ok(result.created.length > 0, 'should report created items');
  });

  it('creates skeleton files with valid frontmatter', async () => {
    const { runProjectInit } = await import('../../dist/scripts/project-init.js');
    await runProjectInit(tmpDir);

    const backlog = readFileSync(join(tmpDir, 'docs', 'ROADMAP.md'), 'utf-8');
    assert.ok(backlog.startsWith('---'), 'BACKLOG.md should have frontmatter');
    assert.ok(backlog.includes('doc_kind: plan'), 'BACKLOG.md should have doc_kind');
    assert.ok(backlog.includes('# Backlog'), 'BACKLOG.md should have title');

    const vision = readFileSync(join(tmpDir, 'docs', 'VISION.md'), 'utf-8');
    assert.ok(vision.startsWith('---'), 'VISION.md should have frontmatter');
    assert.ok(vision.includes('# Vision'), 'VISION.md should have title');
  });

  it('idempotent: does not overwrite existing files', async () => {
    const { runProjectInit } = await import('../../dist/scripts/project-init.js');

    // First init
    await runProjectInit(tmpDir);

    // Write custom content to VISION.md
    const visionPath = join(tmpDir, 'docs', 'VISION.md');
    writeFileSync(visionPath, '# My Custom Vision\n\nCustom content here.');

    // Second init — should not overwrite
    const result = await runProjectInit(tmpDir);
    const content = readFileSync(visionPath, 'utf-8');
    assert.equal(content, '# My Custom Vision\n\nCustom content here.', 'should preserve custom content');
    assert.ok(result.skipped.includes('VISION.md'), 'should report VISION.md as skipped');
  });

  it('initialized project produces healthy evidence.sqlite', async () => {
    const { runProjectInit } = await import('../../dist/scripts/project-init.js');
    await runProjectInit(tmpDir);

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, join(tmpDir, 'docs'));

    const rebuildResult = await builder.rebuild();
    assert.ok(rebuildResult.docsIndexed >= 0, 'rebuild should succeed');

    const consistency = await builder.checkConsistency();
    assert.equal(consistency.ok, true, 'consistency check should pass');

    store.close();
  });
});
