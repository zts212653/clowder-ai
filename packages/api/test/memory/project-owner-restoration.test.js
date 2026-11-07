import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  deriveProjectCollectionId,
  ensureProjectCollection,
} from '../../dist/domains/memory/bootstrap-collection-bridge.js';
import { CollectionIndexBuilder } from '../../dist/domains/memory/CollectionIndexBuilder.js';
import { ExpeditionBootstrapService } from '../../dist/domains/memory/ExpeditionBootstrapService.js';
import {
  loadExternalCollections,
  resolveCollectionStorePath,
  saveExternalCollection,
} from '../../dist/domains/memory/external-collections.js';
import { IndexStateManager } from '../../dist/domains/memory/IndexStateManager.js';
import { LibraryCatalog } from '../../dist/domains/memory/LibraryCatalog.js';
import { registerPrivateAndExternalCollections } from '../../dist/domains/memory/private-collection-bindings.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { resolveCollectionScanner } from '../../dist/domains/memory/scanner-resolver.js';
import { projectsBootstrapRoutes } from '../../dist/routes/projects-bootstrap.js';

for (const sensitivity of ['restricted', 'private']) {
  for (const scenario of ['restore', 'other-owner', 'unbound', 'duplicate']) {
    test(`offline ${sensitivity} project: ${scenario} preserves its saved policy`, async (t) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-owner-restore-')));
      const project = join(root, 'project');
      const dataDir = join(root, 'data');
      mkdirSync(project);
      writeFileSync(join(project, 'README.md'), '# Existing\n\nPreviously indexed content.\n');
      const id = deriveProjectCollectionId(project);
      const now = new Date().toISOString();
      const manifest = {
        id,
        kind: 'project',
        name: id.slice('project:'.length),
        displayName: 'Saved project policy',
        root: project,
        ...(scenario === 'unbound' ? {} : { ownerUserId: 'owner-a' }),
        sensitivity,
        scannerLevel: 'auto',
        indexPolicy: { autoRebuild: false, rebuildIntervalMs: 12345 },
        reviewPolicy: { authorityCeiling: 'candidate', requireOwnerApproval: true },
        createdAt: now,
        updatedAt: now,
      };
      saveExternalCollection(dataDir, manifest);
      if (scenario === 'duplicate') saveExternalCollection(dataDir, { ...manifest, sensitivity: 'private' });
      // Another offline record must not make an available target fail validation.
      saveExternalCollection(dataDir, {
        ...manifest,
        id: 'project:offline-peer',
        name: 'offline-peer',
        root: join(root, 'still-offline'),
        ownerUserId: 'owner-b',
      });
      const storePath = resolveCollectionStorePath(dataDir, id);
      mkdirSync(dirname(storePath), { recursive: true });
      const oldStore = new SqliteEvidenceStore(storePath, undefined, { sourceRoot: project, sourceRef: id });
      await oldStore.initialize();
      await new CollectionIndexBuilder(oldStore, manifest, resolveCollectionScanner(manifest)).rebuild();
      oldStore.close();
      const storeDigest = () => createHash('sha256').update(readFileSync(storePath)).digest('hex');
      const storeBefore = storeDigest();
      const manifestPath = join(dataDir, 'library', 'collections.json');
      const savedBefore = readFileSync(manifestPath, 'utf8');

      rmSync(project, { recursive: true, force: true });
      const catalog = new LibraryCatalog();
      const stores = new Map();
      await registerPrivateAndExternalCollections({
        catalog,
        stores,
        dataDir,
        externalManifests: loadExternalCollections(dataDir),
        privateUserId: 'owner-a',
        now,
      });
      assert.equal(catalog.get(id), undefined);
      assert.equal(stores.has(id), false);
      mkdirSync(project);
      writeFileSync(join(project, 'README.md'), '# Restored\n\nNewly available content.\n');
      const primary = new SqliteEvidenceStore(':memory:');
      await primary.initialize();
      const state = new IndexStateManager(primary.getDb());
      let fingerprint = 1;
      const service = new ExpeditionBootstrapService(state, {
        getFingerprint: () => `restored:${fingerprint}`,
        rebuildIndex: (path, owner) => ensureProjectCollection(path, catalog, stores, dataDir, owner),
      });
      let pending;
      const app = Fastify();
      await app.register(projectsBootstrapRoutes, {
        stateManager: state,
        bootstrapService: { bootstrap: (...args) => (pending = service.bootstrap(...args)) },
        socketManager: { emitToUser() {} },
      });
      t.after(async () => {
        await app.close();
        for (const store of stores.values()) store.close();
        primary.close();
        rmSync(root, { recursive: true, force: true });
      });
      const bootstrap = () =>
        app.inject({
          method: 'POST',
          url: '/api/projects/bootstrap',
          headers: { 'x-cat-cafe-user': scenario === 'other-owner' ? 'owner-b' : 'owner-a' },
          payload: { projectPath: project },
        });
      assert.equal((await bootstrap()).statusCode, 202);
      const result = await pending;
      assert.equal(readFileSync(manifestPath, 'utf8'), savedBefore);
      if (scenario === 'restore') {
        assert.equal(result.status, 'ready');
        assert.deepEqual(catalog.get(id), manifest);
        assert.equal(stores.size, 1);
        fingerprint++;
        assert.equal((await bootstrap()).statusCode, 202);
        assert.equal((await pending).status, 'ready');
        assert.deepEqual(catalog.get(id), manifest);
        assert.equal(readFileSync(manifestPath, 'utf8'), savedBefore);
        assert.equal(stores.get(id).getDb().prepare('SELECT COUNT(*) AS n FROM evidence_docs').get().n, 1);
      } else {
        assert.equal(result.status, 'failed');
        const expected = {
          'other-owner': 'project_collection_owner_mismatch',
          unbound: 'project_collection_owner_unbound',
          duplicate: 'external_collection_manifest_duplicate',
        }[scenario];
        assert.equal(result.error, expected);
        assert.equal(catalog.get(id), undefined);
        assert.equal(stores.size, 0);
        assert.equal(storeDigest(), storeBefore);
      }
    });
  }
}
