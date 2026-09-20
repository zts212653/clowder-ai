import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { adaptCycleTriggerPolicy, initialCycleTriggerPolicy } = await import(
  '../dist/infrastructure/harness-eval/evaluation/cycle-trigger-policy.js'
);

const model = {
  id: 'model',
  label: 'Model',
  ruleVersion: 'v1',
  cycleTrigger: {
    cumulativeThreshold: 200,
    counterexampleThreshold: 3,
    cadenceDays: 7,
    minimumIntervalMs: 7_200_000,
  },
  metrics: [],
};
const catalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [model],
    objectives: [{ id: 'objective', label: 'Objective', statement: 'Do well', evaluationModelId: 'model' }],
  },
  manifest: { manifestVersion: 1, registryVersion: 2, units: [] },
};

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    cycleId: 'cycle',
    ownerUserId: 'owner',
    objectiveId: 'objective',
    version: 'v1',
    versionContentRef: 'objective:v1',
    cycleStart: 0,
    cycleEnd: 10,
    evalStatus: 'written',
    windows: [{ start: 0, end: 10 }],
    triggerPolicy: initialCycleTriggerPolicy(model),
    ...overrides,
  };
}

describe('F257 adaptive Objective trigger policy', () => {
  test('raises N on keep while M remains at the factory floor', () => {
    const result = adaptCycleTriggerPolicy(catalog, record({ triggeredBy: ['cumulative'] }), 'keep', 20);
    assert.equal(result.change.before.cumulativeThreshold, 200);
    assert.equal(result.change.after.cumulativeThreshold, 300);
    assert.equal(result.change.after.counterexampleThreshold, 3);
    assert.equal(result.change.after.cadenceDays, 7);
    assert.equal(result.change.after.consecutiveKeepCycles, 1);
    assert.equal(result.lifecycle, 'active');
  });

  test('raises D only after consecutive cadence-triggered keep cycles', () => {
    const first = adaptCycleTriggerPolicy(catalog, record({ triggeredBy: ['cadence'] }), 'keep', 20);
    assert.equal(first.change.after.cadenceDays, 7);
    assert.equal(first.change.after.consecutiveCadenceKeepCycles, 1);

    const second = adaptCycleTriggerPolicy(
      catalog,
      record({ triggerPolicy: first.change.after, triggeredBy: ['cadence'] }),
      'keep',
      30,
    );
    assert.equal(second.change.after.cadenceDays, 14);
    assert.equal(second.change.after.consecutiveCadenceKeepCycles, 0);

    const interrupted = adaptCycleTriggerPolicy(
      catalog,
      record({ triggerPolicy: first.change.after, triggeredBy: ['cumulative'] }),
      'keep',
      30,
    );
    assert.equal(interrupted.change.after.cadenceDays, 7);
    assert.equal(interrupted.change.after.consecutiveCadenceKeepCycles, 0);

    const mixed = adaptCycleTriggerPolicy(
      catalog,
      record({ triggerPolicy: first.change.after, triggeredBy: ['cumulative', 'cadence'] }),
      'keep',
      30,
    );
    assert.equal(mixed.change.after.cadenceDays, 7);
    assert.equal(mixed.change.after.consecutiveCadenceKeepCycles, 0);
  });

  test('problem decisions lower N and D without crossing the factory floors', () => {
    const policy = {
      ...initialCycleTriggerPolicy(model),
      cumulativeThreshold: 300,
      cadenceDays: 14,
      consecutiveKeepCycles: 3,
      consecutiveCadenceKeepCycles: 1,
    };
    const lowered = adaptCycleTriggerPolicy(catalog, record({ triggerPolicy: policy }), 'evolve', 20);
    assert.deepEqual(lowered.change.after, initialCycleTriggerPolicy(model));
    assert.equal(lowered.lifecycle, 'active');

    const floor = adaptCycleTriggerPolicy(catalog, record(), 'rollback', 20);
    assert.deepEqual(floor.change.after, initialCycleTriggerPolicy(model));
  });

  test('dormant is reached only by evidenced keep convergence and reactivates on a problem', () => {
    const converged = adaptCycleTriggerPolicy(
      catalog,
      record({
        triggeredBy: ['cadence'],
        triggerPolicy: {
          ...initialCycleTriggerPolicy(model),
          cumulativeThreshold: 400,
          cadenceDays: 21,
          consecutiveKeepCycles: 3,
        },
      }),
      'keep',
      20,
    );
    assert.equal(converged.lifecycle, 'dormant');
    const active = adaptCycleTriggerPolicy(
      catalog,
      record({ triggerPolicy: converged.change.after, objectiveLifecycle: 'dormant' }),
      'rollback',
      30,
    );
    assert.equal(active.lifecycle, 'active');
  });
});
