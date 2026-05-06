// F186 Phase A Task 2: LibraryCatalog — collection registry with lifecycle CRUD
// Covers AC-A1 (register), AC-A3 (routing), AC-A11 (sensitivity change direction)

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('LibraryCatalog', () => {
  let LibraryCatalog;
  let catalog;

  beforeEach(async () => {
    ({ LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js'));
    catalog = new LibraryCatalog();
  });

  it('registers a collection and retrieves by id', () => {
    catalog.register({
      id: 'project:cat-cafe',
      kind: 'project',
      name: 'cat-cafe',
      displayName: 'Clowder AI',
      root: '/tmp/docs',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    assert.equal(catalog.list().length, 1);
    assert.equal(catalog.get('project:cat-cafe')?.displayName, 'Clowder AI');
  });

  it('rejects duplicate collection ID', () => {
    const manifest = {
      id: 'project:test',
      kind: 'project',
      name: 'test',
      displayName: 'Test',
      root: '/tmp',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    };
    catalog.register(manifest);
    assert.throws(() => catalog.register(manifest), /already registered/);
  });

  it('validates collection ID format <kind>:<name>', () => {
    assert.throws(
      () =>
        catalog.register({
          id: 'invalid-no-colon',
          kind: 'project',
          name: 'test',
          displayName: 'Test',
          root: '/tmp',
          sensitivity: 'internal',
          scannerLevel: 0,
          indexPolicy: { autoRebuild: true },
          reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
          createdAt: '2026-05-03',
          updatedAt: '2026-05-03',
        }),
      /format/,
    );
  });

  it('unbind archives and removes', () => {
    catalog.register({
      id: 'project:temp',
      kind: 'project',
      name: 'temp',
      displayName: 'Temp',
      root: '/tmp',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    const archived = catalog.unbind('project:temp');
    assert.equal(archived.id, 'project:temp');
    assert.equal(catalog.get('project:temp'), undefined);
    assert.equal(catalog.list().length, 0);
  });

  it('rename preserves alias mapping', () => {
    catalog.register({
      id: 'project:old',
      kind: 'project',
      name: 'old',
      displayName: 'Old',
      root: '/tmp',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    catalog.rename('project:old', 'project:new');
    assert.ok(catalog.get('project:new'));
    assert.equal(catalog.resolveAlias('project:old'), 'project:new');
  });

  it('alias chaining resolves across multiple renames (cloud P2 fix)', () => {
    catalog.register({
      id: 'project:v1',
      kind: 'project',
      name: 'v1',
      displayName: 'V1',
      root: '/tmp',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    catalog.rename('project:v1', 'project:v2');
    catalog.rename('project:v2', 'project:v3');
    assert.ok(catalog.get('project:v1'), 'v1 should resolve through v1→v2→v3');
    assert.ok(catalog.get('project:v2'), 'v2 should resolve through v2→v3');
    assert.ok(catalog.get('project:v3'), 'v3 should resolve directly');
  });

  it('getRoutable returns only non-private for library dimension', () => {
    catalog.register({
      id: 'project:pub',
      kind: 'project',
      name: 'pub',
      displayName: 'Public',
      root: '/tmp',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    catalog.register({
      id: 'world:secret',
      kind: 'world',
      name: 'secret',
      displayName: 'Secret',
      root: '/tmp',
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    const routable = catalog.getRoutable('library');
    assert.equal(routable.length, 1);
    assert.equal(routable[0].id, 'project:pub');
  });

  it('getRoutable returns explicit collections regardless of sensitivity', () => {
    catalog.register({
      id: 'world:secret',
      kind: 'world',
      name: 'secret',
      displayName: 'Secret',
      root: '/tmp',
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    const routable = catalog.getRoutable('collection', ['world:secret']);
    assert.equal(routable.length, 1);
  });

  it('getRoutable returns empty for dimension=collection with no explicit IDs (cloud P1 fix)', () => {
    assert.deepEqual(catalog.getRoutable('collection'), []);
    assert.deepEqual(catalog.getRoutable('collection', []), []);
    assert.deepEqual(catalog.getRoutable('collection', undefined), []);
  });

  it('getRoutable deduplicates explicit collection IDs (cloud R3 P2)', () => {
    catalog.register({
      id: 'project:a',
      kind: 'project',
      name: 'a',
      displayName: 'A',
      root: '/tmp',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    const routable = catalog.getRoutable('collection', ['project:a', 'project:a', 'project:a']);
    assert.equal(routable.length, 1, 'duplicate IDs should be deduplicated');
  });

  it('getRoutable deduplicates after alias resolution (cloud R5 P2)', () => {
    catalog.register({
      id: 'project:v1',
      kind: 'project',
      name: 'v1',
      displayName: 'V1',
      root: '/tmp',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    catalog.rename('project:v1', 'project:v2');
    const routable = catalog.getRoutable('collection', ['project:v1', 'project:v2']);
    assert.equal(routable.length, 1, 'alias-resolved duplicates should be deduplicated');
  });

  it('library catalog endpoint includes ALL collections for owner view (guardian P1)', async () => {
    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');

    catalog.register({
      id: 'project:pub',
      kind: 'project',
      name: 'pub',
      displayName: 'Public Project',
      root: '/tmp',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    catalog.register({
      id: 'world:secret',
      kind: 'world',
      name: 'secret',
      displayName: 'Secret World',
      root: '/tmp',
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });

    const app = Fastify();
    await app.register(libraryRoutes, { catalog, stores: new Map() });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/library/catalog' });
    const body = JSON.parse(res.body);
    const ids = body.collections.map((c) => c.manifest.id);
    assert.ok(ids.includes('project:pub'), 'should include internal collection');
    assert.ok(ids.includes('world:secret'), 'owner must see private collections in catalog');

    await app.close();
  });

  it('library detail endpoint allows owner access to private collection (guardian P1)', async () => {
    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');

    catalog.register({
      id: 'world:private-detail',
      kind: 'world',
      name: 'private-detail',
      displayName: 'Private Detail',
      root: '/tmp',
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });

    const app = Fastify();
    await app.register(libraryRoutes, { catalog, stores: new Map() });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/library/world:private-detail' });
    assert.equal(res.statusCode, 200, 'owner must be able to view private collection details');
    const body = JSON.parse(res.body);
    assert.equal(body.manifest.id, 'world:private-detail');

    await app.close();
  });

  it('library documents endpoint allows owner access to private collection documents (guardian P1)', async () => {
    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');

    catalog.register({
      id: 'world:private-docs',
      kind: 'world',
      name: 'private-docs',
      displayName: 'Private Docs',
      root: '/tmp',
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });

    const app = Fastify();
    await app.register(libraryRoutes, { catalog, stores: new Map() });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/library/world:private-docs/documents' });
    assert.equal(res.statusCode, 200, 'owner must be able to view private collection documents');

    await app.close();
  });

  it('catalog endpoint rejects non-localhost request (codex R1 P1)', async () => {
    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');

    const app = Fastify();
    await app.register(libraryRoutes, { catalog, stores: new Map() });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/library/catalog',
      remoteAddress: '203.0.113.9',
    });
    assert.equal(res.statusCode, 403);

    await app.close();
  });

  it('detail endpoint rejects non-localhost request (codex R1 P1)', async () => {
    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');

    catalog.register({
      id: 'world:remote-detail',
      kind: 'world',
      name: 'remote-detail',
      displayName: 'Remote Detail',
      root: '/tmp',
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-06',
      updatedAt: '2026-05-06',
    });

    const app = Fastify();
    await app.register(libraryRoutes, { catalog, stores: new Map() });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/library/world:remote-detail',
      remoteAddress: '203.0.113.9',
    });
    assert.equal(res.statusCode, 403);

    await app.close();
  });

  it('documents endpoint rejects non-localhost request (codex R1 P1)', async () => {
    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');

    catalog.register({
      id: 'world:remote-docs',
      kind: 'world',
      name: 'remote-docs',
      displayName: 'Remote Docs',
      root: '/tmp',
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-06',
      updatedAt: '2026-05-06',
    });

    const app = Fastify();
    await app.register(libraryRoutes, { catalog, stores: new Map() });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/library/world:remote-docs/documents',
      remoteAddress: '203.0.113.9',
    });
    assert.equal(res.statusCode, 403);

    await app.close();
  });

  it('updateSensitivity tracks direction', () => {
    catalog.register({
      id: 'project:x',
      kind: 'project',
      name: 'x',
      displayName: 'X',
      root: '/tmp',
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    const change = catalog.updateSensitivity('project:x', 'internal');
    assert.equal(change.direction, 'widening');
    assert.equal(catalog.get('project:x')?.sensitivity, 'internal');
  });
});
