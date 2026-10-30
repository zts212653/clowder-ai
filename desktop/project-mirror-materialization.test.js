const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { PROJECT_MIRROR_PROBES, prepareProjectMirrors } = require('./project-mirrors');
const { waitForProjectMirrors } = require('./project-mirror-readiness');
const { runMaterialization } = require('./project-mirror-materialization');

const {
  fixture,
  rejectJunctionTraversal,
  appendWorkerFault,
  debris,
} = require('./project-mirror-materialization-fixture');

test('persistent parent and real Node junction failures recover complete physical resources without touching role data', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  rejectJunctionTraversal(t, value);
  const result = await waitForProjectMirrors(value).catch((error) => {
    t.diagnostic(value.logs.join('\n'));
    throw error;
  });
  assert.equal(result.recovery, 'materialized');
  for (const mirror of ['docs', 'cat-cafe-skills']) {
    assert.equal(fs.lstatSync(path.join(value.projectDir, mirror)).isSymbolicLink(), false);
    assert.equal(
      fs.readFileSync(path.join(value.projectDir, mirror, 'complete-resource.txt'), 'utf8'),
      'not only startup probes\n',
    );
  }
  assert.equal(fs.readFileSync(value.preserved, 'utf8'), 'protected roles and bindings\n');
  const diagnostics = value.logs.filter((line) => line.startsWith('Project mirror consumer diagnostic '));
  assert.ok(diagnostics.some((line) => line.includes('"status":"read_failed"')));
  assert.ok(diagnostics.some((line) => line.includes('"status":"ready"')));
  assert.deepEqual(debris(value), []);
});

test('materialized managed resources refresh on upgrade and preserve owner modifications instead of overwriting', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  rejectJunctionTraversal(t, value);
  await waitForProjectMirrors(value);
  const relative = PROJECT_MIRROR_PROBES[0].relativePath;
  fs.writeFileSync(path.join(value.installRoot, 'docs', relative), 'new release\n');
  prepareProjectMirrors(value);
  await waitForProjectMirrors(value);
  assert.equal(fs.readFileSync(path.join(value.projectDir, 'docs', relative), 'utf8'), 'new release\n');
  fs.writeFileSync(path.join(value.projectDir, 'docs', relative), 'owner modification\n');
  fs.writeFileSync(path.join(value.installRoot, 'docs', relative), 'next release\n');
  prepareProjectMirrors(value);
  await assert.rejects(waitForProjectMirrors(value), /modified|changed|conflict/i);
  assert.equal(fs.readFileSync(path.join(value.projectDir, 'docs', relative), 'utf8'), 'owner modification\n');
  assert.equal(fs.readFileSync(value.preserved, 'utf8'), 'protected roles and bindings\n');
});

test('a missing bundled source cannot authorize materialization or modify existing links', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  rejectJunctionTraversal(t, value);
  fs.unlinkSync(path.join(value.installRoot, 'docs', PROJECT_MIRROR_PROBES[0].relativePath));
  await assert.rejects(waitForProjectMirrors({ ...value, timeoutMs: 500 }), /parent source .*ENOENT/);
  assert.equal(fs.lstatSync(path.join(value.projectDir, 'docs')).isSymbolicLink(), true);
  assert.equal(
    value.logs.some((line) => line.startsWith('Project mirror materialization worker')),
    false,
  );
});

test('a reparse entry anywhere in the complete bundled resource tree refuses copying and keeps its target intact', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const external = path.join(value.root, 'owner');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'history.txt'), 'protected external data');
  fs.symlinkSync(
    external,
    path.join(value.installRoot, 'docs', 'nested-link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  rejectJunctionTraversal(t, value);
  await assert.rejects(waitForProjectMirrors(value), /contains a reparse entry/);
  assert.equal(fs.readFileSync(path.join(external, 'history.txt'), 'utf8'), 'protected external data');
  assert.equal(fs.lstatSync(path.join(value.projectDir, 'docs')).isSymbolicLink(), true);
  assert.deepEqual(debris(value), []);
});

test('publish failure restores the original link, cleans its owned stage and allows the next startup to retry', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  rejectJunctionTraversal(t, value);
  const gate = path.join(value.root, 'publish-failed-once');
  appendWorkerFault(
    value,
    `const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (from.endsWith('.stage') && !fs.existsSync(${JSON.stringify(gate)})) {
    fs.writeFileSync(${JSON.stringify(gate)}, 'injected once');
    throw Object.assign(new Error('injected publish permission failure'), { code: 'EACCES', syscall: 'rename' });
  }
  return rename.call(this, from, to);
};`,
  );
  await assert.rejects(waitForProjectMirrors(value), /publish permission failure/);
  assert.equal(fs.lstatSync(path.join(value.projectDir, 'docs')).isSymbolicLink(), true);
  assert.deepEqual(debris(value), []);
  assert.equal((await waitForProjectMirrors(value)).recovery, 'materialized');
});

test('concurrent replacement of a verified link with an owner directory is restored and never overwritten', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  rejectJunctionTraversal(t, value);
  const destination = path.join(value.projectDir, 'docs');
  appendWorkerFault(
    value,
    `const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (from === ${JSON.stringify(destination)} && to.endsWith('.previous')) {
    if (process.platform === 'win32') fs.rmdirSync(from); else fs.unlinkSync(from);
    fs.mkdirSync(from);
    fs.writeFileSync(require('node:path').join(from, 'owner-history.txt'), 'concurrent owner data');
  }
  return rename.call(this, from, to);
};`,
  );
  await assert.rejects(waitForProjectMirrors(value), /ownership|entry changed/);
  assert.equal(fs.readFileSync(path.join(destination, 'owner-history.txt'), 'utf8'), 'concurrent owner data');
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
  assert.deepEqual(debris(value), []);
});

test('cancellation closes the owned copy worker; the recorded partial stage is safely recovered on retry', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  rejectJunctionTraversal(t, value);
  const gate = path.join(value.root, 'copy-started-once');
  appendWorkerFault(
    value,
    `const write = fs.writeFileSync;
fs.writeFileSync = function(file, ...args) {
  const result = write.call(this, file, ...args);
  if (String(file).includes('.stage') && String(file).endsWith('complete-resource.txt') && !fs.existsSync(${JSON.stringify(gate)})) {
    write.call(this, ${JSON.stringify(gate)}, 'copy is active');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  }
  return result;
};`,
  );
  const controller = new AbortController();
  const reason = new Error('controlled materialization cancellation');
  let pid;
  const running = runMaterialization({
    ...value,
    mirrors: ['docs'],
    allowLink: true,
    signal: controller.signal,
    log: (line) => {
      pid = Number(line.match(/pid=(\d+)/)?.[1]);
    },
  });
  const rejected = assert.rejects(running, (error) => error === reason);
  const until = Date.now() + 5000;
  while (!fs.existsSync(gate) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(gate), true, 'a real worker must enter the copy before cancellation');
  controller.abort(reason);
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(debris(value).length > 0, 'interrupted transaction is owned and discoverable');
  assert.equal((await waitForProjectMirrors(value)).recovery, 'materialized');
  assert.deepEqual(debris(value), []);
});

test('a user file added to an old materialized backup prevents cleanup and remains readable across retry', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  rejectJunctionTraversal(t, value);
  await waitForProjectMirrors(value);
  fs.writeFileSync(path.join(value.installRoot, 'docs', 'complete-resource.txt'), 'new version\n');
  appendWorkerFault(
    value,
    `const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = rename.call(this, from, to);
  if (from.endsWith('.stage')) {
    const parent = require('node:path').dirname(to);
    for (const name of fs.readdirSync(parent).filter(name => name.endsWith('.previous'))) {
      fs.writeFileSync(require('node:path').join(parent, name, 'owner-added.txt'), 'do not remove');
    }
  }
  return result;
};`,
  );
  await assert.rejects(waitForProjectMirrors(value), /modified|changed|conflict/);
  const backup = fs.readdirSync(value.projectDir).find((name) => name.endsWith('.previous'));
  assert.equal(fs.readFileSync(path.join(value.projectDir, backup, 'owner-added.txt'), 'utf8'), 'do not remove');
  await assert.rejects(waitForProjectMirrors(value), /modified|changed|conflict/);
  assert.equal(fs.readFileSync(path.join(value.projectDir, backup, 'owner-added.txt'), 'utf8'), 'do not remove');
});

test('an interrupted partial stage containing a new owner file is preserved without accumulating more stages', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const { runRequest } = require('./project-mirror-materialization-worker');
  const original = fs.writeFileSync;
  let stopOnce = true;
  t.mock.method(fs, 'writeFileSync', function (filename, ...args) {
    if (stopOnce && String(filename).includes('.stage') && String(filename).endsWith('complete-resource.txt')) {
      stopOnce = false;
      original.call(this, path.join(path.dirname(filename), 'owner-added.txt'), 'owner stage data');
      throw Object.assign(new Error('controlled copy failure'), { code: 'ENOSPC' });
    }
    return original.call(this, filename, ...args);
  });
  assert.throws(() => runRequest({ ...value, mirrors: ['docs'], allowLink: true }), /ENOSPC|copy failure/);
  const before = debris(value);
  const stage = before.find((name) => name.endsWith('.stage'));
  assert.equal(fs.readFileSync(path.join(value.projectDir, stage, 'owner-added.txt'), 'utf8'), 'owner stage data');
  assert.throws(() => runRequest({ ...value, mirrors: ['docs'], allowLink: true }), /unknown owner files/);
  assert.deepEqual(debris(value), before);
  assert.equal(fs.readFileSync(path.join(value.projectDir, stage, 'owner-added.txt'), 'utf8'), 'owner stage data');
});

test('the service startup entry consumes restored docs and skills before starting downstream services', async (t) => {
  const value = fixture(t);
  const keys = ['LOCALAPPDATA', 'CAT_CAFE_DESKTOP_INSTANCE_ROOT'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.LOCALAPPDATA = path.join(value.root, 'logger-home');
  delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const ServiceManager = require('./service-manager');
  fs.mkdirSync(path.join(value.installRoot, 'packages/api/dist'), { recursive: true });
  fs.mkdirSync(path.join(value.installRoot, 'packages/api/node_modules'));
  fs.writeFileSync(path.join(value.installRoot, 'packages/api/dist/index.js'), 'test API entry; not executed');
  const node = path.join(value.installRoot, process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  try {
    fs.linkSync(process.execPath, node);
  } catch {
    fs.copyFileSync(process.execPath, node);
  }
  rejectJunctionTraversal(t, value);
  const manager = new ServiceManager(value.installRoot, { frontendPort: 5481, apiPort: 5482, redisPort: 6478 });
  const started = [];
  manager._getUserDataDir = () => path.dirname(value.projectDir);
  manager._isPortOpen = async () => false;
  manager._startRedis = async () => started.push('redis');
  manager._startApi = async (selectedNode) => {
    assert.equal(selectedNode, node);
    for (const entry of PROJECT_MIRROR_PROBES) {
      assert.equal(
        fs.readFileSync(path.join(value.projectDir, entry.mirror, entry.relativePath), 'utf8'),
        `bundled ${entry.relativePath}\n`,
      );
    }
    started.push('api-resources-read');
  };
  manager._startNextJs = () => started.push('web');
  manager._waitForHttpReady = async () => {};
  await manager.startAll();
  assert.deepEqual(started.sort(), ['api-resources-read', 'redis', 'web']);
  assert.equal(fs.readFileSync(value.preserved, 'utf8'), 'protected roles and bindings\n');
});

test('restart does not create a new link over an interrupted publish before restoring the recorded original entry', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  rejectJunctionTraversal(t, value);
  const destination = path.join(value.projectDir, 'docs');
  const gate = path.join(value.root, 'publish-window-once');
  appendWorkerFault(
    value,
    `const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = rename.call(this, from, to);
  if (from === ${JSON.stringify(destination)} && to.endsWith('.previous') && !fs.existsSync(${JSON.stringify(gate)})) {
    fs.writeFileSync(${JSON.stringify(gate)}, 'old entry is now backup');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  }
  return result;
};`,
  );
  const controller = new AbortController();
  const running = runMaterialization({ ...value, mirrors: ['docs'], allowLink: true, signal: controller.signal });
  const rejected = assert.rejects(running, /controlled publish window cancellation/);
  const until = Date.now() + 5000;
  while (!fs.existsSync(gate) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(gate), true);
  controller.abort(new Error('controlled publish window cancellation'));
  await rejected;
  assert.equal(fs.existsSync(destination), false);
  prepareProjectMirrors(value);
  assert.equal(fs.existsSync(destination), false, 'preparation must defer to the interrupted transaction');
  assert.equal((await waitForProjectMirrors(value)).recovery, 'materialized');
  assert.deepEqual(debris(value), []);
  assert.equal(fs.readFileSync(value.preserved, 'utf8'), 'protected roles and bindings\n');
});
