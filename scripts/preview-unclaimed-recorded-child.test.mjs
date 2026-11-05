import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseAlphaLaunchChild } from './lib/alpha-launch-contract.mjs';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { unclaimed } from './lib/preview-unclaimed-test-fixture.mjs';
import { decideNativeHookPayload } from './native-effect-target-guard.mjs';

function direct(t) {
  const f = unclaimed(t);
  f.record.command = [
    '/usr/bin/env',
    'PATH=/history-only-never-execute',
    'CAT_CAFE_CAT_ID=fixture-owner',
    './scripts/alpha-worktree.sh',
    'start',
    '--instance',
    'f290-communication',
    '--ports',
    '5311,5312,5411,15397',
    '--allow-empty-redis',
  ];
  f.write(f.config.recordPath, f.record);
  f.completion = { ...f.completion, exitCode: 1, commandExitCode: 1, runnerExitCode: 1 };
  f.write(f.record.completionPath, f.completion);
  const previous = process.env.CAT_CAFE_PREVIEW_PROCESS_DIR;
  process.env.CAT_CAFE_PREVIEW_PROCESS_DIR = f.config.stateDir;
  t.after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_PREVIEW_PROCESS_DIR;
    else process.env.CAT_CAFE_PREVIEW_PROCESS_DIR = previous;
  });
  return f;
}

function policy(f, action) {
  return decideNativeHookPayload(
    {
      tool_name: 'exec_command',
      cwd: f.mainRoot,
      tool_input: {
        cmd: `pnpm --dir ${f.mainRoot} preview:process ${action} --port ${f.config.port} --cwd ${f.mainRoot} --json`,
      },
    },
    { selfHost: () => ({ confidence: 'none' }) },
  );
}

test('legacy direct official Alpha configuration retires only its failed registration without executing recorded env', async (t) => {
  const f = direct(t),
    oldPath = process.env.PATH;
  const originals = [f.record.completionPath, f.dumpFile].map((p) => readFileSync(p));
  assert.equal(policy(f, 'stop').target.value, `preview://alpha${f.mainRoot}:${f.config.port}`);
  const result = await stop(f);
  assert.equal(result.settlement.status, 'registration_retired');
  assert.equal(result.settlement.businessExitCode, 1);
  assert.equal(result.settlement.commandGroupStatus, 'unverified');
  assert.equal(result.settlement.cleanupExitCode, null);
  assert.equal(process.env.PATH, oldPath);
  assert.deepEqual(
    [f.record.completionPath, f.dumpFile].map((p) => readFileSync(p)),
    originals,
  );
  for (const action of ['status', 'stop']) {
    const verdict = policy(f, action);
    assert.equal(verdict.target.value, `preview://alpha${f.mainRoot}:${f.config.port}`);
  }
  // Historical argv data does not create a new executable/start qualification.
  assert.throws(() => parseAlphaLaunchChild(f.record.command, f.mainRoot));
});

for (const invalid of [
  'foreign script',
  'env chdir',
  'interpreter',
  'arbitrary child',
  'protected tuple',
  'claimed cleanup',
])
  test(`legacy retirement rejects ${invalid}`, async (t) => {
    const f = direct(t);
    if (invalid === 'foreign script') f.record.command[3] = '../cat-cafe-runtime/scripts/alpha-worktree.sh';
    if (invalid === 'env chdir') f.record.command.splice(1, 0, '-C', '/tmp');
    if (invalid === 'interpreter')
      f.record.command = ['bash', '-c', './scripts/alpha-worktree.sh start --instance f290-communication'];
    if (invalid === 'arbitrary child') f.record.command[3] = './scripts/start-dev.sh';
    if (invalid === 'protected tuple')
      f.record.command = f.record.command.map((x) => (x === '5311,5312,5411,15397' ? '5311,5312,5411,6399' : x));
    if (invalid === 'claimed cleanup')
      f.write(f.record.completionPath, { ...f.completion, cleanupOwnerStatus: 'complete', cleanupExitCode: 0 });
    f.write(f.config.recordPath, f.record);
    await assert.rejects(stop(f));
    assert.deepEqual(JSON.parse(readFileSync(f.config.recordPath)), f.record);
    assert.notEqual(policy(f, 'stop').target.value, `preview://alpha${f.mainRoot}:${f.config.port}`);
  });
