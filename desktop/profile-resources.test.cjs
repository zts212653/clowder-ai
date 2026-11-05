const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { copyProfileResources } = require('./scripts/profile-resources.cjs');
const { readTree } = require('./project-resource-tree.js');

test('profile installation expands real source symlinks into fully verified physical resources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-resource-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const app = path.join(root, 'app');
  for (const name of ['assets', 'docs', 'guides', 'cat-cafe-skills']) {
    fs.mkdirSync(path.join(source, name, 'empty'), { recursive: true });
    fs.writeFileSync(path.join(source, name, 'bytes.bin'), Buffer.from([0, 255, 17]));
  }
  const skills = path.join(source, 'cat-cafe-skills');
  fs.mkdirSync(path.join(skills, 'refs'));
  fs.writeFileSync(path.join(skills, 'refs/shared-rules.md'), 'complete shared rules');
  // Git's real directory symlink differs from a Windows junction. cpSync's
  // native recursive path can preserve it even with dereference:true.
  fs.symlinkSync('refs', path.join(skills, '.cat-cafe-shared-refs'), 'dir');
  fs.mkdirSync(app);
  copyProfileResources(source, app);
  const copied = path.join(app, 'cat-cafe-skills');
  assert.equal(fs.lstatSync(path.join(copied, '.cat-cafe-shared-refs')).isSymbolicLink(), false);
  assert.deepEqual(readTree(copied), readTree(skills, { boundary: fs.realpathSync(source) }));
  for (const name of ['assets', 'docs', 'guides'])
    assert.deepEqual(readTree(path.join(app, name)), readTree(path.join(source, name)));
});

test('profile resource preparation rejects escaped source links and preserves previous output', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-resource-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
  fs.mkdirSync(app);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'protected.txt'), 'preserve outside bytes');
  fs.symlinkSync(outside, path.join(source, 'assets/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyProfileResources(source, app), /Unsafe bundled resource link/);
  assert.equal(fs.existsSync(path.join(app, 'assets/escape/protected.txt')), false);
  fs.writeFileSync(path.join(app, 'assets/previous.txt'), 'preserve prior profile');
  assert.throws(() => copyProfileResources(source, app), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(app, 'assets/previous.txt'), 'utf8'), 'preserve prior profile');
  assert.equal(fs.readFileSync(path.join(outside, 'protected.txt'), 'utf8'), 'preserve outside bytes');
});
