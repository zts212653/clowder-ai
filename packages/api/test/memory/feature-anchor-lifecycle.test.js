import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CatCafeScanner } from '../../dist/domains/memory/CatCafeScanner.js';
import { GenericRepoScanner } from '../../dist/domains/memory/GenericRepoScanner.js';
import { GraphResolver } from '../../dist/domains/memory/GraphResolver.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { StructuredScanner } from '../../dist/domains/memory/StructuredScanner.js';

function builder(store, root, scanner = new CatCafeScanner()) {
  return new IndexBuilder(store, root, undefined, undefined, undefined, undefined, undefined, scanner);
}

async function featureGraph(store) {
  const manifest = { id: 'project:neutral', kind: 'project', sensitivity: 'internal' };
  return new GraphResolver(
    { list: () => [manifest], get: () => manifest },
    new Map([[manifest.id, store]]),
  ).buildSubgraph('F900', { depth: 1, centerCollectionId: manifest.id });
}

function support(anchor) {
  return `---\nanchor: ${anchor}\nfeature_ids: [F900]\nrelated_features: [F901]\nsupersedes: F905\ndoc_kind: spec\n---\n# Helper\n\n[[F902]]\n\nF903\n\n[Detail](F904-detail.md)\n`;
}

for (const action of ['rekey', 'delete']) {
  test(`incremental ${action} retires only the old source-owned graph projection`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-edge-lifecycle-'));
    const docs = join(root, 'docs');
    const features = join(docs, 'features');
    mkdirSync(features, { recursive: true });
    for (const id of ['F900', 'F901', 'F902', 'F903', 'F904', 'F905']) {
      writeFileSync(join(features, `${id}-detail.md`), `---\nfeature_ids: [${id}]\n---\n# Neutral ${id}\n`);
    }
    const source = join(features, 'support.md');
    const oldAnchor = 'doc:support-old';
    const newAnchor = 'doc:support-new';
    writeFileSync(
      join(features, 'F902-detail.md'),
      `---\nfeature_ids: [F902]\n---\n# Neutral F902\n\n[[${oldAnchor}]]\n`,
    );
    writeFileSync(
      join(features, 'F900-detail.md'),
      '---\nfeature_ids: [F900]\n---\n# Neutral F900\n\n[Supporting source](support.md)\n',
    );
    writeFileSync(source, support(oldAnchor));
    const database = join(root, 'index.sqlite');
    let store = new SqliteEvidenceStore(database);
    try {
      await store.initialize();
      const index = builder(store, docs);
      await index.rebuild();
      const expected = [
        ['F900', 'related_to'],
        ['F901', 'related_to'],
        ['F902', 'wikilink'],
        ['F903', 'feature_ref'],
        ['F904', 'doc_link'],
        ['F905', 'supersedes'],
      ];
      const owned = (anchor) =>
        store
          .getDb()
          .prepare(
            "SELECT to_anchor, relation FROM edges WHERE from_anchor = ? AND provenance IN ('frontmatter','content') ORDER BY to_anchor",
          )
          .all(anchor)
          .map((row) => [row.to_anchor, row.relation]);
      assert.deepEqual(owned(oldAnchor), expected, 'fixture must contain all existing derived edge kinds');
      assert.ok((await featureGraph(store)).nodes.some((node) => node.anchor === oldAnchor));
      await store.addEdge({
        fromAnchor: oldAnchor,
        toAnchor: 'manual-note',
        relation: 'related_to',
        provenance: 'manual',
      });

      if (action === 'rekey') writeFileSync(source, support(newAnchor));
      else unlinkSync(source);
      await index.incrementalUpdate([source]);
      assert.equal(await store.getByAnchor(oldAnchor), null);
      assert.deepEqual(owned(oldAnchor), [], 'retired source must not project stale graph identity');
      assert.equal(
        store
          .getDb()
          .prepare("SELECT COUNT(*) AS n FROM edges WHERE from_anchor=? AND provenance='manual'")
          .get(oldAnchor).n,
        1,
      );
      assert.equal(
        store
          .getDb()
          .prepare("SELECT COUNT(*) AS n FROM edges WHERE from_anchor='F902' AND to_anchor=? AND provenance='content'")
          .get(oldAnchor).n,
        1,
        'other source declarations are not owned by the retired source',
      );
      const graph = await featureGraph(store);
      assert.ok(
        !graph.nodes.some((node) => node.anchor === oldAnchor),
        'ordinary feature graph must not expose a retired source projection',
      );
      if (action === 'rekey') {
        assert.deepEqual(
          owned(newAnchor),
          expected,
          'new identity projects edges immediately, without a force rebuild',
        );
        assert.ok(graph.nodes.some((node) => node.anchor === newAnchor));
      }
      store.close();
      store = new SqliteEvidenceStore(database);
      await store.initialize();
      assert.deepEqual(owned(oldAnchor), []);
      assert.ok(!(await featureGraph(store)).nodes.some((node) => node.anchor === oldAnchor));
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const kind of ['cat-cafe', 'generic', 'structured']) {
  test(`${kind}: ordinary rebuild migrates same-hash version-14 supporting-source keywords`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-keyword-migration-'));
    const docs = join(root, 'docs');
    mkdirSync(join(docs, 'features'), { recursive: true });
    const path = join(docs, 'features', 'support.md');
    writeFileSync(
      path,
      '---\nanchor: doc:helper\nfeature_ids: [F900]\ndoc_kind: spec\n---\n# Helper\n\nUnchanged payload.\n',
    );
    const scanRoot = kind === 'generic' ? root : docs;
    const scanner =
      kind === 'generic'
        ? new GenericRepoScanner()
        : kind === 'structured'
          ? new StructuredScanner('project:neutral')
          : new CatCafeScanner();
    const database = join(root, 'index.sqlite');
    let store = new SqliteEvidenceStore(database);
    try {
      await store.initialize();
      const anchor = scanner.discover(scanRoot)[0].item.anchor;
      await builder(store, scanRoot, scanner).rebuild();
      const original = await store.getByAnchor(anchor);
      assert.ok(original.sourceHash);
      // Persist the prior projection with exactly the current source hash and provenance.
      store.getDb().prepare('UPDATE evidence_docs SET keywords = NULL WHERE anchor = ?').run(anchor);
      store.getDb().prepare("UPDATE embedding_meta SET value = '14' WHERE key = 'indexing_version'").run();
      store.close();
      store = new SqliteEvidenceStore(database);
      await store.initialize();
      assert.equal((await store.getByAnchor(anchor)).keywords, undefined);
      const result = await builder(store, scanRoot, scanner).rebuild();
      assert.equal(result.docsIndexed, 1, 'normal restart must re-derive the version-14 row despite equal source hash');
      const migrated = await store.getByAnchor(anchor);
      assert.equal(migrated.sourceHash, original.sourceHash);
      assert.ok(migrated.keywords?.includes('F900'), 'existing supporting source must gain its feature reference');
      assert.equal(
        (await builder(store, scanRoot, scanner).rebuild()).docsSkipped,
        1,
        'new version converges and resumes normal hash skipping',
      );
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
