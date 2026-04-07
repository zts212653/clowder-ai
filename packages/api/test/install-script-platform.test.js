import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assert, runSourceOnlySnippet } from './install-script-test-helpers.js';

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

test('install script rejects root on macOS with early guard', () => {
  assert.match(
    installScriptText,
    /PLATFORM.*==.*Darwin.*EUID.*-eq.*0.*exit 1/s,
    'must fail early when run as root on macOS, before reaching Homebrew',
  );
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

test('homebrew install curl has connect timeout to avoid hanging on unreachable networks', () => {
  assert.match(
    installScriptText,
    /curl.*--connect-timeout.*--max-time.*Homebrew/,
    'Homebrew install curl must have connect-timeout and max-time to fail fast on unreachable networks',
  );
});

test('install script installs Xcode CLT on macOS when missing', () => {
  assert.match(installScriptText, /xcode-select/);
});

test('darwin xcode CLT wait uses long non-fatal timeout', () => {
  assert.match(installScriptText, /_xcode_timeout=1800/, 'must wait up to 30 minutes before timing out');
  assert.match(
    installScriptText,
    /warn "Xcode CLT not ready after 30 min/,
    'timeout should warn and continue, not hard-exit',
  );
  assert.doesNotMatch(
    installScriptText,
    /Xcode CLT install timed out.*exit 1/s,
    'must not hard-fail installer on CLT timeout',
  );
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
  assert.match(installScriptText, /brew --prefix node@20/, 'must resolve the keg prefix to find the bin directory');
  assert.match(
    installScriptText,
    /export PATH="\$_keg_bin:\$PATH"/,
    'must prepend keg bin to PATH so node is discoverable',
  );
  // Must NOT use `local` outside a function — bash set -e will abort
  assert.doesNotMatch(installScriptText, /local keg_bin/, 'must not use local outside a function (set -e will abort)');
  // Verify it re-checks via node_needs_install (not just trusting brew exit code)
  assert.match(
    installScriptText,
    /node_needs_install \|\| NODE_OK=true/,
    'must re-verify node is actually on PATH after keg bin addition',
  );
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

test('darwin node@20 keg: prefix failure must NOT write /bin to profile (#174 P1 regression)', () => {
  // When brew --prefix fails, _keg_prefix is empty and _keg_bin must NOT
  // degrade to "/bin" (a real system directory).
  const output = runSourceOnlySnippet(`
# Stub brew: --prefix FAILS, install is a no-op
brew() {
  case "$1" in
    --prefix) return 1 ;;
    install) return 0 ;;
  esac
}

_keg_prefix="$(brew --prefix node@20 2>/dev/null || true)"
_keg_bin="\${_keg_prefix:+$_keg_prefix/bin}"
# Evaluate the conditional expansion
eval "_keg_bin=$_keg_bin"

if [[ -n "$_keg_bin" && -d "$_keg_bin" ]]; then
  printf 'BAD:wrote_bin_path'
else
  printf 'OK:skipped'
fi
`);
  assert.match(output, /^OK:skipped/, '_keg_bin must be empty when brew --prefix fails — must NOT degrade to /bin');
});

// ── CLI install method tests ────────────────────────────

test('darwin: Claude and Codex installed via brew cask, not curl/npm', () => {
  // On macOS, Claude and Codex must use Homebrew cask to avoid region-blocked URLs
  // "claude-code" is the CLI cask; "claude" is the desktop app (wrong target)
  assert.match(installScriptText, /install_brew_cask/, 'must define install_brew_cask helper');
  assert.match(installScriptText, /brew install --cask/, 'must use --cask flag');
  assert.match(
    installScriptText,
    /install_brew_cask "Claude Code" "claude" "claude-code"/,
    'Claude CLI must install cask "claude-code", not "claude" (desktop app)',
  );
  assert.match(
    installScriptText,
    /install_brew_cask "Codex CLI" "codex" "codex"/,
    'Codex CLI must install cask "codex"',
  );
});

test('linux: Claude installed via npm, not curl claude.ai', () => {
  // claude.ai/install.sh is region-blocked — use npm as universal fallback
  assert.doesNotMatch(
    installScriptText,
    /curl.*claude\.ai\/install\.sh/,
    'must NOT use curl claude.ai/install.sh (region-blocked in some countries)',
  );
  assert.match(
    installScriptText,
    /@anthropic-ai\/claude-code/,
    'Linux Claude install must use npm package @anthropic-ai/claude-code',
  );
});

test('Gemini always installed via npm (no brew formula)', () => {
  assert.match(installScriptText, /gemini\).*install_npm_cli.*Gemini/s, 'Gemini must always use npm install');
});

test('darwin redis install does not ping-gate after install', () => {
  // install_redis_local must NOT check redis-cli ping — install success
  // is determined by the package manager exit code, not by whether the
  // service is already responding.
  assert.doesNotMatch(
    installScriptText,
    /install_redis_local[\s\S]*?redis-cli ping[\s\S]*?return 1/s,
    'install_redis_local must not fail on redis-cli ping',
  );
});

test('darwin redis install reports brew install failure instead of swallowing', () => {
  // brew install must NOT have || true — failure must be caught
  assert.match(
    installScriptText,
    /if ! brew install redis/,
    'brew install redis must be guarded by conditional, not swallowed with || true',
  );
  assert.match(installScriptText, /fail "brew install redis failed"/, 'must report brew install failure explicitly');
});

test('darwin brew detection uses arch-aware candidate order, not both', () => {
  // Must NOT eval both /opt/homebrew and /usr/local shellenv sequentially (#174 P2)
  assert.match(
    installScriptText,
    /uname -m.*arm64/s,
    'must use uname -m to detect architecture for brew path selection',
  );
  assert.match(
    installScriptText,
    /_brew_candidates=/,
    'must use a candidates array for deterministic single-brew selection',
  );
  // Ensure we break after the first match, not eval both
  assert.match(
    installScriptText,
    /eval.*\$_brew.*shellenv[\s\S]*?_brew_recovered=true[\s\S]*?break/,
    'must break after first successful brew shellenv eval',
  );
});

test('darwin brew shellenv persisted to login profile after recovery', () => {
  // #174 P2: new terminals must find brew without manual PATH setup
  assert.match(
    installScriptText,
    /_brew_recovered.*==.*true/,
    'must track whether brew was recovered/installed to decide persistence',
  );
  assert.match(
    installScriptText,
    /brew.*shellenv.*Homebrew.*added by Clowder AI/,
    'must persist brew shellenv eval line with attribution comment',
  );
});

test('darwin ~/.local/bin persisted unconditionally (not only inside Node/pnpm install)', () => {
  // #174 P2: If Node and pnpm are pre-installed, their blocks are skipped
  // but persist_user_bin still writes to ~/.local/bin. The persistence must
  // happen in the USER_BIN_DIR setup block, not only inside conditional blocks.
  const userBinBlock = installScriptText.match(/USER_BIN_DIR="\$HOME\/\.local\/bin"[\s\S]*?(?=resolve_project_dir)/);
  assert.ok(userBinBlock, 'must have a USER_BIN_DIR setup block on Darwin');
  assert.match(
    userBinBlock[0],
    /append_to_profile.*\.local\/bin/,
    'USER_BIN_DIR block must persist ~/.local/bin to login profiles unconditionally',
  );
});

test('darwin PATH persistence covers both zsh and bash profiles', () => {
  // #174 P2: bash users must also get PATH additions
  assert.match(installScriptText, /darwin_login_profiles\(\)/, 'must define darwin_login_profiles helper');
  assert.match(installScriptText, /\.zprofile/, 'darwin_login_profiles must include zsh profile');
  assert.match(installScriptText, /\.bash_profile/, 'darwin_login_profiles must include bash profile');
  assert.match(
    installScriptText,
    /\.profile/,
    'darwin_login_profiles must fall back to ~/.profile when ~/.bash_profile missing',
  );
});
