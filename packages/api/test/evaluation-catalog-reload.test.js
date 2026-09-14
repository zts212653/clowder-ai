// F257: the evaluation catalog is a process-wide holder. After a governance
// write lands on disk, `reloadEvaluationUnits` must make the unit manifest
// follow disk without changing the catalog's identity — every constructor-
// injected reader (runtime, executor, describer, read models) keeps its
// reference and sees the new units. The Objective / evaluation-model registry
// is deliberately not hot-swapped (KD-22: a cycle keeps one evaluator model
// version). A failed load keeps the previous manifest and reports the error.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const OBJECTIVES_DIR = join('docs', 'harness-feedback', 'objectives');

function seedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'f257-catalog-'));
  mkdirSync(join(root, OBJECTIVES_DIR), { recursive: true });
  for (const file of ['registry.yaml', 'unit-evaluation-manifest.yaml']) {
    cpSync(join(repoRoot, OBJECTIVES_DIR, file), join(root, OBJECTIVES_DIR, file));
  }
  return root;
}

function appendUnit(root, unit) {
  const path = join(root, OBJECTIVES_DIR, 'unit-evaluation-manifest.yaml');
  const document = YAML.parse(readFileSync(path, 'utf8'));
  document.units.push(unit);
  writeFileSync(path, YAML.stringify(document), 'utf8');
}

async function loadCatalogModule() {
  return import('../dist/infrastructure/harness-eval/evaluation/evaluation-catalog.js');
}

describe('evaluation catalog: unit manifest reload', () => {
  const roots = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test('a unit appended on disk becomes visible to every existing reader without a restart', async () => {
    const { loadEvaluationCatalog, reloadEvaluationUnits } = await loadCatalogModule();
    const root = seedRoot();
    roots.push(root);
    const loaded = await loadEvaluationCatalog(root);
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.error);
    const catalog = loaded.catalog;
    // A constructor-injected reader keeps the object, never a copy of its fields.
    const reader = { catalog };
    const unitIds = () => reader.catalog.manifest.units.map((unit) => unit.unitId);
    assert.ok(!unitIds().includes('D99'), 'precondition: the probe unit does not exist yet');

    appendUnit(root, {
      unitId: 'D99',
      hookId: 'd99-reload-probe',
      unitState: 'evaluable',
      // Non-baseline units must declare origin: local (unit manifest contract).
      origin: 'local',
      objectives: [{ objectiveId: 'turn-custody-closure' }],
    });

    const reloaded = await reloadEvaluationUnits(catalog, root);
    assert.ok(reloaded.ok, reloaded.ok ? '' : reloaded.error);
    assert.equal(reader.catalog, catalog, 'the holder identity is stable');
    assert.ok(unitIds().includes('D99'), 'the appended unit is visible through the existing reference');
    assert.ok(unitIds().includes('D21'), 'existing units survive the reload');
  });

  test('the Objective / evaluation-model registry is never hot-swapped by a unit reload (KD-22)', async () => {
    const { loadEvaluationCatalog, reloadEvaluationUnits } = await loadCatalogModule();
    const root = seedRoot();
    roots.push(root);
    const loaded = await loadEvaluationCatalog(root);
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.error);
    const catalog = loaded.catalog;
    const registryBefore = catalog.registry;
    const registrySnapshot = JSON.stringify(registryBefore);

    // An unrelated edit lands in registry.yaml on disk: a new metric on a live model.
    const registryPath = join(root, OBJECTIVES_DIR, 'registry.yaml');
    const document = YAML.parse(readFileSync(registryPath, 'utf8'));
    document.evaluationModels[0].metrics.push({
      id: 'metric-injected-mid-cycle',
      kind: 'counter',
      statement: 'must not appear in a running cycle',
    });
    writeFileSync(registryPath, YAML.stringify(document), 'utf8');
    appendUnit(root, {
      unitId: 'D97',
      hookId: 'd97-reload-probe',
      unitState: 'evaluable',
      // Non-baseline units must declare origin: local (unit manifest contract).
      origin: 'local',
      objectives: [{ objectiveId: 'turn-custody-closure' }],
    });

    const reloaded = await reloadEvaluationUnits(catalog, root);
    assert.ok(reloaded.ok, reloaded.ok ? '' : reloaded.error);
    assert.equal(catalog.registry, registryBefore, 'registry identity is untouched');
    assert.equal(JSON.stringify(catalog.registry), registrySnapshot, 'registry content is untouched');
    assert.ok(
      !JSON.stringify(catalog.registry).includes('metric-injected-mid-cycle'),
      'a disk edit to the registry does not reach running cycles through a unit reload',
    );
    assert.ok(
      catalog.manifest.units.some((unit) => unit.unitId === 'D97'),
      'the unit manifest still follows disk',
    );
  });

  test('a manifest that fails validation keeps the previous snapshot and reports the error', async () => {
    const { loadEvaluationCatalog, reloadEvaluationUnits } = await loadCatalogModule();
    const root = seedRoot();
    roots.push(root);
    const loaded = await loadEvaluationCatalog(root);
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.error);
    const catalog = loaded.catalog;
    const before = catalog.manifest;

    appendUnit(root, {
      unitId: 'D98',
      hookId: 'd98-broken-probe',
      unitState: 'evaluable',
      objectives: [{ objectiveId: 'objective-that-does-not-exist' }],
    });

    const reloaded = await reloadEvaluationUnits(catalog, root);
    assert.equal(reloaded.ok, false, 'validation failure is reported, not swallowed');
    assert.match(reloaded.error, /objective-that-does-not-exist/);
    assert.equal(catalog.manifest, before, 'the previous snapshot is kept on failure');
    assert.ok(!catalog.manifest.units.some((unit) => unit.unitId === 'D98'), 'no partial snapshot leaks in');
  });
});
