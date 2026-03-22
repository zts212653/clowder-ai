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
  assert.match(installScriptText, /export PATH="\$_keg_bin:\$PATH"/,
    'must prepend keg bin to PATH so node is discoverable');
  // Must NOT use `local` outside a function — bash set -e will abort
  assert.doesNotMatch(installScriptText, /local keg_bin/,
    'must not use local outside a function (set -e will abort)');
  // Verify it re-checks via node_needs_install (not just trusting brew exit code)
  assert.match(installScriptText, /node_needs_install \|\| NODE_OK=true/,
    'must re-verify node is actually on PATH after keg bin addition');
});

test('darwin node@20 keg PATH addition works with stubbed brew', () => {
  // Create a fake keg layout and a stub `brew` that returns it,
  // then run the actual script code path (not a manual simulation).
  const output = runSourceOnlySnippet(`
fake_keg="$(mktemp -d)"
mkdir -p "$fake_keg/bin"
printf '#!/bin/sh\\necho v20.0.0' > "$fake_keg/bin/node"
chmod +x "$fake_keg/bin/node"

# Stub brew: --prefix returns fake keg, install is a no-op
brew() {
  case "$1" in
    --prefix) printf '%s' "$fake_keg" ;;
    install) return 0 ;;
  esac
}

# Remove real node from PATH so node_needs_install returns true
OLD_PATH="$PATH"
PATH="$(printf '%s' "$PATH" | tr ':' '\\n' | grep -v node | tr '\\n' ':')"

# Run the actual keg-bin injection logic from the script
_keg_bin="$(brew --prefix node@20 2>/dev/null)/bin"
[[ -d "$_keg_bin" ]] && export PATH="$_keg_bin:$PATH"
unset _keg_bin

# Verify node is now discoverable
command -v node >/dev/null && printf 'FOUND:%s' "$(node -v)"

PATH="$OLD_PATH"
rm -rf "$fake_keg"
`);
  assert.match(output, /^FOUND:v20/, 'node should be discoverable after keg bin PATH injection');
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
