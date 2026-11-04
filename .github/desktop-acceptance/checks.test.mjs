import assert from 'node:assert/strict';
import test from 'node:test';
import { assertChecksPassed, collectChecks } from './checks.mjs';

test('a failed installer does not hide the independently isolated portable result', async () => {
  const calls = [];
  const failure = new Error('installer plugin activation failed');
  const result = await collectChecks(['installer', 'portable'], async (name) => {
    calls.push(name);
    if (name === 'installer') throw failure;
  });
  assert.deepEqual(calls, ['installer', 'portable']);
  assert.deepEqual(
    result.checks.map(({ name, status }) => ({ name, status })),
    [
      { name: 'installer', status: 'failed' },
      { name: 'portable', status: 'passed' },
    ],
  );
  assert.throws(
    () => assertChecksPassed(result),
    (error) => error.errors[0] === failure,
  );
});

test('uncertain cleanup prevents a second execution and cannot pass the aggregate', async () => {
  const calls = [];
  const result = await collectChecks(
    ['installer', 'portable'],
    async (name) => {
      calls.push(name);
    },
    { canContinue: async () => false },
  );
  assert.deepEqual(calls, ['installer']);
  assert.equal(result.checks[0].cleanup, 'unconfirmed');
  assert.equal(result.checks[1].status, 'not_run');
  assert.equal(result.status, 'failed');
  assert.throws(() => assertChecksPassed(result));
});

test('applied state, a failed plugin and independently visible UI retain separate outcomes', async () => {
  const snapshots = [];
  const result = await collectChecks(
    ['state-write', 'plugins', 'profile-ui'],
    async (name) => {
      if (name === 'plugins') throw new Error('default failed');
    },
    { observe: (checks) => snapshots.push(structuredClone(checks)) },
  );
  assert.deepEqual(
    result.checks.map((check) => check.status),
    ['passed', 'failed', 'passed'],
  );
  assert.equal(
    snapshots[0].every((check) => check.status === 'not_run'),
    true,
  );
  assert.throws(() => assertChecksPassed(result));
});

test('a genuinely missing prerequisite is recorded as untested rather than passed', async () => {
  const result = await collectChecks(['restore'], async () => ({ status: 'not_run', reason: 'no-admitted-state' }));
  assert.equal(result.checks[0].status, 'not_run');
  assert.equal(result.status, 'failed');
});

test('all completed independent checks are required for an aggregate pass', async () => {
  const result = await collectChecks(['installer', 'portable'], async () => {});
  assert.equal(result.status, 'passed');
  assert.doesNotThrow(() => assertChecksPassed(result));
});

test('invalid returned outcomes and throwing cleanup observers cannot become passes', async () => {
  const invalid = await collectChecks(['first'], async () => ({ status: 'failed' }));
  assert.equal(invalid.status, 'failed');
  const uncertain = await collectChecks(['first', 'second'], async () => {}, {
    canContinue: async () => {
      throw new Error('probe failed');
    },
  });
  assert.equal(uncertain.checks[0].status, 'failed');
  assert.equal(uncertain.checks[1].status, 'not_run');
});
