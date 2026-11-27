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
  // Build-only compiler for the target, plus real package names from each family.
  put('@next/swc-win32-x64-msvc/swc.node', 64);
  put('node-pty/prebuilds/darwin-x64/pty.node', 32);
  put('node-pty/prebuilds/win32-arm64/pty.node', 32);
  put('node-pty/prebuilds/win32-x64/pty.node', 32);
  put('@img/sharp-linux-x64/lib.js', 32);
  put('@img/sharp-darwin-arm64/lib.js', 32);
  put('@img/sharp-libvips-linux-x64/lib.js', 32);
  put('@img/sharp-win32-x64/lib.js', 32);
  put('@esbuild/darwin-x64/pkg/package.json', 32);
  put('@esbuild/openbsd-x64/pkg/package.json', 32);
  put('@esbuild/win32-x64/pkg/package.json', 32);
  put('third-party/index.js.map', 16);
  put('keep/index.js', 8);
  put('keep/index.js.map', 16);
  return root;
}

const removedPlatform = (root, relative) => assert.equal(fs.existsSync(path.join(root, relative)), false, relative);
const kept = (root, relative) => assert.equal(fs.existsSync(path.join(root, relative)), true, relative);

test('removes only enabled categories and reports bytes', () => {
  const root = fixture();
  const result = pruneFrozenRuntimeRedundancy(root, { swc: true, platform: true, maps: true });
  assert.equal(result.byCategory.swc.files, 1);
  assert.equal(result.byCategory.swc.bytes, 64);
  assert.equal(result.byCategory.platform.files, 7);
  assert.equal(result.byCategory.maps.files, 2);
  removedPlatform(root, '@next/swc-win32-x64-msvc/swc.node');
  removedPlatform(root, 'node-pty/prebuilds/darwin-x64/pty.node');
  removedPlatform(root, 'node-pty/prebuilds/win32-arm64/pty.node');
  removedPlatform(root, '@img/sharp-linux-x64/lib.js');
  removedPlatform(root, '@img/sharp-darwin-arm64/lib.js');
  removedPlatform(root, '@img/sharp-libvips-linux-x64/lib.js');
  removedPlatform(root, '@esbuild/darwin-x64/pkg/package.json');
  removedPlatform(root, '@esbuild/openbsd-x64/pkg/package.json');
  removedPlatform(root, 'third-party/index.js.map');
  removedPlatform(root, 'keep/index.js.map');
});

test('keeps target-platform packages', () => {
  const root = fixture();
  pruneFrozenRuntimeRedundancy(root, { platform: true, maps: true });
  kept(root, 'node-pty/prebuilds/win32-x64/pty.node');
  kept(root, '@img/sharp-win32-x64/lib.js');
  kept(root, '@esbuild/win32-x64/pkg/package.json');
  kept(root, 'keep/index.js');
});

test('explicitly keeping SWC leaves the other optimizations active', () => {
  const root = fixture();
  const result = pruneFrozenRuntimeRedundancy(root, { swc: false, platform: true, maps: true });
  kept(root, '@next/swc-win32-x64-msvc/swc.node');
  assert.equal(result.byCategory.platform.files, 7);
  assert.equal(result.byCategory.maps.files, 2);
});

test('rejects platform pruning for an unsupported target', () => {
  assert.throws(
    () => pruneFrozenRuntimeRedundancy(fixture(), { platform: true, target: 'darwin-arm64' }),
    /Unsupported prune target/,
  );
});

test('disabled categories stay untouched', () => {
  const root = fixture();
  const result = pruneFrozenRuntimeRedundancy(root, { swc: false, platform: false, maps: false });
  assert.equal(result.removedFiles, 0);
  kept(root, '@next/swc-win32-x64-msvc/swc.node');
  kept(root, 'third-party/index.js.map');
});

test('dry run reports without deleting', () => {
  const root = fixture();
  const result = pruneFrozenRuntimeRedundancy(root, { maps: true, dryRun: true });
  assert.equal(result.removedFiles, 2);
  kept(root, 'third-party/index.js.map');
  kept(root, 'keep/index.js.map');
});
