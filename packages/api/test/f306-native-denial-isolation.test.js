import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cases = [
  [
    'Node guard tests',
    process.execPath,
    ['--test', '--test-reporter=tap', join(root, 'packages/api/test/f306-native-guard-slimming.test.js')],
  ],
  ['Bash gate hook tests', 'bash', [join(root, 'test/hooks/gate-background-guard.test.sh')]],
];

for (const [name, program, args] of cases) {
  test(
    `${name} preserve the caller HOME ledger byte-for-byte`,
    {
      skip: !existsSync(args.at(-1)) && 'private hook tests are not exported',
      timeout: 60000,
    },
    (t) => {
      // The outer HOME models a real user's home. Even the RED must never write
      // the actual developer's ledger; each tested hook runner must isolate again.
      const callerHome = mkdtempSync(join(tmpdir(), 'f306-hook-caller-home-'));
      t.after(() => rmSync(callerHome, { recursive: true, force: true }));
      const ledger = join(callerHome, '.cat-cafe/guard-denials/native.jsonl');
      mkdirSync(dirname(ledger), { recursive: true });
      const before = '{"callerSentinel":true}\n';
      writeFileSync(ledger, before);
      const env = { ...process.env, HOME: callerHome };
      // A nested test runner must start normally, rather than inherit Node's
      // internal child-runner mode and exit without executing its test file.
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(program, args, {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 55000,
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, program === process.execPath ? /# tests [1-9]\d*/ : /PASS:/);
      assert.ok(readFileSync(ledger, 'utf8') === before, 'hook tests appended denials to their caller HOME');
    },
  );
}
