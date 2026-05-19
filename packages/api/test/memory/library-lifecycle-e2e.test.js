import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

describe('AC-I9: collection lifecycle E2E — register → catalog → archive → unarchive', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('full lifecycle: register domain:finance → appears in catalog → archive → excluded from routable → unarchive → routable again', async () => {
    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    const vaultBase = mkdtempSync(join(tmpdir(), 'e2e-vault-'));
    app = Fastify();
    await app.register(libraryRoutes, {
      catalog,
      stores: new Map(),
      dataDir: vaultBase,
      managedVaultBase: vaultBase,
    });
    await app.ready();

    // Step 1: Register domain:finance with managed vault (no root → auto-creates)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:finance',
        kind: 'domain',
        name: 'finance',
        displayName: 'Personal Finance',
        sensitivity: 'private',
      },
    });
    assert.equal(createRes.statusCode, 200);
    const created = JSON.parse(createRes.body);
    assert.equal(created.manifest.id, 'domain:finance');
    assert.equal(created.manifest.status, 'registered');
    assert.equal(created.manifest.sensitivity, 'private');
    assert.ok(
      created.manifest.root.includes('domain-finance'),
      `root should contain safe id: ${created.manifest.root}`,
    );
    assert.ok(existsSync(created.manifest.root), 'managed vault directory should exist');

    // Step 2: Catalog lists the new collection
    const catalogRes = await app.inject({ method: 'GET', url: '/api/library/catalog' });
    assert.equal(catalogRes.statusCode, 200);
    const catalogBody = JSON.parse(catalogRes.body);
    const financeEntry = catalogBody.collections.find((c) => c.manifest.id === 'domain:finance');
    assert.ok(financeEntry, 'domain:finance should appear in catalog');
    assert.equal(financeEntry.manifest.status, 'registered');
    assert.equal(financeEntry.manifest.sensitivity, 'private');

    // Step 3: getRoutable includes the non-archived collection
    const routable = catalog.getRoutable('collection', ['domain:finance']);
    assert.equal(routable.length, 1, 'registered collection should be routable');
    assert.equal(routable[0].id, 'domain:finance');

    // Step 4: Archive domain:finance
    const archiveRes = await app.inject({
      method: 'POST',
      url: '/api/library/domain:finance/archive',
    });
    assert.equal(archiveRes.statusCode, 200);
    const archived = JSON.parse(archiveRes.body);
    assert.equal(archived.manifest.status, 'archived');

    // Step 5: Archived collection excluded from routable
    const routableAfterArchive = catalog.getRoutable('collection', ['domain:finance']);
    assert.equal(routableAfterArchive.length, 0, 'archived collection should not be routable');

    // Step 6: Catalog still lists it (with archived status)
    const catalogRes2 = await app.inject({ method: 'GET', url: '/api/library/catalog' });
    const catalogBody2 = JSON.parse(catalogRes2.body);
    const archivedEntry = catalogBody2.collections.find((c) => c.manifest.id === 'domain:finance');
    assert.ok(archivedEntry, 'archived collection should still appear in catalog');
    assert.equal(archivedEntry.manifest.status, 'archived');

    // Step 7: Unarchive → back to registered
    const unarchiveRes = await app.inject({
      method: 'POST',
      url: '/api/library/domain:finance/unarchive',
    });
    assert.equal(unarchiveRes.statusCode, 200);
    const unarchived = JSON.parse(unarchiveRes.body);
    assert.equal(unarchived.manifest.status, 'registered');

    // Step 8: Routable again after unarchive
    const routableAfterUnarchive = catalog.getRoutable('collection', ['domain:finance']);
    assert.equal(routableAfterUnarchive.length, 1, 'unarchived collection should be routable again');
  });

  it('managed vault creates directory automatically when root omitted', async () => {
    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const vaultBase = mkdtempSync(join(tmpdir(), 'e2e-managed-'));
    app = Fastify();
    await app.register(libraryRoutes, {
      catalog: new LibraryCatalog(),
      stores: new Map(),
      dataDir: vaultBase,
      managedVaultBase: vaultBase,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'research:ml-papers',
        kind: 'research',
        name: 'ml-papers',
        displayName: 'ML Papers Collection',
        sensitivity: 'internal',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(existsSync(body.manifest.root), 'managed vault dir should be auto-created');
    assert.ok(body.manifest.root.includes('research-ml-papers'));
  });

  it('sensitivity change via PUT route', async () => {
    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    const dataDir = mkdtempSync(join(tmpdir(), 'e2e-sens-'));
    const rootDir = mkdtempSync(join(tmpdir(), 'e2e-secrets-'));
    app = Fastify();
    await app.register(libraryRoutes, { catalog, stores: new Map(), dataDir });
    await app.ready();

    // Register with private sensitivity
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:secrets',
        kind: 'domain',
        name: 'secrets',
        displayName: 'Secret Docs',
        root: rootDir,
        sensitivity: 'private',
      },
    });
    assert.equal(regRes.statusCode, 200, `register failed: ${regRes.body}`);

    // Widen to internal (requires confirm)
    const widenNoConfirm = await app.inject({
      method: 'PUT',
      url: '/api/library/domain:secrets/sensitivity',
      payload: { sensitivity: 'internal' },
    });
    assert.equal(widenNoConfirm.statusCode, 409, 'widening without confirm should 409');

    const widenRes = await app.inject({
      method: 'PUT',
      url: '/api/library/domain:secrets/sensitivity',
      payload: { sensitivity: 'internal', confirm: true },
    });
    assert.equal(widenRes.statusCode, 200);
    const widen = JSON.parse(widenRes.body);
    assert.equal(widen.direction, 'widening');
    assert.equal(widen.from, 'private');
    assert.equal(widen.to, 'internal');

    // Narrow back to private
    const narrowRes = await app.inject({
      method: 'PUT',
      url: '/api/library/domain:secrets/sensitivity',
      payload: { sensitivity: 'private' },
    });
    assert.equal(narrowRes.statusCode, 200);
    const narrow = JSON.parse(narrowRes.body);
    assert.equal(narrow.direction, 'narrowing');
  });
});
