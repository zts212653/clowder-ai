import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('IndexBuilder edge extraction integration', () => {
  it('creates wikilink + feature_ref + doc_link edges during rebuild', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const fixtureRoot = join(__dirname, '..', '..', 'fixtures', 'edge-extraction-docs', 'docs');
    const builder = new IndexBuilder(store, fixtureRoot);

    await builder.rebuild();

    const f188Edges = await store.getRelated('F188');
    const wikilinks = f188Edges.filter((e) => e.relation === 'wikilink');
    const featureRefs = f188Edges.filter((e) => e.relation === 'feature_ref');
    const docLinks = f188Edges.filter((e) => e.relation === 'doc_link');
    const frontmatter = f188Edges.filter((e) => e.relation === 'related_to');

    assert.ok(wikilinks.length > 0, 'should have wikilink edges');
    assert.ok(featureRefs.length > 0, 'should have feature_ref edges');
    assert.ok(frontmatter.length > 0, 'should have frontmatter edges');

    assert.ok(
      wikilinks.find((e) => e.anchor === 'F102'),
      'wikilink to F102',
    );
    assert.ok(
      featureRefs.find((e) => e.anchor === 'F186'),
      'feature_ref to F186',
    );
    assert.ok(docLinks.length > 0, 'should have doc_link edges');

    for (const e of [...wikilinks, ...featureRefs, ...docLinks]) {
      assert.equal(e.provenance, 'content');
    }

    store.close();
  });

  it('non-force rebuild preserves doc_link edges (P1-1)', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const fixtureRoot = join(__dirname, '..', '..', 'fixtures', 'edge-extraction-docs', 'docs');
    const builder = new IndexBuilder(store, fixtureRoot);

    await builder.rebuild({ force: true });
    const edgesAfterFirst = await store.getRelated('F188');
    const docLinksFirst = edgesAfterFirst.filter((e) => e.relation === 'doc_link');
    assert.ok(docLinksFirst.length > 0, 'first rebuild should create doc_link edges');

    await builder.rebuild({ force: false });
    const edgesAfterSecond = await store.getRelated('F188');
    const docLinksSecond = edgesAfterSecond.filter((e) => e.relation === 'doc_link');
    assert.equal(
      docLinksSecond.length,
      docLinksFirst.length,
      'non-force rebuild must not lose doc_link edges (pathToAnchor must use scannedItems)',
    );

    store.close();
  });

  it('extracts content edges from docs without YAML frontmatter (cloud-P1-2)', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const fixtureRoot = join(__dirname, '..', '..', 'fixtures', 'edge-extraction-docs', 'docs');
    const builder = new IndexBuilder(store, fixtureRoot);

    await builder.rebuild();

    const planAnchor = 'doc:plans/test-plan';
    const planEdges = await store.getRelated(planAnchor);
    const wikilinks = planEdges.filter((e) => e.relation === 'wikilink');
    const featureRefs = planEdges.filter((e) => e.relation === 'feature_ref');

    assert.ok(wikilinks.length > 0, 'frontmatter-less doc should have wikilink edges');
    assert.ok(featureRefs.length > 0, 'frontmatter-less doc should have feature_ref edges');

    assert.ok(
      wikilinks.find((e) => e.anchor === 'F188' || e.anchor === 'F102'),
      'should have wikilink to F188 or F102',
    );

    store.close();
  });

  it('resolves /docs links in GenericRepoScanner flows (cloud-P1)', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    const projectRoot = mkdtempSync(join(tmpdir(), 'f188-generic-links-'));
    mkdirSync(join(projectRoot, 'docs', 'features'), { recursive: true });
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"generic-test"}');
    writeFileSync(
      join(projectRoot, 'docs', 'features', 'F188-a.md'),
      [
        '---',
        'feature_ids: [F188]',
        'doc_kind: spec',
        '---',
        '',
        '# F188',
        '',
        'See [F186](/docs/features/F186-b.md).',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'docs', 'features', 'F186-b.md'),
      ['---', 'feature_ids: [F186]', 'doc_kind: spec', '---', '', '# F186'].join('\n'),
    );

    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const builder = new IndexBuilder(store, projectRoot);

    await builder.rebuild();

    const f188Edges = await store.getRelated('F188');
    const docLinks = f188Edges.filter((e) => e.relation === 'doc_link');
    assert.ok(
      docLinks.find((e) => e.anchor === 'F186'),
      'Generic repo /docs link should resolve to F186',
    );

    store.close();
  });

  it('does not overwrite root and docs path keys when aliasing doc links (cloud-R2-P2)', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    const projectRoot = mkdtempSync(join(tmpdir(), 'f188-doc-aliases-'));
    mkdirSync(join(projectRoot, 'docs', 'features'), { recursive: true });
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"alias-test"}');
    writeFileSync(join(projectRoot, 'README.md'), '# Root README');
    writeFileSync(join(projectRoot, 'docs', 'README.md'), '# Docs README');
    writeFileSync(
      join(projectRoot, 'docs', 'features', 'F188-a.md'),
      [
        '---',
        'feature_ids: [F188]',
        'doc_kind: spec',
        '---',
        '',
        '# F188',
        '',
        'See [root](../../README.md) and [docs](/docs/README.md).',
      ].join('\n'),
    );

    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const builder = new IndexBuilder(store, projectRoot);

    await builder.rebuild();

    const f188Edges = await store.getRelated('F188');
    const docLinks = f188Edges.filter((e) => e.relation === 'doc_link');
    const targets = new Set(docLinks.map((e) => e.anchor));
    assert.ok(targets.has('doc:README'), 'relative root README link should resolve to root README');
    assert.ok(targets.has('doc:docs/README'), '/docs/README.md link should resolve to docs README');

    store.close();
  });
});
