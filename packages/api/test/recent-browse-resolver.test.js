/**
 * RecentBrowseResolver Tests — F188 Phase F (AC-F2)
 *
 * Verifies cross-store merge, since/kind filtering, callerCollections
 * privacy contract, and parseSinceToIso parsing.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/** Fake sqlite Database — only implements prepare().all() for our subset. */
function fakeDb(rows) {
  return {
    prepare(_sql) {
      return {
        all(..._params) {
          // For test simplicity: tests pre-filter rows themselves and bind to fakeDb.
          return rows;
        },
      };
    },
  };
}

function fakeStore(rows) {
  return {
    // IEvidenceStore methods stubbed
    async search() {
      return { results: [] };
    },
    async upsert() {},
    async delete() {},
    getDb() {
      return fakeDb(rows);
    },
  };
}

function fakeCatalog(manifests) {
  return {
    list() {
      return manifests;
    },
    get(id) {
      return manifests.find((m) => m.id === id);
    },
  };
}

describe('RecentBrowseResolver (AC-F2)', () => {
  test('parseSinceToIso handles 7d / 24h / ISO + canonical UTC normalization (砚砚 cloud-10 P2)', async () => {
    const { parseSinceToIso } = await import('../dist/domains/memory/RecentBrowseResolver.js');
    const fixed = new Date('2026-05-10T12:00:00.000Z');

    assert.equal(parseSinceToIso('7d', fixed), '2026-05-03T12:00:00.000Z');
    assert.equal(parseSinceToIso('24h', fixed), '2026-05-09T12:00:00.000Z');
    // ISO inputs now normalized to canonical `.sssZ` form (matches sqlite
    // `updated_at` storage so lex-comparison is correct).
    assert.equal(parseSinceToIso('2026-05-01T00:00:00Z', fixed), '2026-05-01T00:00:00.000Z');
    // Timezone-offset input → converted to UTC (was previously kept as-is,
    // which broke SQL TEXT comparison against `...Z` rows).
    assert.equal(parseSinceToIso('2026-05-01T08:00:00+08:00', fixed), '2026-05-01T00:00:00.000Z');
    // Date-only → midnight UTC.
    assert.equal(parseSinceToIso('2026-05-01', fixed), '2026-05-01T00:00:00.000Z');
  });

  test('list merges across stores, sorts by updatedAt desc, applies limit', async () => {
    const { RecentBrowseResolver } = await import('../dist/domains/memory/RecentBrowseResolver.js');

    const storeA = fakeStore([
      { anchor: 'F100', title: 'A1', kind: 'feature', updatedAt: '2026-05-10T10:00Z' },
      { anchor: 'F101', title: 'A2', kind: 'decision', updatedAt: '2026-05-09T10:00Z' },
    ]);
    const storeB = fakeStore([
      { anchor: 'F200', title: 'B1', kind: 'feature', updatedAt: '2026-05-10T11:00Z' },
      { anchor: 'F201', title: 'B2', kind: 'lesson', updatedAt: '2026-05-08T11:00Z' },
    ]);

    const resolver = new RecentBrowseResolver(
      fakeCatalog([
        { id: 'project:cafe', sensitivity: 'internal', kind: 'project' },
        { id: 'global:methods', sensitivity: 'internal', kind: 'global' },
      ]),
      new Map([
        ['project:cafe', storeA],
        ['global:methods', storeB],
      ]),
    );

    const { items } = await resolver.list({ since: '7d', limit: 3 });
    assert.equal(items.length, 3);
    // Cross-store merged and sorted desc by updatedAt
    assert.equal(items[0].anchor, 'F200'); // latest 11:00Z
    assert.equal(items[1].anchor, 'F100'); // 10:00Z
    assert.equal(items[2].anchor, 'F101'); // 09:00Z (next day cutoff)
    // source field populated
    assert.equal(items[0].source, 'global:methods');
    assert.equal(items[1].source, 'project:cafe');
  });

  test('private collection requires explicit callerCollections include (KD-8 server-side)', async () => {
    const { RecentBrowseResolver } = await import('../dist/domains/memory/RecentBrowseResolver.js');

    const privateStore = fakeStore([
      { anchor: 'world:lexander:dragon', title: 'Dragon Lore', kind: 'lore', updatedAt: '2026-05-10T11:00Z' },
    ]);
    const publicStore = fakeStore([
      { anchor: 'F100', title: 'Public', kind: 'feature', updatedAt: '2026-05-10T10:00Z' },
    ]);

    const resolver = new RecentBrowseResolver(
      fakeCatalog([
        { id: 'world:lexander', sensitivity: 'private', kind: 'world' },
        { id: 'project:cafe', sensitivity: 'internal', kind: 'project' },
      ]),
      new Map([
        ['world:lexander', privateStore],
        ['project:cafe', publicStore],
      ]),
    );

    // Without callerCollections: private skipped
    const { items: withoutCaller } = await resolver.list({ since: '7d', limit: 10 });
    assert.equal(withoutCaller.length, 1);
    assert.equal(withoutCaller[0].anchor, 'F100');

    // With callerCollections: private visible
    const { items: withCaller } = await resolver.list({
      since: '7d',
      limit: 10,
      callerCollections: ['world:lexander', 'project:cafe'],
    });
    assert.equal(withCaller.length, 2);
    assert.ok(withCaller.some((i) => i.anchor === 'world:lexander:dragon'));
  });

  test('kinds filter narrows results', async () => {
    const { RecentBrowseResolver } = await import('../dist/domains/memory/RecentBrowseResolver.js');

    // Note: fakeDb returns rows unfiltered. In real sqlite the kind filter applies in SQL;
    // here we verify the resolver wires params correctly via spy.
    let capturedSql = '';
    let capturedParams = [];
    const spyStore = {
      async search() {
        return { results: [] };
      },
      async upsert() {},
      async delete() {},
      getDb() {
        return {
          prepare(sql) {
            capturedSql = sql;
            return {
              all(...params) {
                capturedParams = params;
                return [];
              },
            };
          },
        };
      },
    };

    const resolver = new RecentBrowseResolver(
      fakeCatalog([{ id: 'project:cafe', sensitivity: 'internal', kind: 'project' }]),
      new Map([['project:cafe', spyStore]]),
    );

    await resolver.list({ since: '7d', limit: 5, kinds: ['feature', 'decision'] });

    assert.ok(capturedSql.includes('kind IN (?,?)'), `sql must include kind filter, got: ${capturedSql}`);
    // params order: [cutoff, ...kinds, limit]
    assert.equal(capturedParams.length, 4);
    assert.equal(capturedParams[1], 'feature');
    assert.equal(capturedParams[2], 'decision');
    assert.equal(capturedParams[3], 5);
  });

  test('scope ∩ kinds intersect (砚砚 cloud-3 P2): kinds narrows scope, never replaces', async () => {
    const { RecentBrowseResolver } = await import('../dist/domains/memory/RecentBrowseResolver.js');

    let capturedSql = '';
    let capturedParams = [];
    let prepareCalls = 0;
    const spyStore = {
      async search() {
        return { results: [] };
      },
      async upsert() {},
      async delete() {},
      getDb() {
        return {
          prepare(sql) {
            prepareCalls++;
            capturedSql = sql;
            return {
              all(...params) {
                capturedParams = params;
                return [];
              },
            };
          },
        };
      },
    };

    const resolver = new RecentBrowseResolver(
      fakeCatalog([{ id: 'project:cafe', sensitivity: 'internal', kind: 'project' }]),
      new Map([['project:cafe', spyStore]]),
    );

    // scope=docs admits ['feature','decision','lesson','plan',...] — `kinds=['feature']`
    // narrows to just 'feature' (intersection). Pre-fix this would have replaced scope.
    await resolver.list({ since: '7d', limit: 5, scope: 'docs', kinds: ['feature'] });
    assert.ok(capturedSql.includes('kind IN (?)'), `intersection produces single-kind filter: ${capturedSql}`);
    assert.equal(capturedParams[1], 'feature');

    // scope=threads (kinds: ['discussion','thread',...]) ∩ kinds=['feature'] = [] →
    // store skipped entirely (no rows can match the contract — empty intersection).
    prepareCalls = 0;
    await resolver.list({ since: '7d', limit: 5, scope: 'threads', kinds: ['feature'] });
    assert.equal(prepareCalls, 0, 'empty intersection must skip the store, not fall back to no-filter');
  });

  test('skips store without getDb() capability', async () => {
    const { RecentBrowseResolver } = await import('../dist/domains/memory/RecentBrowseResolver.js');

    const storeWithDb = fakeStore([{ anchor: 'F100', title: 'A', kind: 'feature', updatedAt: '2026-05-10T10:00Z' }]);
    const storeWithoutDb = {
      async search() {
        return { results: [] };
      },
      async upsert() {},
      async delete() {},
      // no getDb method
    };

    const resolver = new RecentBrowseResolver(
      fakeCatalog([
        { id: 'project:cafe', sensitivity: 'internal', kind: 'project' },
        { id: 'remote:noindex', sensitivity: 'internal', kind: 'remote' },
      ]),
      new Map([
        ['project:cafe', storeWithDb],
        ['remote:noindex', storeWithoutDb],
      ]),
    );

    const { items } = await resolver.list({ since: '7d', limit: 10 });
    assert.equal(items.length, 1, 'only the store with getDb contributes');
    assert.equal(items[0].source, 'project:cafe');
  });

  test('archived collection excluded from recent results (P1-3)', async () => {
    const { RecentBrowseResolver } = await import('../dist/domains/memory/RecentBrowseResolver.js');

    const activeStore = fakeStore([
      { anchor: 'F100', title: 'Active Doc', kind: 'feature', updatedAt: '2026-05-10T10:00Z' },
    ]);
    const archivedStore = fakeStore([
      { anchor: 'F200', title: 'Archived Doc', kind: 'feature', updatedAt: '2026-05-10T11:00Z' },
    ]);

    const resolver = new RecentBrowseResolver(
      fakeCatalog([
        { id: 'project:cafe', sensitivity: 'internal', kind: 'project' },
        { id: 'domain:old', sensitivity: 'internal', kind: 'domain', status: 'archived' },
      ]),
      new Map([
        ['project:cafe', activeStore],
        ['domain:old', archivedStore],
      ]),
    );

    const { items } = await resolver.list({ since: '7d', limit: 10 });
    assert.equal(items.length, 1, 'archived collection should be excluded');
    assert.equal(items[0].anchor, 'F100');
  });
});
