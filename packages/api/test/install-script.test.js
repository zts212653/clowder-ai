import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');
const installScript = resolve(repoRoot, 'scripts', 'install.sh');

function runSourceOnlySnippet(snippet) {
  const result = spawnSync(
    'bash',
    ['-lc', `set -e\nsource "${installScript}" --source-only >/dev/null 2>&1\n${snippet}`],
    {
      encoding: 'utf8',
    },
  );

  assert.equal(
    result.status,
    0,
    [`exit=${result.status}`, `stdout:\n${result.stdout}`, `stderr:\n${result.stderr}`].join('\n'),
  );

  return result.stdout.trim();
}

test('install script allows repo-shaped directories without .git', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-nogit-'));

  try {
    mkdirSync(join(projectRoot, 'scripts'), { recursive: true });
    mkdirSync(join(projectRoot, 'packages', 'api'), { recursive: true });
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"clowder-ai"}\n', 'utf8');

    const output = runSourceOnlySnippet(
      `
resolved="$(resolve_project_dir_from "${join(projectRoot, 'scripts', 'install.sh')}")"
printf '%s' "$resolved"
`,
    );

    assert.equal(output, projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('install script clears stale OAuth/API env keys when switching back to OAuth', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-oauth-'));

  try {
    writeFileSync(
      join(envRoot, '.env'),
      [
        "CODEX_AUTH_MODE='api_key'",
        "OPENAI_API_KEY='old-openai-key'",
        "OPENAI_BASE_URL='https://old.example/v1?foo=1&bar=2'",
        "CAT_CODEX_MODEL='gpt-old'",
        "GEMINI_API_KEY='old-gemini-key'",
        "CAT_GEMINI_MODEL='gemini-old'",
      ].join('\n') + '\n',
      'utf8',
    );

    const output = runSourceOnlySnippet(
      `
cd "${envRoot}"
reset_env_changes
set_codex_oauth_mode
set_gemini_oauth_mode
for key in "\${ENV_DELETE_KEYS[@]}"; do delete_env_key "$key"; done
for i in "\${!ENV_KEYS[@]}"; do write_env_key "\${ENV_KEYS[$i]}" "\${ENV_VALUES[$i]}"; done
cat .env
`,
    );

    assert.match(output, /^CODEX_AUTH_MODE='oauth'$/m);
    assert.doesNotMatch(output, /^OPENAI_API_KEY=/m);
    assert.doesNotMatch(output, /^OPENAI_BASE_URL=/m);
    assert.doesNotMatch(output, /^CAT_CODEX_MODEL=/m);
    assert.doesNotMatch(output, /^GEMINI_API_KEY=/m);
    assert.doesNotMatch(output, /^CAT_GEMINI_MODEL=/m);
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test('install script clears stale Codex and Gemini overrides when default values are selected', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-defaults-'));

  try {
    writeFileSync(
      join(envRoot, '.env'),
      [
        "CODEX_AUTH_MODE='api_key'",
        "OPENAI_API_KEY='old-openai-key'",
        "OPENAI_BASE_URL='https://old.example/v1'",
        "CAT_CODEX_MODEL='gpt-old'",
        "GEMINI_API_KEY='old-gemini-key'",
        "CAT_GEMINI_MODEL='gemini-old'",
      ].join('\n') + '\n',
      'utf8',
    );

    const output = runSourceOnlySnippet(
      `
cd "${envRoot}"
reset_env_changes
set_codex_api_key_mode "new-openai-key" "" ""
set_gemini_api_key_mode "new-gemini-key" ""
for key in "\${ENV_DELETE_KEYS[@]}"; do delete_env_key "$key"; done
for i in "\${!ENV_KEYS[@]}"; do write_env_key "\${ENV_KEYS[$i]}" "\${ENV_VALUES[$i]}"; done
cat .env
`,
    );

    assert.match(output, /^CODEX_AUTH_MODE='api_key'$/m);
    assert.match(output, /^OPENAI_API_KEY='new-openai-key'$/m);
    assert.match(output, /^GEMINI_API_KEY='new-gemini-key'$/m);
    assert.doesNotMatch(output, /^OPENAI_BASE_URL=/m);
    assert.doesNotMatch(output, /^CAT_CODEX_MODEL=/m);
    assert.doesNotMatch(output, /^CAT_GEMINI_MODEL=/m);
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test('npm_global_install succeeds when a custom registry is configured', () => {
  const output = runSourceOnlySnippet(`
SUDO=""
NPM_REGISTRY="https://registry.example.test"
env() {
  if [[ "$1" == npm_config_registry=* && "$2" == NPM_CONFIG_REGISTRY=* && "$3" == "npm" && "$4" == "install" && "$5" == "-g" && "$6" == "demo-pkg" ]]; then
    printf 'registry-install'
    return 0
  fi
  return 99
}
npm_global_install demo-pkg
printf '|status:%s' "$?"
`);

  assert.equal(output, 'registry-install|status:0');
});

test('resolve_provider_profiles_dir uses the canonical repo root for git worktrees', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'clowder-install-profiles-root-'));
  const worktreeRoot = join(tmpdir(), `clowder-install-profiles-worktree-${Date.now()}`);

  try {
    writeFileSync(join(repoRoot, 'README.md'), 'seed\n', 'utf8');
    spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['add', 'README.md'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf8' });
    const addResult = spawnSync(
      'git',
      ['worktree', 'add', worktreeRoot, '-b', 'feature/profiles-root'],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    assert.equal(
      addResult.status,
      0,
      [`exit=${addResult.status}`, `stdout:\n${addResult.stdout}`, `stderr:\n${addResult.stderr}`].join('\n'),
    );

    const output = runSourceOnlySnippet(`
PROJECT_DIR="${worktreeRoot}"
printf '%s' "$(resolve_provider_profiles_dir)"
`);

    assert.equal(output, join(realpathSync(repoRoot), '.cat-cafe'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('docker reruns preserve an existing API_SERVER_HOST value', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-docker-'));

  try {
    writeFileSync(
      join(envRoot, '.env'),
      ["API_SERVER_HOST='127.0.0.1'", "OTHER_KEY='keep-me'"].join('\n') + '\n',
      'utf8',
    );

    const output = runSourceOnlySnippet(`
cd "${envRoot}"
ENV_CREATED=false
docker_detected() { return 0; }
maybe_write_docker_api_host
cat .env
`);

    assert.match(output, /^API_SERVER_HOST='127.0.0.1'$/m);
    assert.match(output, /^OTHER_KEY='keep-me'$/m);
    assert.doesNotMatch(output, /^API_SERVER_HOST='0.0.0.0'$/m);
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test('use_registry sets only env vars without writing to user npmrc', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'clowder-install-registry-'));
  try {
    const output = runSourceOnlySnippet(`
export HOME="${tmpHome}"
use_registry "https://mirror.example.test"
printf 'npm=%s|pnpm=%s' "\$npm_config_registry" "\$PNPM_CONFIG_REGISTRY"
# Check that no .npmrc was created in the temp home
[[ -f "${tmpHome}/.npmrc" ]] && printf '|LEAKED' || printf '|CLEAN'
`);
    assert.match(output, /npm=https:\/\/mirror\.example\.test/);
    assert.match(output, /pnpm=https:\/\/mirror\.example\.test/);
    assert.match(output, /\|CLEAN$/, 'use_registry must not write to ~/.npmrc');
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ── TTY input compatibility tests ─────────────────────────────────────────

test('tty_read returns empty string when /dev/tty is unavailable (no blocking)', () => {
  // When HAS_TTY=false (as it would be in containers/CI), tty_read must
  // return an empty string without ever touching /dev/tty.
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
source "${installScript}" --source-only >/dev/null 2>&1
# Force no-TTY mode (simulates container / pipe environment)
HAS_TTY=false
tty_read "prompt: " MY_VAR
printf '%s' "\$MY_VAR"`,
    ],
    {
      encoding: 'utf8',
      input: '',
    },
  );

  assert.equal(result.status, 0, `exit=${result.status}\nstderr:\n${result.stderr}`);
  // Should return empty string, not hang
  assert.equal(result.stdout, '');
});

test('tty_read uses 120s timeout to prevent indefinite blocking', () => {
  // Verify the function definition includes -t 120
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -e
source "${installScript}" --source-only >/dev/null 2>&1
type tty_read`,
    ],
    {
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, `exit=${result.status}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /-t 120/, 'tty_read should include -t 120 timeout');
});

test('tty_read_secret uses 120s timeout and suppresses echo', () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -e
source "${installScript}" --source-only >/dev/null 2>&1
type tty_read_secret`,
    ],
    {
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, `exit=${result.status}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /-t 120/, 'tty_read_secret should include -t 120 timeout');
  assert.match(result.stdout, /-rs/, 'tty_read_secret should use -s to suppress echo');
});

test('tty_read prompt is written via printf, not via read -p', () => {
  // read -p writes to stderr, which was swallowed by 2>/dev/null in the old
  // implementation.  The fix uses explicit printf to /dev/tty.
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -e
source "${installScript}" --source-only >/dev/null 2>&1
type tty_read`,
    ],
    {
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0);
  // Should NOT contain 'read -rp' (old pattern)
  assert.doesNotMatch(
    result.stdout,
    /read\s+-rp/,
    'tty_read should not use read -rp (prompt goes to stderr, swallowed by 2>/dev/null)',
  );
  // Should contain explicit printf to /dev/tty
  assert.match(result.stdout, /printf.*\/dev\/tty/, 'tty_read should printf prompt to /dev/tty');
});

test('HAS_TTY detection checks both -r and -w on /dev/tty', () => {
  // The old code only checked -r; we now also check -w since prompts write to /dev/tty.
  const result = spawnSync('bash', ['-c', `grep -E '\\-r /dev/tty.*\\-w /dev/tty' "${installScript}" | head -1`], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /-r \/dev\/tty/, 'Should check /dev/tty is readable');
  assert.match(result.stdout, /-w \/dev\/tty/, 'Should check /dev/tty is writable');
});
