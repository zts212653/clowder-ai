import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { loadObjectiveRegistry, parseObjectiveRegistry } = await import(
  '../dist/infrastructure/harness-eval/objective-registry.js'
);
const { loadUnitEvaluationManifest, parseUnitEvaluationManifest } = await import(
  '../dist/infrastructure/harness-eval/unit-evaluation-manifest.js'
);
const { validateSignalCoordinates } = await import(
  '../dist/infrastructure/harness-eval/deviation/report-harness-signal.js'
);

const testDir = dirname(fileURLToPath(import.meta.url));
const registryPath = resolve(testDir, '..', '..', '..', 'docs', 'harness-feedback', 'objectives', 'registry.yaml');
const manifestPath = resolve(
  testDir,
  '..',
  '..',
  '..',
  'docs',
  'harness-feedback',
  'objectives',
  'unit-evaluation-manifest.yaml',
);
const apiIndexPath = resolve(testDir, '..', 'src', 'index.ts');

const minimalV2 = `
registryVersion: 2
evaluationModels:
  - id: em-x
    label: X model
    ruleVersion: v1
    metrics:
      - id: x-count
        label: X count
        kind: counter
        evaluator: { kind: code, ruleRef: x-rule }
        trigger: { kind: distinct-counterexamples, threshold: 3 }
objectives:
  - id: x-goal
    label: X goal
    statement: Do X correctly
    evaluationModelId: em-x
`;

describe('F257 Objective registry v2', () => {
  test('parses a static Objective with its Evaluation Model and count-only metric', () => {
    const parsed = parseObjectiveRegistry(minimalV2);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
    assert.equal(parsed.registry.registryVersion, 2);
    assert.deepEqual(parsed.registry.objectives[0], {
      id: 'x-goal',
      label: 'X goal',
      statement: 'Do X correctly',
      evaluationModelId: 'em-x',
    });
    assert.deepEqual(parsed.registry.evaluationModels[0].metrics[0].trigger, {
      kind: 'distinct-counterexamples',
      threshold: 3,
    });
  });

  test('rejects v1 and malformed cross-references instead of preserving compatibility', () => {
    const old = parseObjectiveRegistry('registryVersion: 1\nobjectives: []\n');
    assert.equal(old.ok, false);

    const unknownModel = parseObjectiveRegistry(
      minimalV2.replace('evaluationModelId: em-x', 'evaluationModelId: em-missing'),
    );
    assert.equal(unknownModel.ok, false);
    assert.match(unknownModel.error, /unknown evaluation model/);

    const wrongCounterTrigger = parseObjectiveRegistry(
      minimalV2.replace(
        'trigger: { kind: distinct-counterexamples, threshold: 3 }',
        'trigger: { kind: cadence, cadence: weekly }',
      ),
    );
    assert.equal(wrongCounterTrigger.ok, false);
    assert.match(wrongCounterTrigger.error, /counter metric/);
  });

  test('shipped registry defines 23 single-goal Objectives and explicit S13 metrics', async () => {
    const loaded = await loadObjectiveRegistry(registryPath);
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.error);
    assert.equal(loaded.registry.objectives.length, 23);
    assert.equal(new Set(loaded.registry.objectives.map((objective) => objective.id)).size, 23);
    assert.equal(
      loaded.registry.objectives.some((objective) => objective.id === 'obj-routing-delivery'),
      false,
    );
    assert.equal(
      loaded.registry.objectives.some((objective) => objective.id === 'obj-identity-integrity'),
      false,
    );

    const toolObjective = loaded.registry.objectives.find((objective) => objective.id === 'tool-access-correct-use');
    assert.ok(toolObjective);
    const toolModel = loaded.registry.evaluationModels.find((model) => model.id === toolObjective.evaluationModelId);
    assert.deepEqual(
      toolModel.metrics.map((metric) => [metric.id, metric.kind]),
      [
        ['tool-schema-failure-count', 'counter'],
        ['tool-discovery-success-rate', 'rate'],
        ['tool-choice-correctness', 'semantic'],
      ],
    );
  });
});

describe('F257 UnitEvaluationManifest', () => {
  test('shipped manifest covers all 46 segments and S13 belongs only to tool-access-correct-use', async () => {
    const registry = await loadObjectiveRegistry(registryPath);
    assert.equal(registry.ok, true, registry.ok ? '' : registry.error);
    const manifest = await loadUnitEvaluationManifest(manifestPath, registry.registry);
    assert.equal(manifest.ok, true, manifest.ok ? '' : manifest.error);
    assert.equal(manifest.manifest.units.length, 46);
    assert.equal(new Set(manifest.manifest.units.map((unit) => unit.unitId)).size, 46);
    const s13 = manifest.manifest.units.find((unit) => unit.unitId === 'S13');
    assert.deepEqual(s13.objectives, [{ objectiveId: 'tool-access-correct-use' }]);
    const c1 = manifest.manifest.units.find((unit) => unit.unitId === 'C1');
    assert.equal(c1.objectives.length, 2, 'compound segment is split by stable clauseId');
    const b1 = manifest.manifest.units.find((unit) => unit.unitId === 'B1');
    assert.equal(b1.unitState, 'not-ready', 'placeholder B1 must not produce evaluation verdicts');
    assert.match(b1.notReadyReason, /placeholder|占位|等待/i);

    const catalog = { registry: registry.registry, manifest: manifest.manifest };
    const valid = {
      objectiveId: 'tool-access-correct-use',
      metricId: 'tool-schema-failure-count',
      unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
      polarity: 'counterexample',
    };
    assert.equal(validateSignalCoordinates(catalog, valid), null);
    assert.match(validateSignalCoordinates(catalog, { ...valid, metricId: 'self-review-count' }), /does not belong/);
    assert.match(
      validateSignalCoordinates(catalog, { ...valid, objectiveId: 'review-independence' }),
      /does not belong|not attached/,
    );
  });

  test('evaluation catalog failure degrades the sidecar instead of aborting API bootstrap', () => {
    const source = readFileSync(apiIndexPath, 'utf8');
    assert.doesNotMatch(source, /if \(!catalog\.ok\) throw/);
    assert.match(
      source,
      /if \(catalogResult\.ok\)[\s\S]*bootstrapObjectiveEvaluationRuntime[\s\S]*else[\s\S]*evaluation catalog load failed \(degraded\)/,
      'an invalid catalog must skip runtime bootstrap and log the degraded state',
    );
    assert.match(
      source,
      /catch \(err\)[\s\S]*evaluation runtime bootstrap failed \(degraded\)/,
      'catalog loading and runtime bootstrap exceptions must also degrade without aborting API startup',
    );
    assert.match(
      source,
      /getObjectiveEvaluationRuntime\(\)[\s\S]*bootstrapSemanticSweepCoordinator/,
      'semantic sweep bootstrap must also be gated by the optional evaluation runtime',
    );
  });

  test('missing canonical units and unknown objectives fail closed', () => {
    const registry = parseObjectiveRegistry(minimalV2);
    assert.equal(registry.ok, true);
    const missing = parseUnitEvaluationManifest(
      'manifestVersion: 1\nregistryVersion: 2\nunits:\n  - unitId: S13\n    hookId: s13-doc\n    unitState: evaluable\n    objectives: [{ objectiveId: x-goal }]\n',
      registry.registry,
    );
    assert.equal(missing.ok, false);
    assert.match(missing.error, /canonical 46 units/);
  });
});
