const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { copyProfileResource } = require('./scripts/profile-resource-copy.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-resource-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(path.join(sourceRoot, 'cat-cafe-skills/refs'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'cat-cafe-skills/refs/shared.md'), 'bundled rules');
  return { root, sourceRoot, output: path.join(root, 'copy') };
}

test('nested bundled junctions become readable ordinary profile directories and files', (t) => {
  const value = fixture(t);
  const source = path.join(value.sourceRoot, 'cat-cafe-skills');
  fs.symlinkSync(
    path.join(source, 'refs'),
    path.join(source, '.cat-cafe-shared-refs'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  copyProfileResource(value.sourceRoot, 'cat-cafe-skills', value.output);
  assert.equal(fs.lstatSync(path.join(value.output, '.cat-cafe-shared-refs')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(value.output, '.cat-cafe-shared-refs/shared.md'), 'utf8'), 'bundled rules');
  assert.equal(fs.readFileSync(path.join(source, 'refs/shared.md'), 'utf8'), 'bundled rules');
});

test('profile copying refuses a source link outside the canonical source root and preserves its target', (t) => {
  const value = fixture(t);
  const privateRoot = path.join(value.root, 'private');
  fs.mkdirSync(privateRoot);
  const history = path.join(privateRoot, 'history');
  fs.writeFileSync(history, 'protected owner state');
  fs.symlinkSync(
    privateRoot,
    path.join(value.sourceRoot, 'cat-cafe-skills/external'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => copyProfileResource(value.sourceRoot, 'cat-cafe-skills', value.output),
    /Outside profile source root/,
  );
  assert.equal(fs.readFileSync(history, 'utf8'), 'protected owner state');
  assert.equal(fs.existsSync(value.output), false);
});

test('profile copying rejects a cycle before publishing any partial resource tree', (t) => {
  const value = fixture(t);
  fs.symlinkSync(
    path.join(value.sourceRoot, 'cat-cafe-skills'),
    path.join(value.sourceRoot, 'cat-cafe-skills/refs/cycle'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => copyProfileResource(value.sourceRoot, 'cat-cafe-skills', value.output),
    /Cyclic profile resource link/,
  );
  assert.equal(fs.existsSync(value.output), false);
});
