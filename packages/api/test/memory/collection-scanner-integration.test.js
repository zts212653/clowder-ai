// F186 Phase B Task 5: Integration test — end-to-end collection scan + search

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('Collection scanner integration', () => {
  let FlatScanner, StructuredScanner, resolveCollectionScanner, CollectionIndexBuilder, SqliteEvidenceStore;
  let store, dbPath;

  beforeEach(async () => {
    ({ FlatScanner } = await import('../../dist/domains/memory/FlatScanner.js'));
    ({ StructuredScanner } = await import('../../dist/domains/memory/StructuredScanner.js'));
    ({ resolveCollectionScanner } = await import('../../dist/domains/memory/scanner-resolver.js'));
    ({ CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    dbPath = join(mkdtempSync(join(tmpdir(), 'integ-')), 'test.sqlite');
    store = new SqliteEvidenceStore(dbPath);
    await store.initialize();
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {}
  });

  const makeManifest = (overrides) => ({
    id: 'domain:test',
    kind: 'domain',
    name: 'test',
    displayName: 'Test',
    root: '/tmp',
    sensitivity: 'internal',
    scannerLevel: 0,
    indexPolicy: { autoRebuild: true },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-05-04',
    updatedAt: '2026-05-04',
    ...overrides,
  });

  it('Level 0: indexes plain markdown and finds via search', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'));
    writeFileSync(join(dir, 'quantum.md'), '# Quantum Computing\n\nQuantum bits enable parallel computation.');
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes', 'entanglement.md'), '# Entanglement\n\nSpooky action at a distance.');

    const manifest = makeManifest({ id: 'domain:physics', root: dir, scannerLevel: 0 });
    const scanner = resolveCollectionScanner(manifest);
    assert.ok(scanner instanceof FlatScanner);

    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    const result = await builder.rebuild();
    assert.equal(result.indexed, 2);

    const results = await store.search('quantum');
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.anchor.includes('quantum')));
  });

  it('Level 1: leverages frontmatter for richer indexing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'struct-'));
    writeFileSync(
      join(dir, 'adr.md'),
      '---\ndoc_kind: decision\ntopics: [architecture, api]\nanchor: ADR-001\n---\n# API Decision\n\nWe chose REST.',
    );
    writeFileSync(join(dir, 'note.md'), '# Plain Note\n\nNo frontmatter.');

    const manifest = makeManifest({ id: 'domain:api', root: dir, scannerLevel: 1 });
    const scanner = resolveCollectionScanner(manifest);
    assert.ok(scanner instanceof StructuredScanner);

    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    await builder.rebuild();

    const adr = await store.getByAnchor('domain:api:ADR-001');
    assert.ok(adr);
    assert.equal(adr.kind, 'decision');
    assert.ok(adr.keywords?.includes('architecture'));
  });

  it('auto level detects structure from SUMMARY.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-'));
    writeFileSync(join(dir, 'SUMMARY.md'), '# Summary\n\n- [Intro](intro.md)');
    writeFileSync(join(dir, 'intro.md'), '# Intro\n\nContent.');

    const manifest = makeManifest({ id: 'domain:book', root: dir, scannerLevel: 'auto' });
    const scanner = resolveCollectionScanner(manifest);
    assert.ok(scanner instanceof StructuredScanner);
  });
});
