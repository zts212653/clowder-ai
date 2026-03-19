import test from 'node:test';

import {
  addWorktree,
  assert,
  basename,
  initGitRepo,
  join,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  runSourceOnlySnippet,
  spawnSync,
  symlinkSync,
  tmpdir,
  writeFileSync,
} from './install-script-test-helpers.js';

function withRepoWorktree(repoPrefix, worktreePrefix, branchName, callback) {
  const repoRoot = mkdtempSync(join(tmpdir(), repoPrefix));
  const worktreeRoot = join(tmpdir(), `${worktreePrefix}-${Date.now()}`);

  try {
    initGitRepo(repoRoot);
    addWorktree(repoRoot, worktreeRoot, branchName);
    callback({ repoRoot, worktreeRoot, canonicalRepoRoot: realpathSync(repoRoot) });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
}

test('resolve_provider_profiles_dir uses the canonical repo root for git worktrees', () => {
  withRepoWorktree(
    'clowder-install-profiles-root-',
    'clowder-install-profiles-worktree',
    'feature/profiles-root',
    ({ canonicalRepoRoot, worktreeRoot }) => {
      const output = runSourceOnlySnippet(`
PROJECT_DIR="${worktreeRoot}"
PROJECT_ALLOWED_ROOTS="${canonicalRepoRoot}"
unset PROJECT_ALLOWED_ROOTS_APPEND
printf '%s' "$(resolve_provider_profiles_dir)"
`);

      assert.equal(output, join(canonicalRepoRoot, '.cat-cafe'));
    },
  );
});

test('resolve_provider_profiles_dir stays local when the canonical repo root is outside PROJECT_ALLOWED_ROOTS', () => {
  withRepoWorktree(
    'clowder-install-profiles-allowlist-root-',
    'clowder-install-profiles-allowlist-worktree',
    'feature/profiles-allowlist',
    ({ worktreeRoot }) => {
      const output = runSourceOnlySnippet(`
PROJECT_DIR="${worktreeRoot}"
PROJECT_ALLOWED_ROOTS="/opt/allowed-only"
unset PROJECT_ALLOWED_ROOTS_APPEND
printf '%s' "$(resolve_provider_profiles_dir)"
`);

      assert.equal(output, join(worktreeRoot, '.cat-cafe'));
    },
  );
});

test('resolve_provider_profiles_dir accepts non-canonical allowlist roots that resolve to the repo root', () => {
  withRepoWorktree(
    'clowder-install-profiles-normalized-root-',
    'clowder-install-profiles-normalized-worktree',
    'feature/profiles-normalized-root',
    ({ canonicalRepoRoot, worktreeRoot }) => {
      const nonCanonicalAllowedRoot = `${canonicalRepoRoot}/../${basename(canonicalRepoRoot)}`;
      const output = runSourceOnlySnippet(`
PROJECT_DIR="${worktreeRoot}"
PROJECT_ALLOWED_ROOTS="${nonCanonicalAllowedRoot}"
unset PROJECT_ALLOWED_ROOTS_APPEND
printf '%s' "$(resolve_provider_profiles_dir)"
`);

      assert.equal(output, join(canonicalRepoRoot, '.cat-cafe'));
    },
  );
});

test('resolve_provider_profiles_dir rejects symlink-only allowlist aliases that runtime would not match', () => {
  const aliasBase = mkdtempSync(join(tmpdir(), 'clowder-install-profiles-symlink-alias-'));

  try {
    withRepoWorktree(
      'clowder-install-profiles-symlink-root-',
      'clowder-install-profiles-symlink-worktree',
      'feature/profiles-symlink-root',
      ({ canonicalRepoRoot, worktreeRoot }) => {
        const aliasRoot = join(aliasBase, 'repo-alias');
        symlinkSync(canonicalRepoRoot, aliasRoot);

        const output = runSourceOnlySnippet(`
PROJECT_DIR="${worktreeRoot}"
PROJECT_ALLOWED_ROOTS="${aliasRoot}"
unset PROJECT_ALLOWED_ROOTS_APPEND
printf '%s' "$(resolve_provider_profiles_dir)"
`);

        assert.equal(output, join(worktreeRoot, '.cat-cafe'));
      },
    );
  } finally {
    rmSync(aliasBase, { recursive: true, force: true });
  }
});

test('provider-profile sharing honors PROJECT_ALLOWED_ROOTS replacement mode', () => {
  const output = runSourceOnlySnippet(`
PROJECT_ALLOWED_ROOTS="/opt/allowed-only"
unset PROJECT_ALLOWED_ROOTS_APPEND
if provider_profiles_candidate_root_is_allowed "/workspace/example-repo"; then
  printf 'allowed'
else
  printf 'blocked'
fi
`);

  assert.equal(output, 'blocked');
});

test('resolve_provider_profiles_dir stays local for submodules (not the parent repo)', () => {
  const parentRepo = mkdtempSync(join(tmpdir(), 'clowder-install-parent-'));
  const childDir = join(parentRepo, 'vendor', 'child');

  try {
    initGitRepo(parentRepo, 'parent\n');

    mkdirSync(childDir, { recursive: true });
    initGitRepo(childDir, 'child\n');

    const submoduleResult = spawnSync('git', ['submodule', 'add', childDir, 'vendor/child'], {
      cwd: parentRepo,
      encoding: 'utf8',
    });
    if (submoduleResult.status !== 0) {
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
    initGitRepo(outerRepo, 'outer\n');
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
    initGitRepo(victimRepo, 'victim\n');
    addWorktree(victimRepo, realWorktreeDir, 'wt-branch');

    const worktreeRegistryDir = join(victimRepo, '.git', 'worktrees', basename(realWorktreeDir));
    writeFileSync(join(impostorDir, '.git'), `gitdir: ${worktreeRegistryDir}\n`, 'utf8');
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
    rmSync(realWorktreeDir, { recursive: true, force: true });
    rmSync(victimRepo, { recursive: true, force: true });
    rmSync(impostorDir, { recursive: true, force: true });
  }
});
