import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { loadObjectiveRegistry, parseObjectiveRegistry } = await import(
  '../dist/infrastructure/harness-eval/objective-registry.js'
);
const { CANONICAL_UNIT_IDS, loadUnitEvaluationManifest, parseUnitEvaluationManifest } = await import(
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
    cycleTrigger: { cumulativeThreshold: 200, counterexampleThreshold: 3, cadenceDays: 7, minimumIntervalMs: 7200000 }
    metrics:
      - id: x-count
        label: X count
        kind: counter
        verdictRule: { kind: counter-zero }
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
      lifecycle: 'active',
    });
    assert.deepEqual(parsed.registry.evaluationModels[0].metrics[0].trigger, {
      kind: 'distinct-counterexamples',
      threshold: 3,
    });
    assert.deepEqual(parsed.registry.evaluationModels[0].cycleTrigger, {
      cumulativeThreshold: 200,
      counterexampleThreshold: 3,
      cadenceDays: 7,
      minimumIntervalMs: 7_200_000,
    });
    assert.deepEqual(parsed.registry.evaluationModels[0].metrics[0].verdictRule, { kind: 'counter-zero' });
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

  test('shipped registry keeps retired history while exposing 22 active single-goal Objectives', async () => {
    const loaded = await loadObjectiveRegistry(registryPath);
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.error);
    assert.equal(loaded.registry.objectives.length, 24);
    assert.equal(new Set(loaded.registry.objectives.map((objective) => objective.id)).size, 24);
    assert.equal(loaded.registry.objectives.filter((objective) => objective.lifecycle === 'active').length, 22);
    assert.deepEqual(
      loaded.registry.objectives
        .filter((objective) => objective.lifecycle === 'retired')
        .map((objective) => objective.id)
        .sort(),
      ['engineering-quality-discipline', 'review-independence'],
    );
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
    const ironObjective = loaded.registry.objectives.find((objective) => objective.id === 'iron-law-compliance');
    const ironModel = loaded.registry.evaluationModels.find((model) => model.id === ironObjective?.evaluationModelId);
    assert.equal(ironModel.metrics.length, 5);
    assert.equal(ironModel.cycleTrigger.counterexampleThreshold, 3);
  });
});

describe('F257 UnitEvaluationManifest', () => {
  test('shipped manifest covers exactly the baseline id set, and S13 belongs only to tool-access-correct-use', async () => {
    const registry = await loadObjectiveRegistry(registryPath);
    assert.equal(registry.ok, true, registry.ok ? '' : registry.error);
    const manifest = await loadUnitEvaluationManifest(manifestPath, registry.registry);
    assert.equal(manifest.ok, true, manifest.ok ? '' : manifest.error);
    // Compare the explicit id SETS, not counts: `>= N` would pass while a baseline unit
    // silently disappeared and a governance-authored one took its place. Totals below are
    // diagnostics only. Governance may still append `origin: local` units (D22 is first).
    const baselineIds = manifest.manifest.units
      .filter((unit) => (unit.origin ?? 'baseline') === 'baseline')
      .map((unit) => unit.unitId)
      .sort();
    assert.deepEqual(
      baselineIds,
      [...CANONICAL_UNIT_IDS].sort(),
      `baseline id set drifted (baseline=${baselineIds.length}, canonical=${CANONICAL_UNIT_IDS.length})`,
    );
    const localIds = manifest.manifest.units.filter((unit) => unit.origin === 'local').map((unit) => unit.unitId);
    assert.deepEqual(localIds, ['D22'], 'D22 stays the governance-authored local unit');
    assert.equal(
      new Set(manifest.manifest.units.map((unit) => unit.unitId)).size,
      manifest.manifest.units.length,
      'unit ids stay unique once governance can append',
    );
    const s13 = manifest.manifest.units.find((unit) => unit.unitId === 'S13');
    assert.deepEqual(s13.objectives, [{ objectiveId: 'tool-access-correct-use' }]);
    assert.equal(
      manifest.manifest.units.every((unit) => unit.objectives.length === 1),
      true,
      'every segment must belong to exactly one Objective',
    );
    const c1 = manifest.manifest.units.find((unit) => unit.unitId === 'C1');
    assert.deepEqual(c1.objectives, [{ objectiveId: 'tool-access-correct-use' }]);
    const l4 = manifest.manifest.units.find((unit) => unit.unitId === 'L4');
    assert.deepEqual(l4.objectives, [{ objectiveId: 'iron-law-compliance' }]);
    const attachedObjectives = new Set(
      manifest.manifest.units.flatMap((unit) => unit.objectives.map((item) => item.objectiveId)),
    );
    for (const objective of registry.registry.objectives.filter((item) => item.lifecycle === 'active')) {
      assert.equal(attachedObjectives.has(objective.id), true, `active Objective ${objective.id} needs a segment`);
      const model = registry.registry.evaluationModels.find((item) => item.id === objective.evaluationModelId);
      assert.ok(model);
      assert.ok(model.cycleTrigger.cumulativeThreshold >= 200);
      assert.ok(model.cycleTrigger.counterexampleThreshold >= 3);
      assert.ok(model.cycleTrigger.cadenceDays >= 7);
    }
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
    assert.match(validateSignalCoordinates(catalog, { ...valid, objectiveId: 'review-independence' }), /retired/);
  });

  test('evaluation catalog failure degrades the sidecar instead of aborting API bootstrap', () => {
    const source = readFileSync(apiIndexPath, 'utf8');
    assert.doesNotMatch(source, /if \(!catalog\.ok\) throw/);
    assert.match(
      source,
      /if \(catalogResult\.ok\)[\s\S]*bootstrapObjectiveEvaluationRuntime[\s\S]*else[\s\S]*app\.log\.warn/,
    );
    assert.doesNotMatch(source, /bootstrapSemanticSweepCoordinator|getSemanticSweepCoordinator/);
  });

  test('missing canonical units and unknown objectives fail closed', () => {
    const registry = parseObjectiveRegistry(minimalV2);
    assert.equal(registry.ok, true);
    const missing = parseUnitEvaluationManifest(
      'manifestVersion: 1\nregistryVersion: 2\nunits:\n  - unitId: S13\n    hookId: s13-doc\n    unitState: evaluable\n    objectives: [{ objectiveId: x-goal }]\n',
      registry.registry,
    );
    assert.equal(missing.ok, false);
    assert.match(missing.error, new RegExp(`canonical ${CANONICAL_UNIT_IDS.length} units`));
  });

  test('rejects clause-level and multi-Objective segment membership', () => {
    const registry = parseObjectiveRegistry(minimalV2);
    assert.equal(registry.ok, true);
    const prefix = CANONICAL_UNIT_IDS.map((unitId, index) => ({
      unitId,
      hookId: `hook-${index}`,
      unitState: 'evaluable',
      objectives: [{ objectiveId: 'x-goal' }],
    }));
    const multi = structuredClone(prefix);
    multi[0].objectives.push({ objectiveId: 'x-goal' });
    assert.match(
      parseUnitEvaluationManifest(
        JSON.stringify({ manifestVersion: 1, registryVersion: 2, units: multi }),
        registry.registry,
      ).error,
      /exactly 1 (?:item|element)/i,
    );
    const clause = structuredClone(prefix);
    clause[0].objectives[0].clauseId = 'detail';
    assert.match(
      parseUnitEvaluationManifest(
        JSON.stringify({ manifestVersion: 1, registryVersion: 2, units: clause }),
        registry.registry,
      ).error,
      /unrecognized key/i,
    );
  });
});

describe('F257 manifest scope contract — baseline vs local evolution', () => {
  // The shipped package and this instance must not blur together: a unit the
  // installer ships is baseline, anything this line authors afterwards is local.
  // Promoting local → baseline is an explicit act (add it to CANONICAL_UNIT_IDS
  // upstream), never a side effect of appending a manifest row.
  const baselineRow = (unitId, hookId, objectiveId) =>
    `  - { unitId: ${unitId}, hookId: ${hookId}, unitState: evaluable, objectives: [{ objectiveId: ${objectiveId} }] }`;

  async function parseWith(extraRows) {
    const { parseUnitEvaluationManifest } = await import(
      '../dist/infrastructure/harness-eval/unit-evaluation-manifest.js'
    );
    const { readFileSync } = await import('node:fs');
    const { findMonorepoRoot } = await import('../dist/utils/monorepo-root.js');
    const { parseObjectiveRegistry } = await import('../dist/infrastructure/harness-eval/objective-registry.js');
    const root = findMonorepoRoot();
    const registryRaw = readFileSync(`${root}/docs/harness-feedback/objectives/registry.yaml`, 'utf8');
    const registry = parseObjectiveRegistry(registryRaw);
    const shipped = readFileSync(`${root}/docs/harness-feedback/objectives/unit-evaluation-manifest.yaml`, 'utf8');
    return parseUnitEvaluationManifest(`${shipped.trimEnd()}\n${extraRows}\n`, registry.registry ?? registry);
  }

  test('a unit outside the shipped baseline must declare itself local', async () => {
    const result = await parseWith(baselineRow('Z98', 'z98-undeclared-probe', 'identity-truth'));
    assert.equal(result.ok, false, 'an undeclared non-baseline unit must not pass as shipped content');
    assert.match(result.error, /Z98/);
  });

  test('a declared local unit is accepted', async () => {
    const result = await parseWith(
      `  - { unitId: Z97, hookId: z97-declared-probe, unitState: evaluable, origin: local, objectives: [{ objectiveId: identity-truth }] }`,
    );
    assert.equal(result.ok, true, result.ok ? '' : result.error);
  });
});
