import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { IndexBuilder } from '../dist/domains/memory/IndexBuilder.js';
import { LibraryCatalog } from '../dist/domains/memory/LibraryCatalog.js';
import { MarkerQueue } from '../dist/domains/memory/MarkerQueue.js';
import { MaterializationService } from '../dist/domains/memory/MaterializationService.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { knowledgeFeedRoutes } from '../dist/routes/knowledge-feed.js';

test('explicit parent target retains lesson anchor/kind/authority while foreign targets retain their own indexer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f321-parent-index-'));
  const docsRoot = join(root, 'docs');
  const foreignRoot = join(root, 'foreign');
  mkdirSync(join(docsRoot, 'markers'), { recursive: true });
  mkdirSync(foreignRoot);
  const alias = join(root, 'docs-alias');
  symlinkSync(docsRoot, alias);
  const store = new SqliteEvidenceStore(join(root, 'parent.sqlite'));
  const foreignStore = new SqliteEvidenceStore(join(root, 'foreign.sqlite'));
  const app = Fastify();
  try {
    await store.initialize();
    await foreignStore.initialize();
    const queue = new MarkerQueue(join(docsRoot, 'markers'));
    const service = new MaterializationService(queue, docsRoot, new IndexBuilder(store, docsRoot));
    const catalog = new LibraryCatalog();
    for (const [id, collectionRoot] of [
      ['domain:parent', alias],
      ['domain:foreign', foreignRoot],
    ]) {
      catalog.register({
        id,
        root: collectionRoot,
        kind: 'domain',
        name: id.split(':')[1],
        displayName: id,
        sensitivity: 'internal',
        scannerLevel: 0,
        status: 'active',
        indexPolicy: { autoRebuild: true },
        reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
        createdAt: '2026-10-03',
        updatedAt: '2026-10-03',
      });
    }
    await knowledgeFeedRoutes(app, {
      markerQueue: queue,
      db: store.getDb(),
      materializationService: service,
      catalog,
      collectionStores: new Map([
        ['domain:parent', store],
        ['domain:foreign', foreignStore],
      ]),
    });
    for (const targetCollectionId of [undefined, 'domain:parent', 'domain:foreign']) {
      const marker = await queue.submit({
        content: 'A verified regression scenario',
        source: 'test',
        targetKind: 'lesson',
        status: 'captured',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/knowledge/approve',
        payload: { markerId: marker.id, targetCollectionId },
      });
      assert.equal(res.statusCode, 200);
      const result = res.json();
      assert.equal(result.materialized.reindexed, true);
      const targetStore = targetCollectionId === 'domain:foreign' ? foreignStore : store;
      const rows = targetStore
        .getDb()
        .prepare('SELECT anchor, kind, authority FROM evidence_docs WHERE anchor LIKE ?')
        .all(`%${marker.id}`);
      assert.deepEqual(
        rows,
        targetCollectionId === 'domain:foreign'
          ? [{ anchor: `domain:foreign:doc/lessons/lesson-${marker.id}`, kind: 'research', authority: 'validated' }]
          : [{ anchor: `lesson-${marker.id}`, kind: 'lesson', authority: 'observed' }],
      );
      if (targetCollectionId) {
        assert.equal((await queue.list()).find((m) => m.id === marker.id).targetCollectionId, targetCollectionId);
        assert.match(
          readFileSync(result.materialized.outputPath, 'utf8'),
          new RegExp(`target_collection: ${targetCollectionId}`),
        );
      }
    }
  } finally {
    await app.close();
    store.close();
    foreignStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
