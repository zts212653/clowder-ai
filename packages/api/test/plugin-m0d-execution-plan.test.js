import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadM0dExecutionPlan } from './plugin-m0d-execution-plan.js';
import { loadM0dBehaviorFixture } from './plugin-m0d-joint-runner.js';

const behaviorOracle = { kind: 'behavior-expectation' };

function fixture(...cases) {
  return { _meta: {}, cases };
}

function row(id, execution) {
  return { id, execution };
}

test('published protocol fixture supplies the complete signed execution plan', async () => {
  const published = await loadM0dBehaviorFixture();
  const plan = loadM0dExecutionPlan(published);

  assert.deepEqual(
    plan,
    published.cases.map(({ id, execution }) => ({ id, execution })),
  );
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(plan.map(({ execution }) => execution.plane))]
        .sort()
        .map((plane) => [plane, plan.filter(({ execution }) => execution.plane === plane).length]),
    ),
    {
      'host-control': 2,
      'host-to-plugin-delivery': 1,
      'plugin-to-host-wire': 7,
      'wire-admission': 2,
    },
  );
});

test('a generic complete ordered plan preserves contract-owned execution specs', () => {
  const published = fixture(
    row('alpha', { plane: 'host-control', verdictOracle: behaviorOracle }),
    row('beta', {
      plane: 'wire-admission',
      method: 'messaging.send',
      verdictOracle: { kind: 'json-rpc-error', code: -32602, sideEffects: 'behavior-expectation' },
    }),
  );

  const plan = loadM0dExecutionPlan(published, ['alpha', 'beta']);

  assert.deepEqual(plan, published.cases);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan[0].execution), true);
});

test('missing, duplicate, and reordered rows are rejected before execution', () => {
  const control = (id) => row(id, { plane: 'host-control', verdictOracle: behaviorOracle });
  assert.throws(() => loadM0dExecutionPlan(fixture(control('alpha')), ['alpha', 'beta']), /count/);
  assert.throws(
    () => loadM0dExecutionPlan(fixture(control('alpha'), control('alpha')), ['alpha', 'beta']),
    /duplicate case id alpha/,
  );
  assert.throws(
    () => loadM0dExecutionPlan(fixture(control('beta'), control('alpha')), ['alpha', 'beta']),
    /canonical order/,
  );
});

test('unknown planes and plane-incompatible oracles fail closed', () => {
  assert.throws(
    () =>
      loadM0dExecutionPlan(fixture(row('alpha', { plane: 'future-plane', verdictOracle: behaviorOracle })), ['alpha']),
    /unsupported execution plane/,
  );
  assert.throws(
    () =>
      loadM0dExecutionPlan(
        fixture(
          row('alpha', {
            plane: 'wire-admission',
            method: 'messaging.send',
            verdictOracle: behaviorOracle,
          }),
        ),
        ['alpha'],
      ),
    /invalid wire-admission oracle/,
  );
  assert.throws(
    () =>
      loadM0dExecutionPlan(
        fixture(row('alpha', { plane: 'host-control', method: 'invented.method', verdictOracle: behaviorOracle })),
        ['alpha'],
      ),
    /host-control method/,
  );
  assert.throws(
    () =>
      loadM0dExecutionPlan(
        fixture(row('alpha', { plane: 'host-control', verdictOracle: behaviorOracle, futureSemantic: true })),
        ['alpha'],
      ),
    /unsupported fields/,
  );
});
