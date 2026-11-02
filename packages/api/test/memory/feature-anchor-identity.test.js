import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CatCafeScanner, extractFrontmatter } from '../../dist/domains/memory/CatCafeScanner.js';
import { GraphResolver } from '../../dist/domains/memory/GraphResolver.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

test('repository feature metadata declares exactly one primary anchor per feature', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs');
  const scanner = new CatCafeScanner();
  const declarations = new Map();
  for (const name of readdirSync(join(root, 'features')).filter((name) => name.endsWith('.md'))) {
    const path = join(root, 'features', name);
    const ids = extractFrontmatter(readFileSync(path, 'utf8'))?.feature_ids;
    if (!Array.isArray(ids) || !/^F\d+$/.test(ids[0] ?? '')) continue;
    const rows = declarations.get(ids[0]) ?? [];
    rows.push(scanner.parseSingle(path, root).item);
    declarations.set(ids[0], rows);
  }
  const collisions = [...declarations].flatMap(([id, rows]) => {
    const primary = rows.filter((row) => row.anchor === id);
    return primary.length === 1 ? [] : [{ id, primarySources: primary.map((row) => row.sourcePath) }];
  });
  assert.deepEqual(collisions, [], 'an appendix must keep its own path identity instead of replacing the feature');
});

function source(feature, title, body, anchor) {
  return `---\nfeature_ids: [${feature}]\ndoc_kind: spec\n${anchor ? `anchor: ${anchor}\n` : ''}---\n\n# ${title}\n\n${body}\n`;
}

test('an explicit anchor rename without another claimant retires the old document and passages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'document-rekey-'));
  const docs = join(root, 'docs');
  mkdirSync(join(docs, 'features'), { recursive: true });
  const path = join(docs, 'features', 'F903-reference.md');
  const oldAnchor = 'doc:reference-old';
  const newAnchor = 'doc:reference-new';
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  try {
    await store.initialize();
    const builder = makeBuilder(store, docs, false);
    writeFileSync(path, source('F903', 'Reference', 'rekeycitrine unchanged body', oldAnchor));
    await builder.incrementalUpdate([path]);
    assert.ok(await store.getByAnchor(oldAnchor));
    writeFileSync(path, source('F903', 'Reference', 'rekeycitrine unchanged body', newAnchor));
    await builder.incrementalUpdate([path]);
    assert.equal(await store.getByAnchor(oldAnchor), null);
    assert.equal(
      store.getDb().prepare('SELECT COUNT(*) AS count FROM evidence_passages WHERE doc_anchor=?').get(oldAnchor).count,
      0,
    );
    const results = await store.search('rekeycitrine', { scope: 'docs', mode: 'lexical', depth: 'raw' });
    assert.deepEqual(
      results.map((item) => item.anchor),
      [newAnchor],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function makeBuilder(store, root, reverse) {
  const parser = new CatCafeScanner();
  // Keep the production parser, deliberately vary discovery order without using a second parser.
  const scanner = {
    discover(path) {
      const rows = parser.discover(path);
      return reverse ? rows.reverse() : rows;
    },
    parseSingle: (path, scanRoot) => parser.parseSingle(path, scanRoot),
  };
  return new IndexBuilder(store, root, undefined, undefined, undefined, undefined, undefined, scanner);
}

async function assertReadablePair(store, feature, supportAnchor) {
  const primary = await store.getByAnchor(feature);
  assert.equal(primary?.title, 'Neutral service', 'feature lookup must resolve its main document');
  const support = await store.getByAnchor(supportAnchor);
  assert.equal(support?.title, 'Protocol supplement', 'the supplementary source must remain independently readable');
  assert.ok(support.keywords?.includes(feature), 'a path-anchored spec still carries the feature reference');
  const hits = await store.search('payloadquartz', { scope: 'docs', mode: 'lexical', depth: 'raw', limit: 5 });
  assert.ok(
    hits.some((hit) => hit.anchor === supportAnchor),
    'supplementary body must remain searchable',
  );
  const manifest = { id: 'project:neutral', kind: 'project', sensitivity: 'internal' };
  const graph = new GraphResolver({ list: () => [manifest], get: () => manifest }, new Map([[manifest.id, store]]));
  const result = await graph.buildSubgraph(feature, { centerCollectionId: manifest.id, depth: 1 });
  assert.equal(result.nodes.find((node) => node.anchor === feature)?.title, 'Neutral service');
  const supportResult = await graph.buildSubgraph(supportAnchor, { centerCollectionId: manifest.id, depth: 1 });
  assert.equal(supportResult.nodes.find((node) => node.anchor === supportAnchor)?.title, 'Protocol supplement');
}

for (const [feature, reverse] of [
  ['F901', false],
  ['F902', true],
]) {
  test(`${feature}: rekeying a legacy same-kind winner restores main and support through incremental update, rebuild and reopen`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'feature-anchor-'));
    const docs = join(root, 'docs');
    mkdirSync(join(docs, 'features'), { recursive: true });
    const main = join(docs, 'features', `${feature}-service.md`);
    const appendix = join(docs, 'features', `${feature}-protocol.md`);
    const supportAnchor = `doc:features/${feature}-protocol`;
    writeFileSync(main, source(feature, 'Neutral service', 'The primary user journey.'));
    writeFileSync(appendix, source(feature, 'Protocol supplement', 'payloadquartz is the complete appendix body.'));
    const database = join(root, 'evidence.sqlite');
    let store = new SqliteEvidenceStore(database);
    try {
      await store.initialize();
      let builder = makeBuilder(store, docs, reverse);
      await builder.incrementalUpdate([main, appendix]);
      assert.equal(
        (await store.getByAnchor(feature)).title,
        'Protocol supplement',
        'legacy fixture must reproduce the real same-kind collision',
      );

      // Existing explicit anchor metadata separates the sources; update only that file.
      writeFileSync(
        appendix,
        source(feature, 'Protocol supplement', 'payloadquartz is the complete appendix body.', supportAnchor),
      );
      await builder.incrementalUpdate([appendix]);
      await assertReadablePair(store, feature, supportAnchor);
      const rows = store
        .getDb()
        .prepare('SELECT anchor FROM evidence_docs WHERE source_path = ?')
        .all(`features/${feature}-protocol.md`);
      assert.deepEqual(
        rows.map((row) => row.anchor),
        [supportAnchor],
        'anchor change must not leave an alias row for the same source',
      );

      await builder.rebuild({ force: true });
      await assertReadablePair(store, feature, supportAnchor);
      assert.ok(
        (await store.getRelated(supportAnchor)).some((edge) => edge.anchor === feature),
        'full graph retains the declared feature reference',
      );
      await builder.incrementalUpdate(reverse ? [appendix, main] : [main, appendix]);
      await assertReadablePair(store, feature, supportAnchor);
      store.close();
      store = new SqliteEvidenceStore(database);
      await store.initialize();
      builder = makeBuilder(store, docs, !reverse);
      await builder.rebuild();
      await assertReadablePair(store, feature, supportAnchor);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
