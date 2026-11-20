import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNewApiSyncCalls } from './lib/api-sync-calls.mjs';

const route = 'packages/api/src/routes/example.ts';
const named = "import {execFileSync as run} from 'node:child_process';\n";

for (const [name, code] of [
  ['named alias', `${named}export function read(){run('git');}`],
  ['namespace member', "import * as cp from 'node:child_process'; export function read(){cp.spawnSync('git');}"],
  ['default import', "import cp from 'child_process'; export function read(){cp.execSync('git');}"],
  ['constant function alias', `${named}const other=run; export function read(){other('git');}`],
  ['literal computed member', "import * as cp from 'node:child_process'; cp['spawnSync']('git');"],
  ['CommonJS destructuring', "const {execSync:run}=require('node:child_process'); run('git');"],
  ['builtin module loader', "process.getBuiltinModule('node:child_process').execFileSync('git');"],
  ['literal dynamic import', "const cp=await import('node:child_process'); cp.execSync('git');"],
]) {
  test(`new direct synchronous subprocess call: ${name}`, () => {
    const findings = findNewApiSyncCalls(route, '', code);
    assert.equal(findings.length, 1);
    assert.ok(['execSync', 'execFileSync', 'spawnSync'].includes(findings[0].method));
    assert.ok(findings[0].line >= 1);
  });
}

test('a new call through the known synchronous process snapshot wrapper is rejected', () => {
  const code = "import {readUnixProcessSnapshotSync as read} from '../utils/cli-process-ownership.js'; read();";
  const findings = findNewApiSyncCalls('packages/api/src/routes/owners.ts', '', code);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].method, 'readUnixProcessSnapshotSync');
});

test('ordinary async subprocess APIs, unrelated Sync names and literal examples remain allowed', () => {
  const code = `import {execFile,spawn} from 'node:child_process';
    execFile('git',()=>{}); spawn('git'); function localSync(){} localSync();
    const example="cp.execSync('git')";`;
  assert.deepEqual(findNewApiSyncCalls(route, '', code), []);
});

test('a shadowed local identifier is not mistaken for the imported API', () => {
  const code = `${named}export function read(run:()=>void){run();}
    import * as cp from 'node:child_process';
    export function local(cp:{execSync:()=>void}){cp.execSync();}`;
  assert.deepEqual(findNewApiSyncCalls(route, '', code), []);
});

test('formatting existing debt is allowed, while adding or moving a call is rejected', () => {
  const before = `${named}export function cold(){run('git');}`;
  assert.deepEqual(findNewApiSyncCalls(route, before, `${named}\nexport function cold() { run('git'); }`), []);
  assert.equal(findNewApiSyncCalls(route, before, `${named}export function cold(){run('git');run('git');}`).length, 1);
  assert.equal(findNewApiSyncCalls(route, before, `${named}export function another(){run('git');}`).length, 1);
});

test('actual dedicated worker entries are explicit exceptions; a worker-like filename is not', () => {
  const code = `${named}run('git');`;
  assert.deepEqual(findNewApiSyncCalls('packages/api/src/config/codex-login-terminal-worker.ts', '', code), []);
  assert.equal(findNewApiSyncCalls('packages/api/src/routes/example-worker.ts', '', code).length, 1);
  assert.equal(
    findNewApiSyncCalls('packages/api/src/index.ts', '', code).length,
    1,
    'startup on the API loop is still guarded',
  );
});

test('the policy stays scoped to API production source', () => {
  for (const file of ['scripts/task.mjs', 'packages/api/test/fixture.js', 'packages/web/src/component.ts'])
    assert.deepEqual(findNewApiSyncCalls(file, '', `${named}run('git');`), []);
});

test('unparseable production input is reported instead of certifying a clean scan', () => {
  assert.throws(() => findNewApiSyncCalls(route, '', 'export function broken( {'), /parse/i);
});
