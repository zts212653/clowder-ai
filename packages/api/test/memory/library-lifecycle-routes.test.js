import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

describe('library lifecycle routes', () => {
  let Fastify, libraryRoutes, LibraryCatalog;
  let catalog, app, dataDir;

  const makeManifest = (id, overrides = {}) => ({
    id,
    kind: id.split(':')[0],
    name: id.split(':')[1],
    displayName: id.split(':')[1].charAt(0).toUpperCase() + id.split(':')[1].slice(1),
    root: '/tmp',
    sensitivity: 'internal',
    scannerLevel: 0,
    status: 'active',
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-05-19',
    updatedAt: '2026-05-19',
    ...overrides,
  });

  beforeEach(async () => {
    Fastify = (await import('fastify')).default;
    ({ libraryRoutes } = await import('../../dist/routes/library.js'));
    ({ LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js'));
    catalog = new LibraryCatalog();
    dataDir = mkdtempSync(join(tmpdir(), 'lib-lifecycle-'));
    app = Fastify();
    await app.register(libraryRoutes, { catalog, stores: new Map(), dataDir });
    await app.ready();
  });

  it('POST /api/library/:id/archive returns archived manifest', async () => {
    catalog.register(makeManifest('domain:archiveme'));
    const res = await app.inject({ method: 'POST', url: '/api/library/domain:archiveme/archive' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.manifest.status, 'archived');
    assert.equal(body.manifest.id, 'domain:archiveme');
  });

  it('POST /api/library/:id/archive returns 404 for unknown collection', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/library/domain:nope/archive' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /api/library/:id/archive returns 400 if already archived', async () => {
    catalog.register(makeManifest('domain:already', { status: 'active' }));
    catalog.archive('domain:already');
    const res = await app.inject({ method: 'POST', url: '/api/library/domain:already/archive' });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Invalid transition'));
  });

  it('POST /api/library/:id/unarchive returns unarchived manifest', async () => {
    catalog.register(makeManifest('domain:bringback', { status: 'active' }));
    catalog.archive('domain:bringback');
    const res = await app.inject({ method: 'POST', url: '/api/library/domain:bringback/unarchive' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.manifest.status, 'registered');
  });

  it('POST /api/library/:id/unarchive returns 404 for unknown', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/library/domain:nope/unarchive' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /api/library/:id/unarchive returns 400 if not archived', async () => {
    catalog.register(makeManifest('domain:notarchived'));
    const res = await app.inject({ method: 'POST', url: '/api/library/domain:notarchived/unarchive' });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Invalid transition'));
  });

  it('PUT /api/library/:id/sensitivity returns change info with confirm', async () => {
    catalog.register(makeManifest('domain:sens', { sensitivity: 'private' }));
    const res = await app.inject({
      method: 'PUT',
      url: '/api/library/domain:sens/sensitivity',
      payload: { sensitivity: 'internal', confirm: true },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.direction, 'widening');
    assert.equal(body.from, 'private');
    assert.equal(body.to, 'internal');
  });

  it('PUT /api/library/:id/sensitivity returns 404 for unknown', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/library/domain:nope/sensitivity',
      payload: { sensitivity: 'public' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('PUT /api/library/:id/sensitivity returns 400 for invalid value', async () => {
    catalog.register(makeManifest('domain:badsens'));
    const res = await app.inject({
      method: 'PUT',
      url: '/api/library/domain:badsens/sensitivity',
      payload: { sensitivity: 'banana' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('PUT /api/library/:id/sensitivity rejects prototype keys like toString', async () => {
    catalog.register(makeManifest('domain:proto'));
    const res = await app.inject({
      method: 'PUT',
      url: '/api/library/domain:proto/sensitivity',
      payload: { sensitivity: 'toString' },
    });
    assert.equal(res.statusCode, 400, 'prototype key must be rejected');
  });

  it('archive route rejects non-localhost', async () => {
    catalog.register(makeManifest('domain:remote'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/domain:remote/archive',
      remoteAddress: '203.0.113.9',
    });
    assert.equal(res.statusCode, 403);
  });

  it('POST /api/library/:id/archive rejects built-in collections', async () => {
    catalog.register(makeManifest('project:cat-cafe'));
    const res = await app.inject({ method: 'POST', url: '/api/library/project:cat-cafe/archive' });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('built-in'), 'error must mention built-in');
  });

  it('POST /api/library/:id/archive rejects global built-in collections', async () => {
    catalog.register(makeManifest('global:methods'));
    const res = await app.inject({ method: 'POST', url: '/api/library/global:methods/archive' });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('built-in'), 'error must mention built-in');
  });

  it('POST /api/library/:id/archive allows user-created project/global collections', async () => {
    catalog.register(makeManifest('project:custom'));
    const res = await app.inject({ method: 'POST', url: '/api/library/project:custom/archive' });
    assert.equal(res.statusCode, 200, 'user-created project collection should be archivable');
    assert.equal(JSON.parse(res.body).manifest.status, 'archived');
  });

  it('POST /api/library/:id/rebuild transitions status registered → active', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'rebuild-test-'));
    writeFileSync(join(rootDir, 'test.md'), '# Test\nSome content for indexing.\n');
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:rebuildme',
        kind: 'domain',
        name: 'rebuildme',
        displayName: 'Rebuild Test',
        root: rootDir,
        sensitivity: 'internal',
      },
    });
    assert.equal(regRes.statusCode, 200);
    assert.equal(catalog.get('domain:rebuildme').status, 'registered');

    const rebuildRes = await app.inject({
      method: 'POST',
      url: '/api/library/domain:rebuildme/rebuild',
    });
    assert.equal(rebuildRes.statusCode, 200);
    assert.equal(catalog.get('domain:rebuildme').status, 'active', 'rebuild should transition status to active');
  });

  it('POST /api/library/:id/rebuild recovers blocked collection to active', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'rebuild-blocked-'));
    writeFileSync(join(rootDir, 'test.md'), '# Clean content\n');
    await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:blocked',
        kind: 'domain',
        name: 'blocked',
        displayName: 'Blocked Test',
        root: rootDir,
        sensitivity: 'internal',
      },
    });
    catalog.setStatus('domain:blocked', 'indexing');
    catalog.setStatus('domain:blocked', 'blocked');
    assert.equal(catalog.get('domain:blocked').status, 'blocked');

    const rebuildRes = await app.inject({
      method: 'POST',
      url: '/api/library/domain:blocked/rebuild',
    });
    assert.equal(rebuildRes.statusCode, 200);
    assert.equal(catalog.get('domain:blocked').status, 'active', 'rebuild must recover blocked → active');
  });

  it('POST /api/library/:id/rebuild persists status to collections.json', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'rebuild-persist-'));
    writeFileSync(join(rootDir, 'test.md'), '# Test\nSome content for indexing.\n');
    await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:persistme',
        kind: 'domain',
        name: 'persistme',
        displayName: 'Persist Test',
        root: rootDir,
        sensitivity: 'internal',
      },
    });

    const rebuildRes = await app.inject({
      method: 'POST',
      url: '/api/library/domain:persistme/rebuild',
    });
    assert.equal(rebuildRes.statusCode, 200);

    const collectionsJson = JSON.parse(readFileSync(join(dataDir, 'library', 'collections.json'), 'utf-8'));
    const entry = collectionsJson.find((c) => c.id === 'domain:persistme');
    assert.equal(entry.status, 'active', 'collections.json must reflect post-rebuild status');
  });

  it('POST /api/library/:id/archive removes store from stores map', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'archive-store-'));
    writeFileSync(join(rootDir, 'test.md'), '# Archive test\n');
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:removeme',
        kind: 'domain',
        name: 'removeme',
        displayName: 'Remove Store Test',
        root: rootDir,
        sensitivity: 'internal',
      },
    });
    assert.equal(regRes.statusCode, 200);

    const rebuildRes = await app.inject({
      method: 'POST',
      url: '/api/library/domain:removeme/rebuild',
    });
    assert.equal(rebuildRes.statusCode, 200);

    const archiveRes = await app.inject({
      method: 'POST',
      url: '/api/library/domain:removeme/archive',
    });
    assert.equal(archiveRes.statusCode, 200);

    const docRes = await app.inject({
      method: 'GET',
      url: '/api/library/domain:removeme/documents',
    });
    assert.equal(docRes.statusCode, 200);
    const docBody = JSON.parse(docRes.body);
    assert.deepEqual(docBody.groups, [], 'archived collection should return empty docs (store removed)');
  });

  it('POST /api/library/:id/archive moves index to archives path', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'archive-move-'));
    writeFileSync(join(rootDir, 'test.md'), '# Archive move test\n');
    await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:moveme',
        kind: 'domain',
        name: 'moveme',
        displayName: 'Move Test',
        root: rootDir,
        sensitivity: 'internal',
      },
    });
    await app.inject({ method: 'POST', url: '/api/library/domain:moveme/rebuild' });

    const activePath = join(dataDir, 'library', 'domain-moveme', 'evidence.sqlite');
    assert.ok(existsSync(activePath), 'active index must exist before archive');

    await app.inject({ method: 'POST', url: '/api/library/domain:moveme/archive' });

    const archivePath = join(dataDir, 'library', 'archives', 'domain-moveme', 'evidence.sqlite');
    assert.ok(existsSync(archivePath), 'archived index must be moved to archives path');
    assert.ok(!existsSync(activePath), 'active index path must be empty after archive');
  });

  it('archive → unarchive → rebuild restores full lifecycle', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
    writeFileSync(join(rootDir, 'test.md'), '# Lifecycle test\n');
    await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:lifecycle',
        kind: 'domain',
        name: 'lifecycle',
        displayName: 'Lifecycle Test',
        root: rootDir,
        sensitivity: 'internal',
      },
    });
    await app.inject({ method: 'POST', url: '/api/library/domain:lifecycle/rebuild' });
    assert.equal(catalog.get('domain:lifecycle').status, 'active');

    const archiveRes = await app.inject({ method: 'POST', url: '/api/library/domain:lifecycle/archive' });
    assert.equal(archiveRes.statusCode, 200);
    assert.equal(catalog.get('domain:lifecycle').status, 'archived');

    const unarchiveRes = await app.inject({ method: 'POST', url: '/api/library/domain:lifecycle/unarchive' });
    assert.equal(unarchiveRes.statusCode, 200);
    assert.equal(catalog.get('domain:lifecycle').status, 'registered');

    const rebuildRes = await app.inject({ method: 'POST', url: '/api/library/domain:lifecycle/rebuild' });
    assert.equal(rebuildRes.statusCode, 200, 'rebuild after unarchive must succeed (store must be restored)');
    assert.equal(catalog.get('domain:lifecycle').status, 'active');
  });

  it('PUT sensitivity widening requires confirm flag', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'sens-widen-'));
    writeFileSync(join(rootDir, 'test.md'), '# Test\n');
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:widen',
        kind: 'domain',
        name: 'widen',
        displayName: 'Widen Test',
        root: rootDir,
        sensitivity: 'private',
      },
    });
    assert.equal(regRes.statusCode, 200);

    const widenRes = await app.inject({
      method: 'PUT',
      url: '/api/library/domain:widen/sensitivity',
      payload: { sensitivity: 'internal' },
    });
    assert.equal(widenRes.statusCode, 409, 'widening without confirm should return 409');
    const body = JSON.parse(widenRes.body);
    assert.equal(body.direction, 'widening');
    assert.ok(body.requiresConfirmation);

    const confirmRes = await app.inject({
      method: 'PUT',
      url: '/api/library/domain:widen/sensitivity',
      payload: { sensitivity: 'internal', confirm: true },
    });
    assert.equal(confirmRes.statusCode, 200, 'widening with confirm should succeed');
    assert.equal(JSON.parse(confirmRes.body).direction, 'widening');
  });

  it('PUT sensitivity narrowing triggers reindex', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'sens-narrow-'));
    writeFileSync(join(rootDir, 'test.md'), '# Test\n');
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:narrow',
        kind: 'domain',
        name: 'narrow',
        displayName: 'Narrow Test',
        root: rootDir,
        sensitivity: 'internal',
      },
    });
    assert.equal(regRes.statusCode, 200);

    const rebuildRes = await app.inject({
      method: 'POST',
      url: '/api/library/domain:narrow/rebuild',
    });
    assert.equal(rebuildRes.statusCode, 200);
    assert.equal(catalog.get('domain:narrow').status, 'active');

    const narrowRes = await app.inject({
      method: 'PUT',
      url: '/api/library/domain:narrow/sensitivity',
      payload: { sensitivity: 'private' },
    });
    assert.equal(narrowRes.statusCode, 200);
    const body = JSON.parse(narrowRes.body);
    assert.equal(body.direction, 'narrowing');
    assert.ok(body.reindexTriggered, 'narrowing should trigger reindex');
  });

  it('POST /api/library/register with managed vault creates directory', async () => {
    const vaultBase = mkdtempSync(join(tmpdir(), 'vault-'));
    const appWithVault = Fastify();
    await appWithVault.register(libraryRoutes, {
      catalog: new LibraryCatalog(),
      stores: new Map(),
      dataDir: vaultBase,
      managedVaultBase: vaultBase,
    });
    await appWithVault.ready();

    const res = await appWithVault.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:vault-test',
        kind: 'domain',
        name: 'vault-test',
        displayName: 'Vault Test',
        sensitivity: 'private',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.manifest.id, 'domain:vault-test');
    assert.equal(body.manifest.status, 'registered');
    assert.ok(body.manifest.root.includes('vault-test'));
    await appWithVault.close();
  });

  it('POST /api/library/register rejects path-traversal id in managed vault mode', async () => {
    const vaultBase = mkdtempSync(join(tmpdir(), 'vault-traversal-'));
    const appWithVault = Fastify();
    await appWithVault.register(libraryRoutes, {
      catalog: new LibraryCatalog(),
      stores: new Map(),
      dataDir: vaultBase,
      managedVaultBase: vaultBase,
    });
    await appWithVault.ready();

    const res = await appWithVault.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: '../../../tmp/evil',
        kind: 'domain',
        name: '../../../tmp/evil',
        displayName: 'Evil',
        sensitivity: 'private',
      },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('path traversal') || body.error.includes('invalid'), 'error must reject traversal');
    await appWithVault.close();
  });
});
