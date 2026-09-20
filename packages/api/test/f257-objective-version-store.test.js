import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { ObjectiveVersionStore } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveVersionStore.js'
);

const root = await mkdtemp(join(tmpdir(), 'f257-objective-version-'));
after(() => rm(root, { recursive: true, force: true }));
const templatePath = join(root, 'd1.md');
await writeFile(templatePath, 'baseline content');

class FakeRedis {
  strings = new Map();
  async set(key, value, ...args) {
    if (args.includes('NX') && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }
}

const catalog = {
  registry: {
    objectives: [
      {
        id: 'obj',
        label: 'Objective',
        statement: 'Keep behavior sound.',
        evaluationModelId: 'em',
        lifecycle: 'active',
      },
    ],
    evaluationModels: [
      {
        id: 'em',
        label: 'Evaluation model',
        ruleVersion: 'v1',
        cycleTrigger: { cumulativeThreshold: 200, counterexampleThreshold: 3, cadenceDays: 7, minimumIntervalMs: 1 },
        metrics: [{ id: 'm1', label: 'Metric', kind: 'counter' }],
      },
    ],
  },
  manifest: { units: [{ unitId: 'D1', objectives: [{ objectiveId: 'obj' }] }] },
};
const runtime = { enabled: true, version: 1, content: undefined, condition: undefined };
const hook = {
  manifest: {
    id: 'D1',
    name: 'Whole hook',
    stage: 'per-turn',
    order: 400,
    version: 1,
    enabled: true,
    template: 'd1.md',
    resolver: 'D1Resolver',
    inputs: ['threadId'],
    disableable: true,
    safetyTier: 'editable',
    transparencyTier: 'visible-by-default',
    governanceTier: 'auto-evolve',
  },
  templatePath,
};
const registry = {
  getHook: (id) => (id === 'D1' ? hook : undefined),
  isEnabled: () => runtime.enabled,
  getActiveVersion: () => runtime.version,
  getContentOverride: () => runtime.content,
  getConditionOverride: () => runtime.condition,
};
const policy = {
  cumulativeThreshold: 200,
  counterexampleThreshold: 3,
  cadenceDays: 7,
  minimumIntervalMs: 1,
  consecutiveKeepCycles: 0,
  consecutiveCadenceKeepCycles: 0,
};

test('Objective versions are immutable content-addressed snapshots of model, lifecycle and whole-hook state', async () => {
  const redis = new FakeRedis();
  const store = new ObjectiveVersionStore(redis, catalog, () => registry);
  const initial = await store.resolve('obj', { triggerPolicy: policy, lifecycle: 'active' });
  const duplicate = await store.resolve('obj', { triggerPolicy: policy, lifecycle: 'active' });
  assert.deepEqual(duplicate, initial);
  assert.equal(redis.strings.size, 1);

  runtime.enabled = false;
  const disabled = await store.resolve('obj', { triggerPolicy: policy, lifecycle: 'active' });
  assert.notEqual(disabled.version, initial.version);

  runtime.condition = { conditionRef: 'routing-mode-in', params: { values: ['serial'] } };
  const narrowed = await store.resolve('obj', { triggerPolicy: policy, lifecycle: 'active' });
  assert.notEqual(narrowed.version, disabled.version);

  const mature = await store.resolve('obj', {
    triggerPolicy: { ...policy, cumulativeThreshold: 500, cadenceDays: 21, consecutiveKeepCycles: 4 },
    lifecycle: 'dormant',
  });
  assert.notEqual(mature.version, narrowed.version);
  const snapshot = JSON.parse(redis.strings.get(mature.versionContentRef));
  assert.equal(snapshot.objective.statement, 'Keep behavior sound.');
  assert.equal(snapshot.evaluationModel.metrics[0].id, 'm1');
  assert.equal(snapshot.effectiveLifecycle, 'dormant');
  assert.equal(snapshot.effectiveTriggerPolicy.cumulativeThreshold, 500);
  assert.equal(snapshot.units[0].manifest.stage, 'per-turn');
  assert.equal(snapshot.units[0].manifest.order, 400);
  assert.equal(snapshot.units[0].manifest.resolver, 'D1Resolver');
  assert.deepEqual(snapshot.units[0].conditionOverride, runtime.condition);
});
