/**
 * F208 Phase C: Dossier API routes — model-grouped capability profiles.
 *
 * GET /api/dossier returns dossier profiles grouped by model (KD-15).
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

/** Minimal dossier markdown with two cats — one model shared (KD-15 test case). */
const DOSSIER_MD = `
# Clowder AI 能力画像档案

## opus

\`\`\`yaml
# structured-profile: cat:opus
entityId: "cat:opus"
oneLiner: "深度思考和系统设计的主力"
l0RosterSummary: "深度思考、系统设计、架构判断"
routingSignals:
  peakCapabilities:
    - "architecture"
    - "system-design"
  antiSignals:
    - "quick-visual-feedback"
provenance:
  version: "0.3"
  date: "2026-06-19"
  primarySources:
    - "peer"
\`\`\`

## antig-opus

\`\`\`yaml
# structured-profile: cat:antig-opus
entityId: "cat:antig-opus"
oneLiner: "Browser automation 和截图录屏"
l0RosterSummary: "图片生成、截图录屏、browser automation"
routingSignals:
  peakCapabilities:
    - "browser-automation"
    - "screenshot"
  antiSignals:
    - "coding"
provenance:
  version: "0.1"
  date: "2026-06-19"
  primarySources:
    - "peer"
\`\`\`

## sonnet

\`\`\`yaml
# structured-profile: cat:sonnet
entityId: "cat:sonnet"
oneLiner: "快速灵活的日常对话猫"
l0RosterSummary: "快速灵活，适合日常对话和轻量任务"
provenance:
  version: "0.1"
  date: "2026-06-19"
\`\`\`
`;

describe('Dossier Routes — GET /api/dossier', () => {
  let tmpDir;
  let app;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dossier-test-'));
    // Create dossier file
    await mkdir(join(tmpDir, 'docs', 'team'), { recursive: true });
    await writeFile(join(tmpDir, 'docs', 'team', 'cat-dossier.md'), DOSSIER_MD);

    // Reset dossier cache between tests
    const { _resetDossierCache } = await import('../../shared/dist/dossier/load-dossier-profiles.js');
    _resetDossierCache();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function createApp(projectRoot) {
    const { dossierRoutes } = await import('../dist/routes/dossier.js');
    app = Fastify();
    await app.register(dossierRoutes, { projectRoot });
    return app;
  }

  test('returns model-grouped dossier profiles (KD-15)', async () => {
    const server = await createApp(tmpDir);
    const res = await server.inject({ method: 'GET', url: '/api/dossier' });

    assert.equal(res.statusCode, 200);
    const body = res.json();

    // Should have modelGroups array
    assert.ok(Array.isArray(body.modelGroups), 'modelGroups should be an array');
    assert.ok(body.modelGroups.length > 0, 'should have at least one model group');

    // Should have meta
    assert.ok(body.meta, 'should have meta');
    assert.ok(typeof body.meta.totalModels === 'number');
    assert.ok(typeof body.meta.totalCats === 'number');
  });

  test('same-model cats are grouped together (opus + antig-opus)', async () => {
    const server = await createApp(tmpDir);
    const res = await server.inject({ method: 'GET', url: '/api/dossier' });
    const body = res.json();

    // Find the claude-opus-4-6 group (or whatever model opus/antig-opus map to)
    // The grouping should have both opus and antig-opus under the same model
    const allCatIds = body.modelGroups.flatMap((g) => g.cats.map((c) => c.catId));
    assert.ok(allCatIds.includes('opus'), 'opus should be in response');
    assert.ok(allCatIds.includes('antig-opus'), 'antig-opus should be in response');

    // Find which group has opus
    const opusGroup = body.modelGroups.find((g) => g.cats.some((c) => c.catId === 'opus'));
    const antigGroup = body.modelGroups.find((g) => g.cats.some((c) => c.catId === 'antig-opus'));

    // They should be in the same model group (both use claude-opus-4-6)
    assert.equal(opusGroup.model, antigGroup.model, 'opus and antig-opus should share model group');
    assert.equal(opusGroup.cats.length >= 2, true, 'shared model group should have 2+ cats');
  });

  test('each cat entry includes dossier profile data', async () => {
    const server = await createApp(tmpDir);
    const res = await server.inject({ method: 'GET', url: '/api/dossier' });
    const body = res.json();

    // Find opus in the response
    const opusCat = body.modelGroups.flatMap((g) => g.cats).find((c) => c.catId === 'opus');

    assert.ok(opusCat, 'opus should exist');
    assert.ok(opusCat.dossier, 'opus should have dossier');
    assert.equal(opusCat.dossier.entityId, 'cat:opus');
    assert.equal(opusCat.dossier.oneLiner, '深度思考和系统设计的主力');
    assert.ok(opusCat.dossier.routingSignals, 'should have routingSignals');
    assert.ok(opusCat.dossier.provenance, 'should have provenance');
  });

  test('cats without dossier return dossier: null', async () => {
    const server = await createApp(tmpDir);
    const res = await server.inject({ method: 'GET', url: '/api/dossier' });
    const body = res.json();

    // Find a cat that's in catRegistry but NOT in our test dossier
    const noDossierCats = body.modelGroups.flatMap((g) => g.cats).filter((c) => c.dossier === null);

    // There should be some cats without dossier (catRegistry has more cats than our test dossier)
    assert.ok(noDossierCats.length > 0, 'some cats should have no dossier');
  });

  test('no dossier file returns empty modelGroups gracefully', async () => {
    // Use a temp dir with no dossier file
    const emptyDir = await mkdtemp(join(tmpdir(), 'dossier-empty-'));
    try {
      const { _resetDossierCache } = await import('../../shared/dist/dossier/load-dossier-profiles.js');
      _resetDossierCache();

      const server = await createApp(emptyDir);
      const res = await server.inject({ method: 'GET', url: '/api/dossier' });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.modelGroups));
      // Should still have cats (from catRegistry) but all with dossier: null
      const allDossiers = body.modelGroups.flatMap((g) => g.cats.map((c) => c.dossier));
      assert.ok(
        allDossiers.every((d) => d === null),
        'all dossiers should be null when file missing',
      );
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  test('model grouping uses config truth, not runtime env overrides (P1 regression)', async () => {
    // Regression: getCatModel() env overrides must NOT leak into settings view.
    // If this test breaks, someone re-introduced getCatModel() instead of config.defaultModel.
    const envKey = 'CAT_OPUS_MODEL';
    const original = process.env[envKey];
    try {
      process.env[envKey] = 'fake-override-model-should-not-appear';
      const server = await createApp(tmpDir);
      const res = await server.inject({ method: 'GET', url: '/api/dossier' });
      const body = res.json();

      // opus should still be grouped by its config model, not the env override
      const opusGroup = body.modelGroups.find((g) => g.cats.some((c) => c.catId === 'opus'));
      assert.ok(opusGroup, 'opus should exist in response');
      assert.notEqual(
        opusGroup.model,
        'fake-override-model-should-not-appear',
        'model grouping must use persisted config, not runtime env override',
      );
    } finally {
      if (original === undefined) delete process.env[envKey];
      else process.env[envKey] = original;
    }
  });

  test('empty defaultModel falls back to unknown group (P1 regression)', async () => {
    // Regression: cats with defaultModel: '' must be grouped under 'unknown',
    // not rendered with a blank group title. This injects a real empty-model cat.
    const { catRegistry } = await import('@cat-cafe/shared');
    const fakeCatId = '__empty-model-test__';
    catRegistry.register(fakeCatId, {
      id: fakeCatId,
      name: 'Empty Model Cat',
      displayName: 'Empty Model Cat',
      avatar: '/avatars/default.png',
      color: { primary: '#888', secondary: '#ccc' },
      mentionPatterns: [`@${fakeCatId}`],
      clientId: 'claude-code',
      defaultModel: '', // explicitly empty — the regression target
      mcpSupport: false,
      roleDescription: 'test',
      personality: 'test',
    });
    try {
      const server = await createApp(tmpDir);
      const res = await server.inject({ method: 'GET', url: '/api/dossier' });
      const body = res.json();

      // The injected cat must appear under 'unknown', not an empty-string group
      const emptyModelCat = body.modelGroups.flatMap((g) => g.cats).find((c) => c.catId === fakeCatId);
      assert.ok(emptyModelCat, 'injected empty-model cat should appear in response');

      const emptyModelGroup = body.modelGroups.find((g) => g.cats.some((c) => c.catId === fakeCatId));
      assert.equal(emptyModelGroup.model, 'unknown', 'empty defaultModel must fall back to "unknown" group');

      // No group should have an empty-string key
      for (const group of body.modelGroups) {
        assert.ok(group.model.length > 0, `model group key must not be empty (got "${group.model}")`);
      }
    } finally {
      // Clean up: reset and re-register normal cats to avoid polluting other tests
      catRegistry.reset();
      const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
      const { resolve, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const dir = dirname(fileURLToPath(import.meta.url));
      const templatePath = resolve(dir, '../../../cat-template.json');
      const allConfigs = toAllCatConfigs(loadCatConfig(templatePath));
      for (const [id, config] of Object.entries(allConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('meta includes coverage statistics', async () => {
    const server = await createApp(tmpDir);
    const res = await server.inject({ method: 'GET', url: '/api/dossier' });
    const body = res.json();

    assert.ok(typeof body.meta.dossierCoverage === 'number');
    assert.ok(body.meta.dossierCoverage >= 0 && body.meta.dossierCoverage <= 1);
    assert.ok(typeof body.meta.totalCats === 'number');
    assert.ok(typeof body.meta.totalModels === 'number');
    assert.ok(body.meta.totalModels <= body.meta.totalCats, 'models <= cats');
  });
});
