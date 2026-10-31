import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// Synthetic aliases stay distinct when exported to the public distribution.
describe('F209 entity registry storage', () => {
  let store;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  it('stores entity records with aliases, provenance, and updatedAt', async () => {
    await store.upsertEntities([
      {
        entityId: 'person:fixtureowner',
        type: 'person',
        canonicalName: 'FixtureOwner',
        aliases: ['fixtureowner', '读者甲', 'OWNERROLE'],
        provenance: [{ source: 'F209 Phase B test', anchor: 'F209' }],
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    const entity = await store.getEntity('person:fixtureowner');
    assert.equal(entity.entityId, 'person:fixtureowner');
    assert.equal(entity.type, 'person');
    assert.equal(entity.canonicalName, 'FixtureOwner');
    assert.deepEqual(entity.aliases.sort(), ['OWNERROLE', 'fixtureowner', '读者甲'].sort());
    assert.equal(entity.updatedAt, '2026-05-22T00:00:00Z');
    assert.deepEqual(entity.provenance, [{ source: 'F209 Phase B test', anchor: 'F209' }]);
    assert.equal(entity.privacyScope, undefined);
    assert.equal(entity.collectionId, undefined);
    assert.equal(entity.sensitivity, undefined);
  });

  it('preserves the original createdAt when updating an existing entity', async () => {
    await store.upsertEntities([
      {
        entityId: 'person:fixtureowner',
        type: 'person',
        canonicalName: 'FixtureOwner',
        aliases: ['OWNERROLE'],
        provenance: [{ source: 'initial seed' }],
        createdAt: '2026-05-20T00:00:00Z',
        updatedAt: '2026-05-20T00:00:00Z',
      },
    ]);

    await store.upsertEntities([
      {
        entityId: 'person:fixtureowner',
        type: 'person',
        canonicalName: 'FixtureOwner',
        aliases: ['OWNERROLE', '读者甲'],
        provenance: [{ source: 'alias refresh' }],
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    const entity = await store.getEntity('person:fixtureowner');
    assert.equal(entity.createdAt, '2026-05-20T00:00:00Z');
    assert.equal(entity.updatedAt, '2026-05-22T00:00:00Z');
    assert.deepEqual(entity.aliases.sort(), ['OWNERROLE', '读者甲'].sort());
  });

  it('updates stored alias surfaces when only alias casing changes', async () => {
    await store.upsertEntities([
      {
        entityId: 'person:fixtureowner',
        type: 'person',
        canonicalName: 'FixtureOwner',
        aliases: ['OWNERROLE'],
        provenance: [{ source: 'initial seed' }],
        updatedAt: '2026-05-20T00:00:00Z',
      },
    ]);

    await store.upsertEntities([
      {
        entityId: 'person:fixtureowner',
        type: 'person',
        canonicalName: 'FixtureOwner',
        aliases: ['ownerrole'],
        provenance: [{ source: 'initial seed' }],
        updatedAt: '2026-05-21T00:00:00Z',
      },
    ]);

    const entity = await store.getEntity('person:fixtureowner');
    assert.deepEqual(entity.aliases, ['ownerrole']);

    const matches = await store.resolveEntityAliases('OWNERROLE asked about recall');
    assert.deepEqual(
      matches.map((m) => [m.entityId, m.matchedAlias]),
      [['person:fixtureowner', 'ownerrole']],
    );
  });

  it('normalizes aliases without host-locale case folding', async () => {
    const { normalizeEntityAlias } = await import('../../dist/domains/memory/EntityRegistry.js');
    const original = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function patchedToLocaleLowerCase(locale) {
      if (locale === undefined) return 'locale-sensitive';
      return original.call(this, locale);
    };

    try {
      assert.equal(normalizeEntityAlias('I'), 'i');
    } finally {
      String.prototype.toLocaleLowerCase = original;
    }
  });

  it('resolves query aliases deterministically without classifier inference', async () => {
    await store.upsertEntities([
      {
        entityId: 'person:fixtureowner',
        type: 'person',
        canonicalName: 'FixtureOwner',
        aliases: ['fixtureowner', '读者甲', 'OWNERROLE'],
        provenance: [{ source: 'F209 Phase B test' }],
        updatedAt: '2026-05-22T00:00:00Z',
      },
      {
        entityId: 'cat:gemini',
        type: 'cat',
        canonicalName: '暹罗猫/烁烁',
        aliases: ['gemini', '烁烁', '@gemini'],
        provenance: [{ source: 'cat-config.json' }],
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    const ownerroleMatches = await store.resolveEntityAliases('OWNERROLE asked about recall');
    assert.deepEqual(
      ownerroleMatches.map((m) => [m.entityId, m.matchedAlias]),
      [['person:fixtureowner', 'OWNERROLE']],
    );

    const catMatches = await store.resolveEntityAliases('@gemini should review this');
    assert.deepEqual(
      catMatches.map((m) => [m.entityId, m.type]),
      [['cat:gemini', 'cat']],
    );
    assert.equal(catMatches[0].privacyScope, undefined);
    assert.equal(catMatches[0].collectionId, undefined);
    assert.equal(catMatches[0].sensitivity, undefined);

    const noClassifierMatch = await store.resolveEntityAliases('chief vision discussion');
    assert.equal(noClassifierMatch.length, 0);
  });

  it('resolves canonical names even when they are not duplicated in aliases', async () => {
    await store.upsertEntities([
      {
        entityId: 'person:fixtureowner',
        type: 'person',
        canonicalName: 'FixtureOwner',
        aliases: ['OWNERROLE', '读者甲'],
        provenance: [{ source: 'F209 Phase B test' }],
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    const matches = await store.resolveEntityAliases('FixtureOwner asked about recall');

    assert.deepEqual(
      matches.map((m) => [m.entityId, m.matchedAlias]),
      [['person:fixtureowner', 'FixtureOwner']],
    );
  });
});
