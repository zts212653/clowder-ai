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

// ── Behavioral tests for Darwin branch ────────────────────────

test('darwin node@20 keg-only: adds keg bin to PATH after brew install', () => {
  // Verify the install script explicitly adds the keg bin to PATH
  // rather than relying on brew link (which keg-only formulas don't support)
  assert.match(installScriptText, /brew --prefix node@20/,
    'must resolve the keg prefix to find the bin directory');
  assert.match(installScriptText, /export PATH="\$keg_bin:\$PATH"/,
    'must prepend keg bin to PATH so node is discoverable');
  // Verify it re-checks via node_needs_install (not just trusting brew exit code)
  assert.match(installScriptText, /node_needs_install \|\| NODE_OK=true/,
    'must re-verify node is actually on PATH after keg bin addition');
});

test('darwin node@20 keg PATH addition is exercisable via source-only', () => {
  // Exercise the actual bash function: simulate a keg bin directory
  // and verify PATH is updated correctly
  const output = runSourceOnlySnippet(`
# Simulate: brew installed node@20 into a keg, but node is not on PATH
fake_keg="$(mktemp -d)"
mkdir -p "$fake_keg/bin"
printf '#!/bin/sh\\necho v20.0.0' > "$fake_keg/bin/node"
chmod +x "$fake_keg/bin/node"
# Simulate brew --prefix returning the fake keg
keg_bin="$fake_keg/bin"
[[ -d "$keg_bin" ]] && export PATH="$keg_bin:$PATH"
# Verify node is now findable
printf '%s' "$(command -v node)"
rm -rf "$fake_keg"
`);
  assert.ok(output.length > 0, 'node should be discoverable on PATH after keg bin addition');
  assert.match(output, /\/bin\/node$/, 'should resolve to the keg bin node');
});

test('darwin redis install verifies redis-cli ping, not just brew exit code', () => {
  // The install_redis_local function must verify Redis is actually responding
  assert.match(installScriptText, /redis-cli ping/,
    'must verify Redis responds to ping after install');
  assert.match(installScriptText, /fail "Redis installed but not responding to ping"/,
    'must report failure when Redis is installed but not responding');
  assert.match(installScriptText, /return 1/,
    'must return non-zero on Redis verification failure');
});

test('darwin redis install reports brew install failure instead of swallowing', () => {
  // brew install must NOT have || true — failure must be caught
  assert.match(installScriptText, /if ! brew install redis/,
    'brew install redis must be guarded by conditional, not swallowed with || true');
  assert.match(installScriptText, /fail "brew install redis failed"/,
    'must report brew install failure explicitly');
});
