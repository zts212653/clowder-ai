import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CatCafeScanner } from '../../dist/domains/memory/CatCafeScanner.js';
import { GraphResolver } from '../../dist/domains/memory/GraphResolver.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const metadataKey = 'document_source_claims';
const text = (title, body, anchor) =>
  `---\nfeature_ids: [F900]\n${anchor ? `anchor: ${anchor}\n` : ''}doc_kind: spec\n---\n# ${title}\n\n${body}\n`;

function makeIndex(store, root, probe) {
  const parser = new CatCafeScanner();
  return new IndexBuilder(store, root, undefined, undefined, undefined, undefined, undefined, {
    discover(path) {
      probe.discoveries++;
      assert.ok(probe.discoveries <= probe.allowedDiscoveries, 'regular incremental must not rediscover the corpus');
      return parser.discover(path).sort((a, b) => a.item.sourcePath.localeCompare(b.item.sourcePath));
    },
    parseSingle(path, scanRoot) {
      probe.paths.add(path);
      return parser.parseSingle(path, scanRoot);
    },
  });
}

async function graph(store) {
  const manifest = { id: 'project:neutral', kind: 'project', sensitivity: 'internal' };
  return new GraphResolver(
    { list: () => [manifest], get: () => manifest },
    new Map([[manifest.id, store]]),
  ).buildSubgraph('F900', { depth: 1, centerCollectionId: manifest.id });
}

test('full rebuild projects graph content only from the actual same-kind winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'winner-owned-graph-'));
  const features = join(root, 'features');
  mkdirSync(features);
  writeFileSync(join(features, 'a-helper.md'), text('Supporting protocol', '[[F901]]'));
  writeFileSync(join(features, 'z-main.md'), text('Primary journey', 'Canonical primary body.'));
  writeFileSync(join(features, 'target.md'), '---\nfeature_ids: [F901]\n---\n# Target\n');
  const store = new SqliteEvidenceStore(join(root, 'index.sqlite'));
  try {
    await store.initialize();
    await makeIndex(store, root, { discoveries: 0, allowedDiscoveries: 1, paths: new Set() }).rebuild();
    assert.equal((await store.getByAnchor('F900')).title, 'Primary journey');
    assert.ok(!(await graph(store)).edges.some((edge) => edge.from === 'F900' && edge.to === 'F901'));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['same-builder', 'reopened', 'legacy-no-snapshot']) {
  for (const action of ['rekey', 'delete']) {
    test(`main winner / support loser: ${action}, ${mode}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'loser-claim-'));
      const docs = join(root, 'docs');
      const features = join(docs, 'features');
      mkdirSync(features, { recursive: true });
      const main = join(features, 'z-main.md');
      const support = join(features, 'a-helper.md');
      writeFileSync(main, text('Primary journey', '[Support](a-helper.md)'));
      writeFileSync(support, text('Supporting protocol', 'payloadjade [[F901]]'));
      writeFileSync(join(features, 'target.md'), '---\nfeature_ids: [F901]\n---\n# Target\n');
      const database = join(root, 'index.sqlite');
      let store = new SqliteEvidenceStore(database);
      const probe = { discoveries: 0, allowedDiscoveries: 1, paths: new Set() };
      try {
        await store.initialize();
        let index = makeIndex(store, docs, probe);
        await index.rebuild();
        assert.equal((await store.getByAnchor('F900')).sourcePath, 'features/z-main.md', 'main must be the old winner');
        // Persist the R2 legacy mixed-source projection, independent of the new full-rebuild policy.
        await store.addEdge({ fromAnchor: 'F900', toAnchor: 'F901', relation: 'wikilink', provenance: 'content' });
        await store.addEdge({
          fromAnchor: 'F900',
          toAnchor: 'manual-note',
          relation: 'related_to',
          provenance: 'manual',
        });
        assert.ok((await store.getRelated('F900')).some((edge) => edge.anchor === 'F901'));
        if (mode === 'legacy-no-snapshot') {
          store.getDb().prepare('DELETE FROM embedding_meta WHERE key = ?').run(metadataKey);
          probe.allowedDiscoveries++;
        }
        if (mode !== 'same-builder') {
          store.close();
          store = new SqliteEvidenceStore(database);
          await store.initialize();
          index = makeIndex(store, docs, probe);
        }
        probe.paths.clear();
        let writes = 0;
        const upsert = store.upsertForDocumentIndex.bind(store);
        store.upsertForDocumentIndex = (...args) => {
          writes++;
          return upsert(...args);
        };
        if (action === 'rekey')
          writeFileSync(support, text('Supporting protocol', 'payloadjade [[F901]]', 'doc:helper'));
        else unlinkSync(support);
        await index.incrementalUpdate([support]);
        assert.equal((await store.getByAnchor('F900')).title, 'Primary journey');
        const result = await graph(store);
        assert.ok(
          !result.edges.some((edge) => edge.from === 'F900' && edge.to === 'F901' && edge.relation === 'wikilink'),
          'loser contribution must leave the shared primary identity',
        );
        assert.ok(
          (await store.getRelated('F900')).some(
            (edge) => edge.anchor === 'manual-note' && edge.provenance === 'manual',
          ),
        );
        if (action === 'rekey') {
          assert.ok(
            result.edges.some(
              (edge) => edge.from === 'F900' && edge.to === 'doc:helper' && edge.relation === 'doc_link',
            ),
            'the formerly suppressed self-link must resolve immediately',
          );
          assert.equal((await store.getByAnchor('doc:helper')).title, 'Supporting protocol');
          const hits = await store.search('payloadjade', { scope: 'docs', mode: 'lexical', depth: 'raw' });
          assert.ok(hits.some((hit) => hit.anchor === 'doc:helper'));
        }
        assert.equal(
          writes,
          action === 'rekey' ? 1 : 0,
          'loser changes must not rebuild or rewrite unrelated document rows',
        );
        assert.equal(probe.discoveries, probe.allowedDiscoveries);
        if (mode !== 'legacy-no-snapshot')
          assert.ok(
            [...probe.paths].every((path) => path === main || path === support),
            'only affected sources may be reparsed',
          );
        store.close();
        store = new SqliteEvidenceStore(database);
        await store.initialize();
        const reopened = await graph(store);
        assert.ok(
          !reopened.edges.some((edge) => edge.from === 'F900' && edge.to === 'F901' && edge.relation === 'wikilink'),
        );
        assert.equal((await store.getByAnchor('F900')).title, 'Primary journey');
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
