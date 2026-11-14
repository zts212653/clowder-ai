import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import {
  deriveProjectCollectionId,
  ensureProjectCollection,
} from '../../dist/domains/memory/bootstrap-collection-bridge.js';
import { CollectionIndexBuilder } from '../../dist/domains/memory/CollectionIndexBuilder.js';
import { ExpeditionBootstrapService } from '../../dist/domains/memory/ExpeditionBootstrapService.js';
import { loadExternalCollections, saveExternalCollection } from '../../dist/domains/memory/external-collections.js';
import { IndexStateManager } from '../../dist/domains/memory/IndexStateManager.js';
import { LibraryCatalog } from '../../dist/domains/memory/LibraryCatalog.js';
import { registerPrivateAndExternalCollections } from '../../dist/domains/memory/private-collection-bindings.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { resolveCollectionScanner } from '../../dist/domains/memory/scanner-resolver.js';
import { sessionAuthPlugin, sessionRoute } from '../../dist/infrastructure/session-auth.js';
import { projectsBootstrapRoutes } from '../../dist/routes/projects-bootstrap.js';
import { projectSetupRoute } from '../../dist/routes/projects-setup.js';

for (const sensitivity of ['private', 'restricted'])
  test(`a persisted unbound ${sensitivity} project stays rejected after real startup registration`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pr6742-unbound-')));
    const project = join(root, 'project');
    const dataDir = join(root, 'data');
    mkdirSync(project);
    writeFileSync(join(project, 'README.md'), '# Legacy\n\nThis document must not be indexed.\n');
    const id = deriveProjectCollectionId(project);
    const now = new Date().toISOString();
    saveExternalCollection(dataDir, {
      id,
      kind: 'project',
      name: id.slice('project:'.length),
      displayName: 'Legacy',
      root: project,
      sensitivity,
      scannerLevel: 'auto',
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'candidate', requireOwnerApproval: false },
      createdAt: now,
      updatedAt: now,
    });
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
    const legacyStore = stores.get(id);
    assert.ok(legacyStore, 'startup must load the persisted legacy store');
    const digest = () => createHash('sha256').update(legacyStore.getDb().serialize()).digest('hex');
    await new CollectionIndexBuilder(legacyStore, catalog.get(id), resolveCollectionScanner(catalog.get(id))).rebuild();
    writeFileSync(
      join(project, 'README.md'),
      '# Changed\n\nAn unbound rebuild must not replace the existing document.\n',
    );
    const before = digest();
    const savedBefore = readFileSync(join(dataDir, 'library', 'collections.json'), 'utf8');
    const catalogBefore = structuredClone(catalog.get(id));
    const primary = new SqliteEvidenceStore(':memory:');
    await primary.initialize();
    const state = new IndexStateManager(primary.getDb());
    const service = new ExpeditionBootstrapService(state, {
      getFingerprint: () => 'legacy-changed',
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
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/bootstrap',
      headers: { 'x-cat-cafe-user': 'owner-a' },
      payload: { projectPath: project },
    });
    assert.equal(response.statusCode, 202);
    const result = await pending;
    const diskManifest = JSON.parse(readFileSync(join(dataDir, 'library', 'collections.json'), 'utf8'))[0];
    const observed = {
      diskOwner: diskManifest.ownerUserId ?? null,
      catalogOwner: catalog.get(id).ownerUserId ?? null,
      status: result.status,
      error: result.error ?? null,
      storeChanged: before !== digest(),
      docs: legacyStore.getDb().prepare('SELECT COUNT(*) AS n FROM evidence_docs').get().n,
    };
    console.log('UNBOUND_STARTUP_RESULT', JSON.stringify(observed));
    assert.equal(result.status, 'failed', 'unbound project must reject even after the runtime loads it');
    assert.equal(result.error, 'project_collection_owner_unbound');
    assert.equal(before, digest(), 'rejection must preserve the existing store');
    assert.equal(readFileSync(join(dataDir, 'library', 'collections.json'), 'utf8'), savedBefore);
    assert.deepEqual(catalog.get(id), catalogBefore);
    assert.equal(observed.docs, 1, 'the previously indexed document remains intact');
  });

for (const { configuredOwner, issuedOwner } of [
  { configuredOwner: 'default-user', issuedOwner: 'unpaired-user' },
  { configuredOwner: 'owner-a', issuedOwner: 'default-user' },
  { configuredOwner: 'unpaired-user', issuedOwner: 'default-user' },
])
  test(`a remote-issued unpaired session cannot become owner (${configuredOwner})`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pr6742-unpaired-')));
    const dataDir = join(root, 'data');
    const host = join(root, 'host');
    const directProject = join(root, 'direct');
    const setupProject = join(root, 'setup');
    const headerProject = join(root, 'header');
    for (const dir of [host, directProject, setupProject, headerProject]) mkdirSync(dir);
    writeFileSync(join(directProject, 'README.md'), '# Direct\n\nSynthetic direct project.\n');
    writeFileSync(join(setupProject, 'README.md'), '# Setup\n\nSynthetic setup project.\n');
    const catalog = new LibraryCatalog();
    const stores = new Map();
    const primary = new SqliteEvidenceStore(':memory:');
    await primary.initialize();
    const state = new IndexStateManager(primary.getDb());
    const service = new ExpeditionBootstrapService(state, {
      getFingerprint: () => 'unpaired-test',
      rebuildIndex: (path, owner) => ensureProjectCollection(path, catalog, stores, dataDir, owner),
    });
    const pending = [];
    const observed = {
      bootstrap: (...args) => {
        const result = service.bootstrap(...args);
        pending.push(result);
        return result;
      },
    };
    const app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId: configuredOwner });
    await app.register(projectsBootstrapRoutes, {
      stateManager: state,
      bootstrapService: observed,
      socketManager: { emitToUser() {} },
    });
    await app.register(projectSetupRoute, {
      catCafeRoot: host,
      memoryBootstrapService: observed,
      socketManager: { emitToUser() {} },
    });
    t.after(async () => {
      await Promise.allSettled(pending);
      await app.close();
      for (const store of stores.values()) store.close();
      primary.close();
      rmSync(root, { recursive: true, force: true });
    });
    const issued = await app.inject({ method: 'GET', url: '/api/session', remoteAddress: '192.0.2.10' });
    assert.equal(issued.json().userId, issuedOwner);
    const headers = { cookie: issued.headers['set-cookie'].split(';')[0], origin: 'http://127.0.0.1:4310' };
    const direct = await app.inject({
      method: 'POST',
      url: '/api/projects/bootstrap',
      remoteAddress: '127.0.0.1',
      headers,
      payload: { projectPath: directProject },
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      remoteAddress: '127.0.0.1',
      headers,
      payload: { projectPath: setupProject, mode: 'skip' },
    });
    await Promise.allSettled(pending);
    const outcomes = {
      configuredOwner,
      mintedFor: issued.json().userId,
      directStatus: direct.statusCode,
      setupStatus: setup.statusCode,
      owners: catalog.list().map((manifest) => manifest.ownerUserId),
    };
    console.log('UNPAIRED_REPLAY_RESULT', JSON.stringify(outcomes));
    assert.equal(direct.statusCode, 401, 'a remote-issued unpaired cookie cannot authorize an owner');
    assert.equal(setup.statusCode, 401, 'setup must apply the same unpaired-session boundary');
    assert.equal(catalog.list().length, 0);
    assert.equal(stores.size, 0);

    const local = await app.inject({ method: 'GET', url: '/api/session', remoteAddress: '127.0.0.1' });
    assert.equal(local.json().userId, configuredOwner);
    const localHeaders = { cookie: local.headers['set-cookie'].split(';')[0], origin: 'http://127.0.0.1:4310' };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects/bootstrap',
          headers: localHeaders,
          payload: { projectPath: directProject },
        })
      ).statusCode,
      202,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects/setup',
          headers: localHeaders,
          payload: { projectPath: setupProject, mode: 'skip' },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects/bootstrap',
          headers: { 'x-cat-cafe-user': configuredOwner },
          payload: { projectPath: headerProject },
        })
      ).statusCode,
      202,
    );
    await Promise.all(pending);
    assert.equal(catalog.list().length, 3);
    for (const manifest of catalog.list()) assert.equal(manifest.ownerUserId, configuredOwner);
    for (const project of [directProject, setupProject, headerProject])
      assert.equal(state.getState(project).status, 'ready');
  });
