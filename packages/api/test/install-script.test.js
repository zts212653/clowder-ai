import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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

test('Claude empty API key removes stale installer-managed profile', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-empty-'));
  const catCafeDir = join(envRoot, '.cat-cafe');

  try {
    mkdirSync(catCafeDir, { recursive: true });
    writeFileSync(
      join(catCafeDir, 'provider-profiles.json'),
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: {
            activeProfileId: 'installer-managed',
            profiles: [{ id: 'installer-managed', provider: 'anthropic', name: 'Installer API Key', mode: 'api_key' }],
          },
        },
      }),
    );
    writeFileSync(
      join(catCafeDir, 'provider-profiles.secrets.local.json'),
      JSON.stringify({
        version: 1,
        providers: { anthropic: { 'installer-managed': { apiKey: 'sk-old-stale-key' } } },
      }),
    );

    runSourceOnlySnippet(`
PROJECT_DIR="${envRoot}"
remove_claude_installer_profile
`);

    const profiles = JSON.parse(readFileSync(join(catCafeDir, 'provider-profiles.json'), 'utf8'));
    const secrets = JSON.parse(readFileSync(join(catCafeDir, 'provider-profiles.secrets.local.json'), 'utf8'));
    const anthropic = profiles.providers?.anthropic;
    assert.ok(anthropic, 'anthropic provider entry should still exist');
    const installerProfile = (anthropic.profiles ?? []).find((p) => p.id === 'installer-managed');
    assert.equal(installerProfile, undefined, 'installer-managed profile must be removed');
    assert.notEqual(anthropic.activeProfileId, 'installer-managed', 'active profile must not be stale');
    assert.equal(secrets.providers?.anthropic?.['installer-managed'], undefined, 'secret must be removed');
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
    const canonicalRepoRoot = realpathSync(repoRoot);
    writeFileSync(join(repoRoot, 'README.md'), 'seed\n', 'utf8');
    spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['add', 'README.md'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf8' });
    const addResult = spawnSync('git', ['worktree', 'add', worktreeRoot, '-b', 'feature/profiles-root'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(
      addResult.status,
      0,
      [`exit=${addResult.status}`, `stdout:\n${addResult.stdout}`, `stderr:\n${addResult.stderr}`].join('\n'),
    );

    const output = runSourceOnlySnippet(`
PROJECT_DIR="${worktreeRoot}"
PROJECT_ALLOWED_ROOTS="${canonicalRepoRoot}"
unset PROJECT_ALLOWED_ROOTS_APPEND
printf '%s' "$(resolve_provider_profiles_dir)"
`);

    assert.equal(output, join(canonicalRepoRoot, '.cat-cafe'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('resolve_provider_profiles_dir stays local when the canonical repo root is outside PROJECT_ALLOWED_ROOTS', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'clowder-install-profiles-allowlist-root-'));
  const worktreeRoot = join(tmpdir(), `clowder-install-profiles-allowlist-worktree-${Date.now()}`);

  try {
    writeFileSync(join(repoRoot, 'README.md'), 'seed\n', 'utf8');
    spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['add', 'README.md'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf8' });
    const addResult = spawnSync('git', ['worktree', 'add', worktreeRoot, '-b', 'feature/profiles-allowlist'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(
      addResult.status,
      0,
      [`exit=${addResult.status}`, `stdout:\n${addResult.stdout}`, `stderr:\n${addResult.stderr}`].join('\n'),
    );

    const output = runSourceOnlySnippet(`
PROJECT_DIR="${worktreeRoot}"
PROJECT_ALLOWED_ROOTS="/opt/allowed-only"
unset PROJECT_ALLOWED_ROOTS_APPEND
printf '%s' "$(resolve_provider_profiles_dir)"
`);

    assert.equal(output, join(worktreeRoot, '.cat-cafe'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('resolve_provider_profiles_dir accepts non-canonical allowlist roots that resolve to the repo root', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'clowder-install-profiles-normalized-root-'));
  const worktreeRoot = join(tmpdir(), `clowder-install-profiles-normalized-worktree-${Date.now()}`);

  try {
    const canonicalRepoRoot = realpathSync(repoRoot);
    const nonCanonicalAllowedRoot = `${canonicalRepoRoot}/../${basename(canonicalRepoRoot)}`;
    writeFileSync(join(repoRoot, 'README.md'), 'seed\n', 'utf8');
    spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['add', 'README.md'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf8' });
    const addResult = spawnSync('git', ['worktree', 'add', worktreeRoot, '-b', 'feature/profiles-normalized-root'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(
      addResult.status,
      0,
      [`exit=${addResult.status}`, `stdout:\n${addResult.stdout}`, `stderr:\n${addResult.stderr}`].join('\n'),
    );

    const output = runSourceOnlySnippet(`
PROJECT_DIR="${worktreeRoot}"
PROJECT_ALLOWED_ROOTS="${nonCanonicalAllowedRoot}"
unset PROJECT_ALLOWED_ROOTS_APPEND
printf '%s' "$(resolve_provider_profiles_dir)"
`);

    assert.equal(output, join(canonicalRepoRoot, '.cat-cafe'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('resolve_provider_profiles_dir rejects symlink-only allowlist aliases that runtime would not match', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'clowder-install-profiles-symlink-root-'));
  const aliasBase = mkdtempSync(join(tmpdir(), 'clowder-install-profiles-symlink-alias-'));
  const aliasRoot = join(aliasBase, 'repo-alias');
  const worktreeRoot = join(tmpdir(), `clowder-install-profiles-symlink-worktree-${Date.now()}`);

  try {
    const canonicalRepoRoot = realpathSync(repoRoot);
    symlinkSync(canonicalRepoRoot, aliasRoot);
    writeFileSync(join(repoRoot, 'README.md'), 'seed\n', 'utf8');
    spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['add', 'README.md'], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf8' });
    const addResult = spawnSync('git', ['worktree', 'add', worktreeRoot, '-b', 'feature/profiles-symlink-root'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(
      addResult.status,
      0,
      [`exit=${addResult.status}`, `stdout:\n${addResult.stdout}`, `stderr:\n${addResult.stderr}`].join('\n'),
    );

    const output = runSourceOnlySnippet(`
PROJECT_DIR="${worktreeRoot}"
PROJECT_ALLOWED_ROOTS="${aliasRoot}"
unset PROJECT_ALLOWED_ROOTS_APPEND
printf '%s' "$(resolve_provider_profiles_dir)"
`);

    assert.equal(output, join(worktreeRoot, '.cat-cafe'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aliasBase, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('docker reruns add API_SERVER_HOST when missing from existing .env', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-docker-missing-'));

  try {
    writeFileSync(join(envRoot, '.env'), "OTHER_KEY='keep-me'\n", 'utf8');

    const output = runSourceOnlySnippet(`
cd "${envRoot}"
ENV_CREATED=false
docker_detected() { return 0; }
maybe_write_docker_api_host
cat .env
`);

    assert.match(output, /API_SERVER_HOST='0\.0\.0\.0'/, 'Must auto-write API_SERVER_HOST when missing');
    assert.match(output, /OTHER_KEY='keep-me'/, 'Must preserve other keys');
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
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
printf 'npm=%s|pnpm=%s' "$npm_config_registry" "$PNPM_CONFIG_REGISTRY"
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

test('tty_select and tty_multiselect have read timeout to prevent indefinite blocking', () => {
  const output = runSourceOnlySnippet(`
type tty_select
echo '---SEPARATOR---'
type tty_multiselect
`);

  const [selectSrc, multiselectSrc] = output.split('---SEPARATOR---');
  assert.match(selectSrc, /read\s+-rsn1\s+-t\s+\d+/, 'tty_select must have -t timeout on primary read');
  assert.match(multiselectSrc, /read\s+-rsn1\s+-t\s+\d+/, 'tty_multiselect must have -t timeout on primary read');
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
printf '%s' "$MY_VAR"`,
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

test('resolve_provider_profiles_dir stays local for submodules (not the parent repo)', () => {
  const parentRepo = mkdtempSync(join(tmpdir(), 'clowder-install-parent-'));
  const childDir = join(parentRepo, 'vendor', 'child');

  try {
    // Create parent repo
    writeFileSync(join(parentRepo, 'README.md'), 'parent\n', 'utf8');
    spawnSync('git', ['init', '-b', 'main'], { cwd: parentRepo, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: parentRepo, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: parentRepo, encoding: 'utf8' });
    spawnSync('git', ['add', '.'], { cwd: parentRepo, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: parentRepo, encoding: 'utf8' });

    // Create child repo that will become a submodule
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, 'README.md'), 'child\n', 'utf8');
    spawnSync('git', ['init', '-b', 'main'], { cwd: childDir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: childDir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: childDir, encoding: 'utf8' });
    spawnSync('git', ['add', '.'], { cwd: childDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: childDir, encoding: 'utf8' });

    // Add as submodule
    const submodResult = spawnSync('git', ['submodule', 'add', childDir, 'vendor/child'], {
      cwd: parentRepo,
      encoding: 'utf8',
    });
    if (submodResult.status !== 0) {
      // Fallback: simulate submodule structure manually
      // .git file in child pointing to parent's .git/modules/...
      const modulesDir = join(parentRepo, '.git', 'modules', 'vendor', 'child');
      mkdirSync(modulesDir, { recursive: true });
      rmSync(join(childDir, '.git'), { recursive: true, force: true });
      writeFileSync(join(childDir, '.git'), `gitdir: ${modulesDir}\n`, 'utf8');
      writeFileSync(join(modulesDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    }

    const output = runSourceOnlySnippet(`
PROJECT_DIR="${childDir}"
printf '%s' "$(resolve_provider_profiles_dir)"
`);

    const parentCatCafe = join(realpathSync(parentRepo), '.cat-cafe');
    assert.notEqual(output, parentCatCafe, 'Must NOT write profiles to parent repo');
    assert.equal(output, join(childDir, '.cat-cafe'), 'Must stay local to the child project');
  } finally {
    rmSync(parentRepo, { recursive: true, force: true });
  }
});

test('resolve_provider_profiles_dir stays local for nested archive inside another checkout', () => {
  const outerRepo = mkdtempSync(join(tmpdir(), 'clowder-install-outer-'));
  const archiveDir = join(outerRepo, 'unpacked', 'clowder-ai');

  try {
    // Create outer repo
    writeFileSync(join(outerRepo, 'README.md'), 'outer\n', 'utf8');
    spawnSync('git', ['init', '-b', 'main'], { cwd: outerRepo, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: outerRepo, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: outerRepo, encoding: 'utf8' });
    spawnSync('git', ['add', '.'], { cwd: outerRepo, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: outerRepo, encoding: 'utf8' });

    // Create archive dir (no .git) inside outer repo
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, 'package.json'), '{"name":"clowder-ai"}\n', 'utf8');

    const output = runSourceOnlySnippet(`
PROJECT_DIR="${archiveDir}"
printf '%s' "$(resolve_provider_profiles_dir)"
`);

    const outerCatCafe = join(realpathSync(outerRepo), '.cat-cafe');
    assert.notEqual(output, outerCatCafe, 'Must NOT write profiles to outer repo');
    assert.equal(output, join(archiveDir, '.cat-cafe'), 'Must stay local to the archive');
  } finally {
    rmSync(outerRepo, { recursive: true, force: true });
  }
});

test('resolve_provider_profiles_dir rejects forged .git file pointing at another repo worktree', () => {
  const victimRepo = mkdtempSync(join(tmpdir(), 'clowder-install-victim-'));
  const realWorktreeDir = mkdtempSync(join(tmpdir(), 'clowder-install-realwt-'));
  const impostorDir = mkdtempSync(join(tmpdir(), 'clowder-install-impostor-'));

  try {
    // Create a real victim repo with a real worktree
    writeFileSync(join(victimRepo, 'README.md'), 'victim\n', 'utf8');
    spawnSync('git', ['init', '-b', 'main'], { cwd: victimRepo, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: victimRepo, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: victimRepo, encoding: 'utf8' });
    spawnSync('git', ['add', '.'], { cwd: victimRepo, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: victimRepo, encoding: 'utf8' });
    const wtResult = spawnSync('git', ['worktree', 'add', realWorktreeDir, '-b', 'wt-branch'], {
      cwd: victimRepo,
      encoding: 'utf8',
    });
    if (wtResult.status !== 0) {
      // Skip test if git worktree is not supported
      return;
    }

    // Find the worktree registration name
    const wtBasename = basename(realWorktreeDir);
    const worktreeRegDir = join(victimRepo, '.git', 'worktrees', wtBasename);

    // Impostor: forged .git pointing at the victim's real worktree registration
    writeFileSync(join(impostorDir, '.git'), `gitdir: ${worktreeRegDir}\n`, 'utf8');
    writeFileSync(join(impostorDir, 'package.json'), '{"name":"clowder-ai"}\n', 'utf8');
    mkdirSync(join(impostorDir, 'scripts'), { recursive: true });
    writeFileSync(join(impostorDir, 'scripts', 'install.sh'), '', 'utf8');

    const output = runSourceOnlySnippet(`
PROJECT_DIR="${impostorDir}"
printf '%s' "$(resolve_provider_profiles_dir)"
`);

    const victimCatCafe = join(realpathSync(victimRepo), '.cat-cafe');
    assert.notEqual(output, victimCatCafe, 'Must NOT write profiles to victim repo (forged .git)');
    assert.equal(output, join(impostorDir, '.cat-cafe'), 'Must stay local when gitdir back-ref does not match');
  } finally {
    // Clean up worktree first, then repos
    spawnSync('git', ['worktree', 'remove', '--force', realWorktreeDir], { cwd: victimRepo });
    rmSync(realWorktreeDir, { recursive: true, force: true });
    rmSync(victimRepo, { recursive: true, force: true });
    rmSync(impostorDir, { recursive: true, force: true });
  }
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
