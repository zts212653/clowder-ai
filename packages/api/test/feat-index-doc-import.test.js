import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { readFeatIndexEntries } = await import('../dist/routes/feat-index-doc-import.js');

async function createRepoSkeleton(root) {
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8');
  await mkdir(join(root, 'docs', 'features'), { recursive: true });
}

test('feature docs override backlog fields for same featId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feat-index-doc-import-'));
  const previousCwd = process.cwd();
  try {
    await createRepoSkeleton(root);
    await writeFile(
      join(root, 'docs', 'ROADMAP.md'),
      [
        '| ID | 名称 | Status | Owner | Link |',
        '|----|------|--------|-------|------|',
        '| F043 | Backlog Name | spec | 三猫 | [F043](docs/features/F043-mcp-unification.md) |',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'docs', 'features', 'F043-mcp-unification.md'),
      [
        '---',
        'feature_ids: [F043]',
        'name: Feature Doc Name',
        'status: in-progress',
        'keyDecisions:',
        '  - Keep feature docs as source-of-truth',
        '---',
        '',
        '# F043: MCP Unification',
      ].join('\n'),
      'utf8',
    );

    process.chdir(root);
    const entries = await readFeatIndexEntries();
    const f043 = entries.find((entry) => entry.featId === 'F043');

    assert.ok(f043, 'F043 should exist');
    assert.equal(f043.name, 'Feature Doc Name');
    assert.equal(f043.status, 'in-progress');
    assert.deepEqual(f043.keyDecisions, ['Keep feature docs as source-of-truth']);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test('feature doc with non-padded filename still indexes by feature_ids frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feat-index-doc-import-'));
  const previousCwd = process.cwd();
  try {
    await createRepoSkeleton(root);
    await writeFile(
      join(root, 'docs', 'features', 'F040-backlog-reorganization.md'),
      [
        '---',
        'feature_ids: [F040]',
        'name: Backlog Reorganization',
        'status: in-progress',
        '---',
        '',
        '# F40: Backlog Reorganization',
      ].join('\n'),
      'utf8',
    );

    process.chdir(root);
    const entries = await readFeatIndexEntries();
    const f040 = entries.find((entry) => entry.featId === 'F040');

    assert.ok(f040, 'F040 should be indexed from feature_ids even when filename is F40-*');
    assert.equal(f040.name, 'Backlog Reorganization');
    assert.equal(f040.status, 'in-progress');
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test('directory entry matching Fxxx*.md does not crash importer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feat-index-doc-import-'));
  const previousCwd = process.cwd();
  try {
    await createRepoSkeleton(root);
    await writeFile(
      join(root, 'docs', 'ROADMAP.md'),
      [
        '| ID | 名称 | Status | Owner | Link |',
        '|----|------|--------|-------|------|',
        '| F043 | Backlog Name | spec | 三猫 | [F043](docs/features/F043-broken.md) |',
      ].join('\n'),
      'utf8',
    );
    await mkdir(join(root, 'docs', 'features', 'F043-broken.md'), { recursive: true });

    process.chdir(root);
    const entries = await readFeatIndexEntries();
    const f043 = entries.find((entry) => entry.featId === 'F043');

    assert.ok(f043, 'F043 should still be available from backlog fallback');
    assert.equal(f043.status, 'spec');
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test('unreadable BACKLOG.md does not crash importer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feat-index-doc-import-'));
  const previousCwd = process.cwd();
  try {
    await createRepoSkeleton(root);
    await writeFile(
      join(root, 'docs', 'features', 'F044-feature.md'),
      ['---', 'feature_ids: [F044]', 'name: Feature 044', 'status: spec', '---', '', '# F044: Example'].join('\n'),
      'utf8',
    );
    await mkdir(join(root, 'docs', 'ROADMAP.md'), { recursive: true });

    process.chdir(root);
    const entries = await readFeatIndexEntries();
    const f044 = entries.find((entry) => entry.featId === 'F044');

    assert.ok(f044, 'feature-doc entries should still return when BACKLOG.md is unreadable');
    assert.equal(f044.name, 'Feature 044');
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
