const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { prepareProjectMirrors, PROJECT_MIRROR_PROBES } = require('./project-mirrors');
const { waitForProjectMirrors } = require('./project-mirror-readiness');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'physical-resources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = {
    installRoot: path.join(root, 'installed'),
    projectDir: path.join(root, 'project'),
    platform: 'win32',
  };
  for (const relative of [
    ...PROJECT_MIRROR_PROBES.map(({ mirror, relativePath }) => path.join(mirror, relativePath)),
    'docs/another-consumer.md',
    'assets/prompt-templates/system.md',
    'guides/catalog.yaml',
  ]) {
    const file = path.join(value.installRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  return value;
}

test('Windows critical resources are complete ordinary directories, including non-probe consumers', async (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  for (const name of ['docs', 'cat-cafe-skills', 'assets', 'guides']) {
    assert.equal(
      fs.lstatSync(path.join(value.projectDir, name)).isSymbolicLink(),
      false,
      `${name} must not be a junction`,
    );
  }
  assert.equal(
    fs.readFileSync(path.join(value.projectDir, 'docs/another-consumer.md'), 'utf8'),
    'docs/another-consumer.md',
  );
  assert.equal((await waitForProjectMirrors(value)).verification, 'parent');
});

test('old links migrate without modifying their targets; repeat preparation is idempotent', (t) => {
  const value = fixture(t);
  fs.mkdirSync(value.projectDir);
  const old = path.join(path.dirname(value.projectDir), 'protected-old-target');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'history.txt'), 'keep');
  fs.symlinkSync(old, path.join(value.projectDir, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  prepareProjectMirrors(value);
  assert.equal(fs.lstatSync(path.join(value.projectDir, 'docs')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(old, 'history.txt'), 'utf8'), 'keep');
  const file = path.join(value.projectDir, 'docs/another-consumer.md');
  const modified = fs.statSync(file).mtimeMs;
  prepareProjectMirrors(value);
  assert.equal(fs.statSync(file).mtimeMs, modified);
});

test('bundle upgrades refresh only an unchanged managed copy and preserve all user state', (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const userFile = path.join(value.projectDir, '.cat-cafe/history.json');
  fs.mkdirSync(path.dirname(userFile));
  fs.writeFileSync(userFile, 'protected history');
  fs.writeFileSync(path.join(value.installRoot, 'docs/another-consumer.md'), 'upgraded bundle');
  prepareProjectMirrors(value);
  assert.equal(fs.readFileSync(path.join(value.projectDir, 'docs/another-consumer.md'), 'utf8'), 'upgraded bundle');
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'protected history');
  fs.writeFileSync(path.join(value.projectDir, 'docs/another-consumer.md'), 'owner change');
  fs.writeFileSync(path.join(value.installRoot, 'docs/another-consumer.md'), 'second upgrade');
  assert.throws(() => prepareProjectMirrors(value), /modified.*resource/i);
  assert.equal(fs.readFileSync(path.join(value.projectDir, 'docs/another-consumer.md'), 'utf8'), 'owner change');
});

test('runtime output added under docs is retained and does not break the next launch or get overwritten on upgrade', (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const output = path.join(value.projectDir, 'docs/harness-feedback/verdicts/local-result.md');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, 'protected evaluation output');
  prepareProjectMirrors(value);
  fs.writeFileSync(path.join(value.installRoot, 'docs/another-consumer.md'), 'upgraded bundle');
  prepareProjectMirrors(value);
  assert.equal(fs.readFileSync(output, 'utf8'), 'protected evaluation output');
  assert.equal(
    fs.readFileSync(path.join(value.projectDir, 'docs/another-consumer.md'), 'utf8'),
    'docs/another-consumer.md',
  );
});

test('unmanaged real directories are preserved, and missing probes still block readiness', async (t) => {
  const value = fixture(t);
  fs.mkdirSync(path.join(value.projectDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(value.projectDir, 'docs/custom.md'), 'owner content');
  prepareProjectMirrors(value);
  assert.equal(fs.readFileSync(path.join(value.projectDir, 'docs/custom.md'), 'utf8'), 'owner content');
  await assert.rejects(waitForProjectMirrors({ ...value, timeoutMs: 1 }), /readiness failed/);
});

test('failed publication restores the old copy, and the next launch retries successfully', (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const file = path.join(value.projectDir, 'docs/another-consumer.md');
  fs.writeFileSync(path.join(value.installRoot, 'docs/another-consumer.md'), 'new bundle');
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (source.endsWith('.clowder-resource-docs.next'))
      throw Object.assign(new Error('controlled publish failure'), { code: 'EPERM' });
    return rename(source, destination);
  });
  assert.throws(() => prepareProjectMirrors(value), /controlled publish failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'docs/another-consumer.md');
  mocked.mock.restore();
  prepareProjectMirrors(value);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new bundle');
});

test('a crash between renames is recovered without touching owner configuration', (t) => {
  const value = fixture(t);
  prepareProjectMirrors(value);
  const destination = path.join(value.projectDir, 'docs');
  fs.renameSync(destination, path.join(value.projectDir, '.clowder-resource-docs.previous'));
  prepareProjectMirrors(value);
  assert.equal(fs.readFileSync(path.join(destination, 'another-consumer.md'), 'utf8'), 'docs/another-consumer.md');
});

test('partially failed old-backup cleanup cannot poison publication or the next startup', (t) => {
  const value = fixture(t);
  const source = path.join(value.installRoot, 'docs/another-consumer.md');
  prepareProjectMirrors(value);
  fs.writeFileSync(source, 'version2');
  prepareProjectMirrors(value);
  fs.writeFileSync(source, 'version3');
  const remove = fs.rmSync;
  const mocked = t.mock.method(fs, 'rmSync', (directory, ...args) => {
    if (String(directory).includes('.clowder-resource-docs.previous')) {
      fs.unlinkSync(path.join(directory, 'another-consumer.md'));
      throw Object.assign(new Error('controlled interrupted cleanup'), { code: 'EPERM' });
    }
    return remove(directory, ...args);
  });
  assert.doesNotThrow(() => prepareProjectMirrors(value));
  mocked.mock.restore();
  prepareProjectMirrors(value);
  assert.equal(fs.readFileSync(path.join(value.projectDir, 'docs/another-consumer.md'), 'utf8'), 'version3');
});

test('an interrupted copy keeps old links usable and retries without discarding its partial output', (t) => {
  const value = fixture(t);
  const write = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).includes('.clowder-resource-docs.next') && String(file).endsWith('another-consumer.md'))
      throw new Error('controlled copy failure');
    return write(file, ...args);
  });
  assert.throws(() => prepareProjectMirrors(value), /controlled copy failure/);
  mocked.mock.restore();
  prepareProjectMirrors(value);
  const retained = fs
    .readdirSync(value.projectDir)
    .filter((name) => name.startsWith('.clowder-resource-docs.next.interrupted-'));
  assert.equal(retained.length, 1);
  assert.ok(fs.readFileSync(path.join(value.projectDir, 'docs/another-consumer.md')).length);
});

test('bundled internal links are expanded; outside links and cycles are rejected before publication', (t) => {
  const value = fixture(t);
  const refs = path.join(value.installRoot, 'cat-cafe-skills/refs');
  const alias = path.join(value.installRoot, 'cat-cafe-skills/shared');
  fs.symlinkSync(refs, alias, process.platform === 'win32' ? 'junction' : 'dir');
  prepareProjectMirrors(value);
  assert.equal(fs.lstatSync(path.join(value.projectDir, 'cat-cafe-skills/shared')).isSymbolicLink(), false);
  const outside = path.dirname(value.installRoot);
  fs.symlinkSync(
    outside,
    path.join(value.installRoot, 'docs/outside'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => prepareProjectMirrors(value), /Unsafe bundled resource link/);
  fs.unlinkSync(path.join(value.installRoot, 'docs/outside'));
  fs.symlinkSync(
    path.join(value.installRoot, 'docs'),
    path.join(value.installRoot, 'docs/cycle'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => prepareProjectMirrors(value), /Cyclic bundled resource/);
});
