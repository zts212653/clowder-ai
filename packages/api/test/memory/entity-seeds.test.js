import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const MOCK_HINDSIGHT = {
  recall: async () => [],
  retain: async () => {},
  reflect: async () => '',
  ensureBank: async () => {},
  isHealthy: async () => true,
};

describe('F209 entity seeds', () => {
  it('resolves the optional packaged seed location and accepts an absent installation seed', async (t) => {
    const { getDefaultEntitySeedPath, loadExplicitEntitySeeds } = await import(
      '../../dist/domains/memory/entity-seeds.js'
    );
    assert.equal(
      getDefaultEntitySeedPath(),
      fileURLToPath(new URL('../../../../config/entity-seeds.json', import.meta.url)),
    );
    const root = mkdtempSync(join(tmpdir(), 'entity-seed-absence-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(loadExplicitEntitySeeds(join(root, 'absent-seeds.json')), []);
  });

  it('loads explicit person seeds and one-way roster cat aliases on memory startup', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const root = mkdtempSync(join(tmpdir(), 'f209-entity-seeds-'));
    const docsRoot = join(root, 'docs');
    const markersDir = join(root, 'markers');
    mkdirSync(docsRoot, { recursive: true });
    mkdirSync(markersDir, { recursive: true });
    const seedPath = join(root, 'entity-seeds.json');
    writeFileSync(
      seedPath,
      `${JSON.stringify(
        {
          version: 1,
          entities: [
            {
              entityId: 'person:fixture-owner',
              type: 'person',
              canonicalName: 'Fixture Person',
              aliases: ['case-person', 'case-surface', 'case-role', 'case-owner'],
              provenance: [
                {
                  source: 'F209 Phase B.1 test seed',
                  anchor: 'F209',
                  date: '2026-05-23',
                },
              ],
              updatedAt: '2026-05-23T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    try {
      const sqlitePath = join(root, 'evidence.sqlite');
      const services = await createMemoryServices({
        type: 'sqlite',
        sqlitePath,
        docsRoot,
        markersDir,
        globalDbPath: join(root, 'global.sqlite'),
        dataDir: join(root, 'collections'),
        entitySeedPath: seedPath,
      });

      const person = await services.store.getEntity('person:fixture-owner');
      assert.ok(person, 'explicit person seed should be loaded');
      assert.deepEqual(person.aliases.sort(), ['case-person', 'case-surface', 'case-role', 'case-owner'].sort());
      assert.equal(person.provenance[0]?.source, 'F209 Phase B.1 test seed');

      const { loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');
      for (const id of Object.keys(toAllCatConfigs(loadCatConfig()))) {
        const cat = await services.store.getEntity(`cat:${id}`);
        assert.ok(cat, `shipped roster ${id} must seed a retrieval anchor`);
        assert.equal(cat.type, 'cat');
        assert.ok(cat.aliases.includes(`@${id}`));
        assert.equal(cat.provenance[0]?.source, 'F032 roster');
      }

      const { default: Database } = await import('better-sqlite3');
      const auditDb = new Database(sqlitePath, { readonly: true });
      try {
        const sources = auditDb.prepare('SELECT DISTINCT source FROM entity_revision_events').all();
        assert.deepEqual(sources, [{ source: 'seed-sync' }], 'startup seeds must cross the registry revision net');
      } finally {
        auditDb.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves explicit cat seeds when roster entity IDs collide', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const root = mkdtempSync(join(tmpdir(), 'f209-explicit-cat-seeds-'));
    const docsRoot = join(root, 'docs');
    const markersDir = join(root, 'markers');
    mkdirSync(docsRoot, { recursive: true });
    mkdirSync(markersDir, { recursive: true });
    const seedPath = join(root, 'entity-seeds.json');
    writeFileSync(
      seedPath,
      `${JSON.stringify(
        {
          version: 1,
          entities: [
            {
              entityId: 'cat:codex',
              type: 'cat',
              canonicalName: 'Curated Codex',
              aliases: ['curated-codex', 'review-guardian'],
              provenance: [
                {
                  source: 'F209 Phase B.1 explicit test seed',
                  anchor: 'entity-seeds.json',
                  date: '2026-05-23',
                },
              ],
              updatedAt: '2026-05-23T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    try {
      const services = await createMemoryServices({
        type: 'sqlite',
        sqlitePath: join(root, 'evidence.sqlite'),
        docsRoot,
        markersDir,
        globalDbPath: join(root, 'global.sqlite'),
        dataDir: join(root, 'collections'),
        entitySeedPath: seedPath,
      });

      const codex = await services.store.getEntity('cat:codex');
      assert.ok(codex, 'explicit cat seed should be loaded');
      assert.equal(codex.canonicalName, 'Curated Codex');
      assert.deepEqual(codex.aliases.sort(), ['curated-codex', 'review-guardian'].sort());
      assert.equal(codex.provenance[0]?.source, 'F209 Phase B.1 explicit test seed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets /api/evidence/search find case-role evidence that only mentions case-surface after seed load', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');

    const root = mkdtempSync(join(tmpdir(), 'f209-entity-seed-dogfood-'));
    const docsRoot = join(root, 'docs');
    const markersDir = join(root, 'markers');
    mkdirSync(docsRoot, { recursive: true });
    mkdirSync(markersDir, { recursive: true });
    const seedPath = join(root, 'entity-seeds.json');
    writeFileSync(
      seedPath,
      `${JSON.stringify(
        {
          version: 1,
          entities: [
            {
              entityId: 'person:fixture-owner',
              type: 'person',
              canonicalName: 'Fixture Person',
              aliases: ['case-person', 'case-surface', 'case-role', 'case-owner'],
              provenance: [{ source: 'F209 Phase B.1 test seed', anchor: 'F209', date: '2026-05-23' }],
              updatedAt: '2026-05-23T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    try {
      const services = await createMemoryServices({
        type: 'sqlite',
        sqlitePath: join(root, 'evidence.sqlite'),
        docsRoot,
        markersDir,
        globalDbPath: join(root, 'global.sqlite'),
        dataDir: join(root, 'collections'),
        entitySeedPath: seedPath,
      });

      await services.store.upsert([
        {
          anchor: 'thread-f209-b1-dogfood',
          kind: 'thread',
          status: 'active',
          title: 'Alias dogfood thread',
          summary: 'case-surface asked whether the evidence recall dogfood loop is real.',
          updatedAt: '2026-05-23T00:00:00.000Z',
        },
      ]);

      const app = Fastify();
      await app.register(evidenceRoutes, {
        hindsightClient: MOCK_HINDSIGHT,
        sharedBank: 'cat-cafe-shared',
        evidenceStore: services.store,
      });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/evidence/search?q=case-role&limit=5',
      });
      await app.close();

      assert.equal(res.statusCode, 200);
      const body = res.json();
      const results = body.results;
      const hit = results.find((item) => item.anchor === 'thread-f209-b1-dogfood');
      assert.ok(hit, 'case-role query should retrieve evidence that only contains case-surface');
      assert.equal(hit.matchReason, 'entity:person:fixture-owner');
      assert.equal(hit.entityMatches?.[0]?.matchedAlias, 'case-role');
      assert.equal(hit.entityMatches?.[0]?.surface, 'case-surface');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
