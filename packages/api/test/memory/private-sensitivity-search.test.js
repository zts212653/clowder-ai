import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('AC-C2: private Collection excluded from library search', () => {
  let LibraryCatalog;

  before(async () => {
    ({ LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js'));
  });

  function makeManifest(id, sensitivity) {
    const [kind, name] = id.split(':');
    return {
      id,
      kind,
      name,
      displayName: name,
      root: '/tmp/fake',
      sensitivity,
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-05-05',
      updatedAt: '2026-05-05',
    };
  }

  it('getRoutable("library") excludes private collections', () => {
    const catalog = new LibraryCatalog();
    catalog.register(makeManifest('project:docs', 'public'));
    catalog.register(makeManifest('domain:notes', 'internal'));
    catalog.register(makeManifest('world:diary', 'private'));
    catalog.register(makeManifest('research:vault', 'restricted'));

    const routable = catalog.getRoutable('library');
    const ids = routable.map((m) => m.id);

    assert.ok(ids.includes('project:docs'), 'public included');
    assert.ok(ids.includes('domain:notes'), 'internal included');
    assert.ok(!ids.includes('world:diary'), 'private excluded');
    assert.ok(!ids.includes('research:vault'), 'restricted excluded');
  });

  it('getRoutable("collection") allows explicit include of private', () => {
    const catalog = new LibraryCatalog();
    catalog.register(makeManifest('world:diary', 'private'));

    const routable = catalog.getRoutable('collection', ['world:diary']);
    assert.equal(routable.length, 1);
    assert.equal(routable[0].id, 'world:diary');
  });

  it('getRoutable("library") returns empty when all collections are private', () => {
    const catalog = new LibraryCatalog();
    catalog.register(makeManifest('world:secret', 'private'));
    catalog.register(makeManifest('domain:locked', 'restricted'));

    const routable = catalog.getRoutable('library');
    assert.equal(routable.length, 0);
  });
});
