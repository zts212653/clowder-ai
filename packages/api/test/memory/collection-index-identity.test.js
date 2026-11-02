import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { CollectionIndexBuilder } from '../../dist/domains/memory/CollectionIndexBuilder.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { StructuredScanner } from '../../dist/domains/memory/StructuredScanner.js';

it('uses the producer source identity when transferring and deleting an indexed anchor', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'issue1450-index-key-'));
  mkdirSync(join(root, 'features'));
  const file = join(root, 'features', 'source.md');
  const store = new SqliteEvidenceStore(':memory:');
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.initialize();
  const builder = new IndexBuilder(store, root);
  writeFileSync(file, '---\nanchor: doc:prior\n---\n# Prior');
  await builder.rebuild();
  assert.equal((await store.getByAnchor('doc:prior')).sourcePath, 'features/source.md');
  writeFileSync(file, '---\nanchor: doc:current\n---\n# Current');
  await builder.incrementalUpdate([file]);
  assert.equal(await store.getByAnchor('doc:prior'), null, 'old source identity must be retired');
  assert.equal((await store.getByAnchor('doc:current')).sourcePath, 'features/source.md');
  unlinkSync(file);
  await builder.incrementalUpdate([file]);
  assert.equal(await store.getByAnchor('doc:current'), null, 'deleted source must not retain its indexed identity');
});

it(
  'refreshes legacy collection metadata even when an explicit anchor and hash are stable',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'issue1450-collection-legacy-'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'source.md'), '---\nanchor: doc:stable\n---\n# Stable');
    const store = new SqliteEvidenceStore(':memory:');
    t.after(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await store.initialize();
    const manifest = { id: 'probe', root, reviewPolicy: { authorityCeiling: 'validated' } };
    const builder = new CollectionIndexBuilder(store, manifest, new StructuredScanner('probe'));
    await builder.rebuild();
    const indexed = await store.getByAnchor('probe:doc:stable');
    await store.upsert([{ ...indexed, sourcePath: 'nested\\source.md' }]);
    await builder.rebuild();
    assert.equal((await store.getByAnchor('probe:doc:stable')).sourcePath, 'nested/source.md');
  },
);

it('refreshes legacy Windows source metadata during a rebuild', { skip: process.platform !== 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'issue1450-index-legacy-'));
  mkdirSync(join(root, 'features'));
  writeFileSync(join(root, 'features', 'source.md'), '---\nanchor: doc:stable\n---\n# Stable');
  const store = new SqliteEvidenceStore(':memory:');
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.initialize();
  const builder = new IndexBuilder(store, root);
  await builder.rebuild();
  const indexed = await store.getByAnchor('doc:stable');
  await store.upsert([{ ...indexed, sourcePath: 'features\\source.md' }]);
  await builder.rebuild();
  assert.equal((await store.getByAnchor('doc:stable')).sourcePath, 'features/source.md');
});
