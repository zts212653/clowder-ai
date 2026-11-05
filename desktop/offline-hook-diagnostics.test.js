const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const helper = path.join(__dirname, 'scripts/sync-agent-hooks-offline.mjs');
function setup(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-hook-private-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'packages/api/dist/agent-hooks/index.js');
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(modulePath, body);
  return root;
}
function run(root, script = helper) {
  return spawnSync(
    process.execPath,
    [script, '--project-root', root, '--target-root', path.join(root, 'private-home')],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    },
  );
}
function records(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[agent-hook-install] '))
    .map((line) => JSON.parse(line.slice('[agent-hook-install] '.length)));
}
test('offline helper persists sanitized import and sync phase CPU and duration', (t) => {
  const root = setup(t, 'export async function syncAgentHooks() { return {status:"configured"}; }');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const events = records(result.stdout);
  for (const phase of ['module-import', 'hook-sync']) {
    assert.deepEqual(
      events.filter((event) => event.phase === phase).map((event) => event.state),
      ['started', 'completed'],
    );
  }
  assert.ok(events.every((event) => Number.isFinite(event.durationMs) && Number.isFinite(event.userCpuMs)));
  assert.ok(events.every((event) => !Object.values(event).includes(root)));
  assert.equal(
    fs.readFileSync(path.join(root, '.installer-logs/agent-hooks.log'), 'utf8').trim(),
    result.stdout.trim(),
  );
});
test('offline installer prefers its built hook entry and never hides a broken bundle', (t) => {
  const root = setup(t, 'throw new Error("development entry must remain unused");');
  const bundled = path.join(root, 'packages/api/dist/agent-hooks/index.desktop.js');
  fs.writeFileSync(bundled, 'export async function syncAgentHooks(){return {status:"configured"};}');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(records(result.stdout).some((event) => event.healthStatus === 'configured'));
  fs.writeFileSync(bundled, 'throw new Error("bundled-entry-secret");');
  fs.writeFileSync(
    path.join(path.dirname(bundled), 'index.js'),
    'export async function syncAgentHooks(){return {status:"configured"};}',
  );
  const failed = run(root);
  assert.equal(failed.status, 1);
  assert.ok(records(failed.stdout).some((event) => event.phase === 'module-import' && event.state === 'failed'));
  assert.doesNotMatch(failed.stdout + failed.stderr, /bundled-entry-secret/);
});
test('offline helper logs failed import/sync without raw paths, credentials or thrown messages', (t) => {
  const root = setup(t, 'export async function syncAgentHooks() { throw new Error("secret-api-key /private/HOME"); }');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.ok(records(result.stdout).some((event) => event.phase === 'hook-sync' && event.state === 'failed'));
  assert.doesNotMatch(result.stdout + result.stderr, /secret-api-key|private\/HOME|offline-hook-private-/);
  fs.rmSync(path.join(root, 'packages/api/dist/agent-hooks/index.js'));
  const missing = run(root);
  assert.equal(missing.status, 1);
  assert.ok(records(missing.stdout).some((event) => event.phase === 'module-import' && event.state === 'failed'));
  assert.doesNotMatch(missing.stdout + missing.stderr, /offline-hook-private-/);
});
test('installation diagnostics survive an unwritable application log directory in the owned profile', (t) => {
  const root = setup(t, 'export async function syncAgentHooks() { return {status:"configured"}; }');
  fs.writeFileSync(path.join(root, '.installer-logs'), 'fixture blocks application log directory');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const log = path.join(root, 'private-home/.cat-cafe/installer-logs/agent-hooks.log');
  assert.equal(fs.readFileSync(log, 'utf8').trim(), result.stdout.trim());
  assert.doesNotMatch(result.stdout + result.stderr, /offline-hook-private-/);
});
test('real offline hook writes and settings merge never emit HOME paths', (t) => {
  const actual = pathToFileURL(path.join(__dirname, '../packages/api/dist/agent-hooks/index.js')).href;
  const root = setup(t, `export { syncAgentHooks } from ${JSON.stringify(actual)};`);
  const hooks = path.join(root, '.claude/hooks/user-level');
  fs.mkdirSync(hooks, { recursive: true });
  for (const name of ['session-start-recall.sh', 'session-stop-check.sh'])
    fs.writeFileSync(path.join(hooks, name), '#!/bin/bash\necho fixture\n');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    records(result.stdout).some((event) => event.phase === 'claude-settings-merge' && event.state === 'completed'),
  );
  assert.doesNotMatch(result.stdout + result.stderr, /offline-hook-private-/);
});
test(
  'PowerShell phase diagnostics persist resolving and child exit without raw child output',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = setup(t, 'export async function syncAgentHooks() { return {status:"configured"}; }');
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, '.installer-logs'), 'fixture blocks application log directory');
    fs.writeFileSync(
      path.join(root, 'scripts/sync-agent-hooks-offline.mjs'),
      'console.error("secret-api-key /private/HOME"); process.exit(1);',
    );
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'scripts/post-install-offline.ps1'),
        '-AppDir',
        root,
        '-AgentHooksOnly',
        '-UserProfileRoot',
        path.join(root, 'home'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const events = records(result.stdout);
    for (const phase of ['resolve-helper', 'resolve-node', 'resolve-profile']) {
      assert.deepEqual(
        events.filter((event) => event.phase === phase).map((event) => event.state),
        ['started', 'completed'],
      );
    }
    assert.deepEqual(
      events.filter((event) => event.phase === 'node-sync').map((event) => event.state),
      ['started', 'failed'],
    );
    assert.doesNotMatch(result.stdout + result.stderr, /secret-api-key|private\/HOME|offline-hook-private-/);
    const persisted = records(
      fs.readFileSync(path.join(root, 'home/.cat-cafe/installer-logs/agent-hooks.log'), 'utf8'),
    );
    assert.deepEqual(persisted, events);
    assert.ok(events.every((event) => Number.isFinite(event.durationMs) && Number.isFinite(event.processCpuMs)));
  },
);
test(
  'PowerShell forwards only rebuilt safe Node phases when both log roots are blocked',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = setup(t, 'export async function syncAgentHooks() { return {status:"configured"}; }');
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'home'));
    fs.writeFileSync(path.join(root, '.installer-logs'), 'blocked');
    fs.writeFileSync(path.join(root, 'home/.cat-cafe'), 'blocked');
    const safe = {
      version: 1,
      component: 'node',
      pid: 123,
      phase: 'module-import',
      state: 'started',
      elapsedMs: 1,
      durationMs: 0,
      userCpuMs: 0,
      systemCpuMs: 0,
    };
    const lines = [
      JSON.stringify({ ...safe, rawError: 'never-forward-this-secret' }),
      JSON.stringify({ ...safe, phase: 'never-forward-this-secret' }),
      JSON.stringify({ ...safe, userCpuMs: 'never-forward-this-secret' }),
    ];
    fs.writeFileSync(
      path.join(root, 'scripts/sync-agent-hooks-offline.mjs'),
      lines.map((line) => `console.log(${JSON.stringify(`[agent-hook-install] ${line}`)});`).join('\n') +
        '\nconsole.error("never-forward-this-secret");',
    );
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'scripts/post-install-offline.ps1'),
        '-AppDir',
        root,
        '-AgentHooksOnly',
        '-UserProfileRoot',
        path.join(root, 'home'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const node = records(result.stdout).filter((event) => event.component === 'node');
    assert.deepEqual(node, [safe]);
    assert.doesNotMatch(result.stdout + result.stderr, /never-forward-this-secret|offline-hook-private-/);
  },
);
