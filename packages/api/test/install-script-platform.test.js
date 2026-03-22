import test from 'node:test';

import { assert, runSourceOnlySnippet, spawnSync } from './install-script-test-helpers.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');
const installScriptText = readFileSync(resolve(repoRoot, 'scripts', 'install.sh'), 'utf8');

test('install script supports macOS (Darwin) as a platform', () => {
  assert.match(installScriptText, /Darwin\)/);
  assert.match(installScriptText, /DISTRO_FAMILY="darwin"/);
  assert.match(installScriptText, /brew install/);
});

test('install script header lists macOS as supported', () => {
  assert.match(installScriptText, /macOS/);
  assert.match(installScriptText, /Homebrew/);
});

test('install script does not require sudo on macOS', () => {
  assert.match(installScriptText, /DISTRO_FAMILY.*!=.*darwin.*EUID/s);
});

test('install script uses brew services for Redis on macOS', () => {
  assert.match(installScriptText, /brew services start redis/);
});

test('install script prefers fnm then Homebrew for Node.js on macOS', () => {
  const darwinNodeSection = installScriptText.match(/darwin\)[\s\S]*?install_node_fnm[\s\S]*?brew install node/);
  assert.ok(darwinNodeSection, 'macOS Node.js section should try fnm first, then brew install node');
});

test('resolve_realpath provides macOS-compatible path resolution', () => {
  assert.match(installScriptText, /resolve_realpath\(\)/);
  assert.match(installScriptText, /realpath.*readlink -f/);
});

test('install script detects Homebrew on Apple Silicon and Intel paths', () => {
  assert.match(installScriptText, /\/opt\/homebrew\/bin\/brew/);
  assert.match(installScriptText, /\/usr\/local\/bin\/brew/);
});

test('install script installs Xcode CLT on macOS when missing', () => {
  assert.match(installScriptText, /xcode-select/);
});

test('resolve_realpath works on this platform', () => {
  const output = runSourceOnlySnippet(`
printf '%s' "$(resolve_realpath /tmp)"
`);
  assert.ok(output.length > 0, 'resolve_realpath should return a non-empty path');
  assert.doesNotMatch(output, /^\/tmp\/\.\./, 'resolve_realpath should resolve to canonical path');
});

test('PLATFORM variable is set correctly in source-only mode', () => {
  const output = runSourceOnlySnippet(`
printf '%s' "$PLATFORM"
`);
  const expected = process.platform === 'darwin' ? 'Darwin' : 'Linux';
  assert.equal(output, expected);
});
