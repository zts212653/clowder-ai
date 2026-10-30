const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { prepareProjectMirrors } = require('./project-mirrors');
const { waitForProjectMirrors } = require('./project-mirror-readiness');
const { runMaterialization } = require('./project-mirror-materialization');
const { fixture } = require('./project-mirror-materialization-fixture');

function physicalFixture(t) {
  const value = { ...fixture(t), platform: 'win32' };
  for (const relative of ['assets/prompt-templates/extra.md', 'guides/catalog.yaml']) {
    const source = path.join(value.installRoot, relative);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, relative);
  }
  prepareProjectMirrors(value);
  return value;
}

test('Windows proactively materializes all four complete resource roots without a failed probe', async (t) => {
  const value = physicalFixture(t);
  await waitForProjectMirrors(value);
  for (const mirror of ['docs', 'cat-cafe-skills', 'assets', 'guides']) {
    assert.equal(fs.lstatSync(path.join(value.projectDir, mirror)).isSymbolicLink(), false, mirror);
  }
  assert.equal(
    fs.readFileSync(path.join(value.projectDir, 'assets/prompt-templates/extra.md'), 'utf8'),
    'assets/prompt-templates/extra.md',
  );
  assert.equal(fs.readFileSync(value.preserved, 'utf8'), 'protected roles and bindings\n');
});

test('a top-level bundled source junction is rejected even when source and mirror probes are readable', async (t) => {
  const value = physicalFixture(t);
  const source = path.join(value.installRoot, 'docs');
  const target = path.join(value.installRoot, 'private-docs-target');
  fs.renameSync(source, target);
  fs.symlinkSync(target, source, process.platform === 'win32' ? 'junction' : 'dir');
  const file = path.join(target, 'complete-resource.txt');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(fs.readFileSync(path.join(value.projectDir, 'docs/complete-resource.txt'), 'utf8'), before);
  await assert.rejects(waitForProjectMirrors(value), /source contains a reparse entry/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readlinkSync(path.join(value.projectDir, 'docs')), source);
  assert.equal(fs.readFileSync(value.preserved, 'utf8'), 'protected roles and bindings\n');
});

test('user evaluation output permits restart and defers source upgrade without replacing either file', async (t) => {
  const value = physicalFixture(t);
  await waitForProjectMirrors(value);
  const output = path.join(value.projectDir, 'docs/harness-feedback/verdicts/my-result.md');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, 'protected evaluation output');
  await waitForProjectMirrors(value);
  fs.writeFileSync(path.join(value.installRoot, 'docs/complete-resource.txt'), 'new bundle');
  await waitForProjectMirrors(value);
  assert.equal(fs.readFileSync(output, 'utf8'), 'protected evaluation output');
  assert.equal(
    fs.readFileSync(path.join(value.projectDir, 'docs/complete-resource.txt'), 'utf8'),
    'not only startup probes\n',
  );
  assert.ok(value.logs.some((line) => line.includes('refresh deferred')));
});

test('an owner-added link remains rejected without following or modifying its target', async (t) => {
  const value = physicalFixture(t);
  await waitForProjectMirrors(value);
  const target = path.join(value.root, 'owner-private');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'history'), 'protected');
  fs.symlinkSync(
    target,
    path.join(value.projectDir, 'docs/owner-link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(waitForProjectMirrors(value), /reparse/);
  assert.equal(fs.readFileSync(path.join(target, 'history'), 'utf8'), 'protected');
});

test('partially failed static-backup cleanup cannot poison a subsequent refresh', async (t) => {
  const value = physicalFixture(t);
  await waitForProjectMirrors(value);
  fs.writeFileSync(path.join(value.installRoot, 'docs/complete-resource.txt'), 'new bundle');
  const { runRequest } = require('./project-mirror-materialization-worker');
  const unlink = fs.unlinkSync;
  let failed = false;
  t.mock.method(fs, 'unlinkSync', (file) => {
    if (!failed && String(file).includes('.previous') && String(file).endsWith('complete-resource.txt')) {
      failed = true;
      unlink(file);
      throw Object.assign(new Error('controlled partial static cleanup'), { code: 'EPERM' });
    }
    return unlink(file);
  });
  assert.doesNotThrow(() => runRequest({ ...value, mirrors: ['docs'] }));
  assert.equal(failed, true);
  await runMaterialization({ ...value, mirrors: ['docs'] });
  assert.equal(fs.readFileSync(path.join(value.projectDir, 'docs/complete-resource.txt'), 'utf8'), 'new bundle');
});

test('a user file added after retiring a backup survives cleanup and the next startup', async (t) => {
  const value = physicalFixture(t);
  await waitForProjectMirrors(value);
  fs.writeFileSync(path.join(value.installRoot, 'docs/complete-resource.txt'), 'upgraded');
  const { runRequest } = require('./project-mirror-materialization-worker');
  const rename = fs.renameSync;
  let retained;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    const result = rename(source, destination);
    if (String(destination).includes('.previous.retired-')) {
      retained = path.join(destination, 'owner-result.txt');
      fs.writeFileSync(retained, 'protected concurrent output');
    }
    return result;
  });
  const result = runRequest({ ...value, mirrors: ['docs'] });
  assert.equal(fs.existsSync(retained), true);
  assert.equal(fs.readFileSync(retained, 'utf8'), 'protected concurrent output');
  assert.equal(result[0].retainedBackup, path.dirname(retained));
  await waitForProjectMirrors(value);
  assert.equal(fs.readFileSync(retained, 'utf8'), 'protected concurrent output');
});
