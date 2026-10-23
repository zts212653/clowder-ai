const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { prepareProjectMirrors, PROJECT_MIRROR_PROBES } = require('./project-mirrors');
const { waitForProjectMirrors } = require('./project-mirror-readiness');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'Clowder AI source 内网');
  const projectDir = path.join(root, 'user project 测试');
  const logs = [];
  const options = {
    installRoot,
    projectDir,
    log: (message) => logs.push(message),
    nodeExe: process.execPath,
    timeoutMs: 1000,
  };
  for (const { mirror, relativePath } of PROJECT_MIRROR_PROBES) {
    const file = path.join(installRoot, mirror, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `source ${relativePath}\n`);
  }
  return { ...options, logs, options, root };
}

function parentReadFailure(t, paths, { once = false, code = 'UNKNOWN' } = {}) {
  const original = fs.readFileSync;
  const counts = new Map();
  t.mock.method(fs, 'readFileSync', function readWithFailure(file, ...args) {
    if (paths.includes(file)) {
      const count = counts.get(file) ?? 0;
      counts.set(file, count + 1);
      if (!once || !count)
        throw Object.assign(new Error(`${code}: injected parent reader failure`), {
          code,
          errno: -4094,
          syscall: 'open',
        });
    }
    return original.call(this, file, ...args);
  });
  return counts;
}

test('healthy real junctions pass without requiring a consumer executable or loose plugin', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  assert.equal(fs.existsSync(path.join(value.installRoot, 'plugins')), false);
  const result = await waitForProjectMirrors({ ...value, nodeExe: path.join(value.root, 'absent.exe') });
  assert.equal(result.verification, 'parent');
  assert.ok(fs.readlinkSync(path.join(value.projectDir, 'docs')));
});

test('transient docs and skills traversal failures recover after bounded retry', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const probes = PROJECT_MIRROR_PROBES.slice(0, 2).map(({ mirror, relativePath }) =>
    path.join(value.projectDir, mirror, relativePath),
  );
  const counts = parentReadFailure(t, probes, { once: true });
  const result = await waitForProjectMirrors({ ...value, nodeExe: path.join(value.root, 'must-not-spawn.exe') });
  assert.equal(result.verification, 'parent');
  assert.ok(probes.every((file) => counts.get(file) >= 2));
});

test('a real new Node reads every source and mirror while parent docs and skills remain UNKNOWN', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const probes = PROJECT_MIRROR_PROBES.map(({ mirror, relativePath }) =>
    path.join(value.projectDir, mirror, relativePath),
  );
  const counts = parentReadFailure(t, probes);
  const result = await waitForProjectMirrors(value);
  assert.equal(result.verification, 'consumer');
  assert.ok(probes.every((file) => counts.get(file) >= 2));
  assert.match(value.logs.join('\n'), /bundled Node consumer/);
});

test('stale junctions are replaced without changing the old target or its custom file', (t) => {
  const value = fixture(t);
  const oldDocs = path.join(value.root, 'old docs');
  fs.mkdirSync(oldDocs);
  fs.writeFileSync(path.join(oldDocs, 'custom-history.txt'), 'protected owner data');
  fs.mkdirSync(value.projectDir);
  fs.symlinkSync(oldDocs, path.join(value.projectDir, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  prepareProjectMirrors(value);
  assert.equal(
    fs.realpathSync(path.join(value.projectDir, 'docs')),
    fs.realpathSync(path.join(value.installRoot, 'docs')),
  );
  assert.equal(fs.readFileSync(path.join(oldDocs, 'custom-history.txt'), 'utf8'), 'protected owner data');
});

test('broken junctions are repaired even when existsSync follows an absent old target', (t) => {
  const value = fixture(t);
  fs.mkdirSync(value.projectDir);
  const destination = path.join(value.projectDir, 'docs');
  fs.symlinkSync(path.join(value.root, 'gone'), destination, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.existsSync(destination), false);
  prepareProjectMirrors(value);
  assert.equal(fs.realpathSync(destination), fs.realpathSync(path.join(value.installRoot, 'docs')));
});

test('real directories and custom files are preserved and cannot be silently passed as recovered', async (t) => {
  const value = fixture(t);
  const custom = path.join(value.projectDir, 'docs/custom.txt');
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  fs.writeFileSync(custom, 'keep');
  prepareProjectMirrors({ ...value, rebuildMirrors: ['docs'] });
  await assert.rejects(waitForProjectMirrors({ ...value, timeoutMs: 350 }), (error) => {
    assert.match(error.message, /mirror .*eval-design-gate.yaml.*code=ENOENT/);
    return true;
  });
  assert.equal(fs.lstatSync(path.dirname(custom)).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(custom, 'utf8'), 'keep');
});

test('missing source remains a failure with source and mirror paths and raw error fields', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const { mirror, relativePath } = PROJECT_MIRROR_PROBES[0];
  fs.unlinkSync(path.join(value.installRoot, mirror, relativePath));
  const start = Date.now();
  await assert.rejects(waitForProjectMirrors({ ...value, timeoutMs: 80 }), (error) => {
    assert.match(error.message, /source .*eval-design-gate.yaml.*code=ENOENT errno=.*syscall=open/);
    assert.match(error.message, /mirror .*eval-design-gate.yaml.*code=ENOENT/);
    return true;
  });
  assert.ok(Date.now() - start < 1000, 'failure must respect its bounded deadline');
});

test('a parent-only UNKNOWN on source and mirror can be verified by the real consumer', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const { mirror, relativePath } = PROJECT_MIRROR_PROBES[0];
  parentReadFailure(t, [
    path.join(value.projectDir, mirror, relativePath),
    path.join(value.installRoot, mirror, relativePath),
  ]);
  assert.equal((await waitForProjectMirrors(value)).verification, 'consumer');
  assert.ok(value.logs.some((message) => message.includes('source failures=1')));
});

test('source error fields remain visible when the consumer cannot verify before the deadline', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const { mirror, relativePath } = PROJECT_MIRROR_PROBES[0];
  const source = path.join(value.installRoot, mirror, relativePath);
  fs.unlinkSync(source);
  parentReadFailure(t, [path.join(value.projectDir, mirror, relativePath), source], { code: 'EPERM' });
  await assert.rejects(waitForProjectMirrors({ ...value, timeoutMs: 350 }), (error) => {
    assert.match(error.message, /parent source .*code=EPERM errno=-4094 syscall=open/);
    assert.match(error.message, /parent mirror .*code=EPERM errno=-4094 syscall=open/);
    // Under parallel CI load, this short whole-readiness budget may expire
    // before a fresh Node responds. Either outcome must still reject startup.
    assert.match(error.message, /consumer (?:source [^\n]*code=ENOENT|[^\n]*code=ETIMEDOUT)/);
    return true;
  });
});

test('an already aborted readiness request never starts recovery', async (t) => {
  const value = fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('controlled cancellation'));
  await assert.rejects(waitForProjectMirrors({ ...value, signal: controller.signal }), /controlled cancellation/);
  assert.equal(value.logs.length, 0);
});
