import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { readonlyCommandPlan, readonlyEnvironment } from '../dist/infrastructure/managed-readonly-plan.js';

test('readonly plan fixes argv, cwd, network, environment and bounded resources', () => {
  const command = 'python3 -c "print(1)"';
  const plan = readonlyCommandPlan(command, tmpdir(), '/tmp/owned-readonly-home', 2000, 'owned-native-process');
  assert.deepEqual(plan.command, ['/bin/bash', '--noprofile', '--norc', '-c', command]);
  assert.deepEqual(plan.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(plan.timeoutMs, 2000);
  assert.equal(plan.outputBytesCap, 65536);
  assert.equal(Object.isFrozen(plan.command), true);
  assert.equal(Object.isFrozen(plan.env), true);
  assert.deepEqual(Object.keys(readonlyEnvironment('/tmp/home', '/tmp/cwd')).sort(), [
    'CODEX_HOME',
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'PWD',
    'TMPDIR',
  ]);
});

test('caller cannot choose a relative cwd or unbounded native timeout', () => {
  assert.throws(() => readonlyCommandPlan('pwd', '.', '/tmp/home', 2000, 'x'), /absolute/);
  for (const timeout of [0, 999, 60001, Infinity, NaN])
    assert.throws(() => readonlyCommandPlan('pwd', tmpdir(), '/tmp/home', timeout, 'x'), /timeout_out_of_bounds/);
});
