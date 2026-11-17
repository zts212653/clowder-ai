import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pruneFrozenRuntimeRedundancy } from './scripts/frozen-runtime-prune.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-prune-'));
  const put = (relative, bytes = 8) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(bytes));
    return file;
  };
  put('@next/swc-win32-x64-msvc/swc.node', 64);
  put('node-pty/prebuilds/darwin-x64/pty.node', 32);
  put('@img/sharp-linux-x64/lib.js', 32);
  put('third-party/index.js.map', 16);
  put('keep/index.js', 8);
  put('keep/index.js.map', 16);
  return root;
}

test('removes only enabled categories and reports bytes', () => {
  const root = fixture();
  const result = pruneFrozenRuntimeRedundancy(root, { swc: true, platform: true, maps: true });
  assert.equal(result.byCategory.swc.files, 1);
  assert.equal(result.byCategory.swc.bytes, 64);
  assert.equal(result.byCategory.platform.files, 2);
  assert.equal(result.byCategory.maps.files, 2);
  assert.equal(fs.existsSync(path.join(root, '@next/swc-win32-x64-msvc/swc.node')), false);
  assert.equal(fs.existsSync(path.join(root, 'node-pty/prebuilds/darwin-x64/pty.node')), false);
  assert.equal(fs.existsSync(path.join(root, '@img/sharp-linux-x64/lib.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'third-party/index.js.map')), false);
  assert.equal(fs.existsSync(path.join(root, 'keep/index.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'keep/index.js.map')), false);
});

test('disabled categories stay untouched', () => {
  const root = fixture();
  const result = pruneFrozenRuntimeRedundancy(root, { swc: false, platform: false, maps: false });
  assert.equal(result.removedFiles, 0);
  assert.equal(fs.existsSync(path.join(root, '@next/swc-win32-x64-msvc/swc.node')), true);
  assert.equal(fs.existsSync(path.join(root, 'third-party/index.js.map')), true);
});

test('dry run reports without deleting', () => {
  const root = fixture();
  const result = pruneFrozenRuntimeRedundancy(root, { maps: true, dryRun: true });
  assert.equal(result.removedFiles, 2);
  assert.equal(fs.existsSync(path.join(root, 'third-party/index.js.map')), true);
  assert.equal(fs.existsSync(path.join(root, 'keep/index.js.map')), true);
});
