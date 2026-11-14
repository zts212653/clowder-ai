import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { discoverFiles } from '@cat-cafe/shared/scanner-discovery-pure';
import { PublishedDocumentIndex } from '../../dist/domains/memory/PublishedDocumentIndex.js';
import { PublishedDocumentSource } from '../../dist/domains/memory/PublishedDocumentSource.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { createRemoteFixture, git } from '../taste-publication-fixtures.js';

test('published discovery preserves the existing kind/archive/fallback ranges and depth limits', async () => {
  const f = createRemoteFixture();
  try {
    const paths = [
      'features/published.md',
      'features/nested/study/allowed.md',
      'mailbox/excluded.md',
      'archive/2026-02/bug-report/excluded.md',
      'archive/2026-02/features/allowed.md',
      'custom/features/excluded.md',
      'custom/node_modules/excluded.md',
      'custom/prior-art.md',
      'features/exported-threads/excluded.md',
      'exported-threads/excluded.md',
      'features/uppercase.MD',
      'overview.md',
      'diagram.svg',
      `features/${'nested/'.repeat(10)}at-limit.md`,
      `features/${'nested/'.repeat(11)}too-deep.md`,
      `${'custom/'.repeat(10)}at-limit.md`,
      `${'custom/'.repeat(11)}too-deep.md`,
      `archive/2026-02/features/${'nested/'.repeat(10)}at-limit.md`,
      `archive/2026-02/features/${'nested/'.repeat(11)}too-deep.md`,
    ];
    const docs = join(f.primary, 'docs');
    for (const path of paths) {
      mkdirSync(dirname(join(docs, path)), { recursive: true });
      writeFileSync(join(docs, path), '# Discovery fixture\n');
    }
    git(f.primary, ['add', 'docs']);
    git(f.primary, ['commit', '-m', 'publish discovery boundaries']);
    git(f.primary, ['push', 'origin', 'main']);
    const expected = [
      ...paths.filter((path) => !path.includes('/excluded') && !path.endsWith('too-deep.md') && !path.endsWith('.MD')),
      'taste/index.md',
    ].sort();
    assert.deepEqual(
      discoverFiles(docs)
        .map((file) => relative(docs, file.path))
        .sort(),
      expected,
      'the shared filesystem consumer keeps its original discovery contract',
    );
    const snapshot = await new PublishedDocumentSource(f.primary).snapshot();
    assert.deepEqual([...snapshot.files.keys()].sort(), expected);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a changed discovery boundary replaces its checkpoint even at the same publication revision', async () => {
  const f = createRemoteFixture();
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  try {
    const source = new PublishedDocumentSource(f.primary);
    const index = new PublishedDocumentIndex(source, store);
    const first = await index.open();
    await index.commit(first);
    source.addExcludePatterns(['taste/**']);
    const narrowed = await index.open();
    assert.equal(narrowed.revision, first.revision);
    assert.ok(index.changes(narrowed).includes('taste/index.md'));
    await index.commit(narrowed);
    assert.deepEqual(index.changes(await index.open()), [], 'removed paths must not recur on every tick');
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
