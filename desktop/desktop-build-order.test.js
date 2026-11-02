const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Model a nested shared rebuild while a sibling Web build consumes its output.
// Real pnpm runs the workspace graph; no application or compiler is launched.
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f330-build-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'))).scripts;
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true, scripts: { build: scripts.build } }),
  );
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  for (const [name, mode] of [
    ['a-shared', 'seed'],
    ['b-api', 'rebuild'],
    ['c-web', 'consume'],
  ]) {
    const directory = path.join(root, 'packages', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        private: true,
        scripts: { build: `node ../../fixture.cjs ${mode}` },
        ...(mode === 'seed' ? {} : { dependencies: { 'a-shared': 'workspace:*' } }),
      }),
    );
  }
  fs.writeFileSync(
    path.join(root, 'fixture.cjs'),
    `const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname);
const output = path.join(root, 'shared-output.mjs');
const marker = name => path.join(root, name);
const payload = 'export const projectModificationSourceSchema = {};\\n'
  + 'export const projectModificationSelectionItemSchema = {};\\n'
  + 'export function validateProjectModification() {}\\n';
function wait(name, timeout) {
  const end = Date.now() + timeout;
  while (!fs.existsSync(marker(name)) && Date.now() < end)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
if (process.argv[2] === 'seed') fs.writeFileSync(output, payload);
if (process.argv[2] === 'rebuild') {
  fs.writeFileSync(output, '');
  fs.writeFileSync(marker('writer-started'), '');
  wait('reader-snapshot', 1500);
  fs.writeFileSync(output, payload);
  fs.writeFileSync(marker('writer-finished'), '');
}
if (process.argv[2] === 'consume') {
  wait('writer-started', 5000);
  const observed = fs.readFileSync(output, 'utf8');
  fs.writeFileSync(marker('reader-snapshot'), '');
  wait('writer-finished', 5000);
  assert.ok(observed.includes('export const projectModificationSourceSchema'),
    'Web consumed incomplete shared output during a nested rebuild');
}
`,
  );
  return root;
}

for (const script of ['build-mac.sh', 'build-desktop.ps1']) {
  test(`${script} finishes dependency rewrites before Web reads shared output`, (t) => {
    const root = workspace(t);
    const source = fs.readFileSync(path.join(__dirname, 'scripts', script), 'utf8');
    const line = source.split('\n').find((value) => /\bpnpm\b.*\brun build\s*$/.test(value));
    assert.ok(line, 'Exercise the actual platform build invocation');
    const args = line
      .slice(line.indexOf('pnpm') + 'pnpm'.length)
      .trim()
      .split(/\s+/);
    const result = spawnSync('pnpm', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      shell: process.platform === 'win32',
      env: { ...process.env, CI: 'true' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      fs.readFileSync(path.join(root, 'shared-output.mjs'), 'utf8').includes('validateProjectModification'),
      true,
    );
    assert.equal(fs.existsSync(path.join(root, 'reader-snapshot')), true, 'Web really ran');
    assert.equal(fs.existsSync(path.join(root, 'writer-finished')), true, 'Nested writer really finished');
  });
}
