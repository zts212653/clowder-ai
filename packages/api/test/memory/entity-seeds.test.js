import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const MOCK_HINDSIGHT = {
  recall: async () => [],
  retain: async () => {},
  reflect: async () => '',
  ensureBank: async () => {},
  isHealthy: async () => true,
};

describe('F209 entity seeds', () => {
  it('resolves the default git-tracked seed file from built API dist', async () => {
    const { getDefaultEntitySeedPath, loadExplicitEntitySeeds } = await import(
      '../../dist/domains/memory/entity-seeds.js'
    );

    const defaultPath = getDefaultEntitySeedPath();
    assert.ok(defaultPath.endsWith('/config/entity-seeds.json'), defaultPath);
    assert.equal(existsSync(defaultPath), true);

    const seeds = loadExplicitEntitySeeds(defaultPath);
    const landy = seeds.find((entity) => entity.entityId === 'person:landy');
    assert.ok(landy, 'default seed file should include person:landy');
    assert.ok(landy.aliases.includes('CVO'));
    assert.ok(landy.aliases.includes('铲屎官'));
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
              entityId: 'person:landy',
              type: 'person',
              canonicalName: 'You',
              aliases: ['you', '铲屎官', 'CVO', 'you'],
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
      const services = await createMemoryServices({
        type: 'sqlite',
        sqlitePath: join(root, 'evidence.sqlite'),
        docsRoot,
        markersDir,
        globalDbPath: join(root, 'global.sqlite'),
        dataDir: join(root, 'collections'),
        entitySeedPath: seedPath,
      });

      const landy = await services.store.getEntity('person:landy');
      assert.ok(landy, 'explicit person seed should be loaded');
      assert.deepEqual(landy.aliases.sort(), ['CVO', 'you', 'you', '铲屎官'].sort());
      assert.equal(landy.provenance[0]?.source, 'F209 Phase B.1 test seed');

      const codex = await services.store.getEntity('cat:codex');
      assert.ok(codex, 'cat roster should seed retrieval anchors');
      assert.equal(codex.type, 'cat');
      assert.equal(codex.canonicalName, 'codex', 'cat canonical name should be a specific retrieval anchor');
      assert.ok(codex.aliases.includes('@codex'), 'raw roster mention should be preserved');
      assert.ok(codex.aliases.includes('codex'), 'bare cat id should be searchable');
      assert.equal(codex.aliases.includes('砚砚'), false, 'shared nicknames should not become specific cat aliases');
      assert.equal(codex.aliases.includes('maine-coon'), false, 'breed id should not become a cat alias');
      assert.equal(codex.aliases.includes('缅因猫'), false, 'bare breed mention should not become a cat alias');
      assert.ok(codex.aliases.includes('@缅因猫'), 'explicit raw breed mention can remain a routed alias');
      assert.equal(codex.provenance[0]?.source, 'F032 roster');

      const gpt52 = await services.store.getEntity('cat:gpt52');
      assert.ok(gpt52, 'same-family variants should seed retrieval anchors');
      assert.equal(gpt52.aliases.includes('砚砚'), false, 'shared nicknames should not leak onto variants');

      const opus = await services.store.getEntity('cat:opus');
      assert.ok(opus, 'default breed cat should seed retrieval anchors');
      assert.equal(opus.canonicalName, 'opus', 'family-level display names should not become canonical names');
      assert.equal(opus.aliases.includes('布偶猫'), false, 'bare breed display name should not become a cat alias');
      assert.equal(opus.aliases.includes('宪宪'), false, 'shared breed nicknames should not become cat aliases');
      assert.ok(opus.aliases.includes('@布偶猫'), 'explicit raw breed mention can remain a routed alias');

      const opus47 = await services.store.getEntity('cat:opus-47');
      assert.ok(opus47, 'variant cats should seed retrieval anchors');
      assert.equal(opus47.canonicalName, '布偶猫 Opus 4.7', 'specific variant name can be canonical');
      assert.equal(opus47.aliases.includes('布偶猫'), false, 'breed display name should not become a variant alias');
      assert.equal(opus47.aliases.includes('Opus 4.7'), false, 'variant label should not become a cat alias');
      assert.ok(opus47.aliases.includes('布偶猫4.7'), 'explicit variant mention should remain searchable');
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

  it('lets /api/evidence/search find CVO evidence that only mentions 铲屎官 after seed load', async () => {
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
              entityId: 'person:landy',
              type: 'person',
              canonicalName: 'You',
              aliases: ['you', '铲屎官', 'CVO', 'you'],
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
          summary: '铲屎官 asked whether the evidence recall dogfood loop is real.',
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
        url: '/api/evidence/search?q=CVO&limit=5',
      });
      await app.close();

      assert.equal(res.statusCode, 200);
      const body = res.json();
      const results = body.results;
      const hit = results.find((item) => item.anchor === 'thread-f209-b1-dogfood');
      assert.ok(hit, 'CVO query should retrieve evidence that only contains 铲屎官');
      assert.equal(hit.matchReason, 'entity:person:landy');
      assert.equal(hit.entityMatches?.[0]?.matchedAlias, 'CVO');
      assert.equal(hit.entityMatches?.[0]?.surface, '铲屎官');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
