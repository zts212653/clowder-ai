import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const HOOK = resolve(process.cwd(), '.githooks/pre-commit');

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

export function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pre-commit-hygiene-'));
  // The guard cases model feature work regardless of the user's default branch.
  git(dir, 'init', '-q', '--initial-branch=fixture-feature');
  git(dir, 'config', 'user.email', 'test@cat.cafe');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), '# fixture');
  writeFileSync(join(dir, '.gitignore'), '.env\n.env.local\n.mcp.json\n*.local\n');
  writeBiomeLockfile(dir, '2.4.1');
  git(dir, 'add', 'README.md', '.gitignore', 'pnpm-lock.yaml');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function writeBiomeLockfile(dir, version) {
  writeFileSync(
    join(dir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'

packages:
  '@biomejs/biome@${version}':
    resolution: {integrity: sha512-fixture}
`,
    'utf8',
  );
}

function installPnpmStub(dir) {
  const binDir = join(dir, '.test-bin');
  const logPath = join(dir, '.pnpm-log');
  mkdirSync(binDir, { recursive: true });
  const biomePath = join(dir, 'node_modules', '.bin', 'biome');
  mkdirSync(dirname(biomePath), { recursive: true });
  writeFileSync(
    biomePath,
    `#!/bin/sh
echo "$0 $@" >> "$CAT_CAFE_TEST_PNPM_LOG"
if [ -n "$CAT_CAFE_TEST_SNAPSHOT_FILES" ]; then
  find . -type f -print | sort > "$CAT_CAFE_TEST_SNAPSHOT_FILES"
fi
if [ -n "$CAT_CAFE_TEST_REAL_BIOME" ]; then
  exec "$CAT_CAFE_TEST_REAL_BIOME" "$@"
fi
if [ "$CAT_CAFE_TEST_FAIL_FULL_BIOME" = "1" ]; then
  exit 1
fi
if find . \\( -name '*.js' -o -name '*.jsx' -o -name '*.ts' -o -name '*.tsx' \\) -type f -exec grep -q 'BIOME_FAIL' {} \\; -print -quit | grep -q .; then
  echo "fixture biome found BIOME_FAIL" >&2
  exit 1
fi
exit 0
`,
    'utf8',
  );
  chmodSync(biomePath, 0o755);
  writeFileSync(
    join(binDir, 'pnpm'),
    `#!/bin/sh
echo "pnpm $@" >> "$CAT_CAFE_TEST_PNPM_LOG"
if [ "$1" = "run" ] && [ "$2" = "check:biome-version" ]; then
  lockfile="pnpm-lock.yaml"
  if [ "$3" = "--" ] && [ "$4" = "--lockfile" ] && [ -n "$5" ]; then
    lockfile="$5"
  fi
  if grep -q "@biomejs/biome@2.4.1" "$lockfile"; then
    exit 0
  fi
  echo "fixture Biome version mismatch from $lockfile" >&2
  exit 1
fi
if [ "$CAT_CAFE_TEST_FAIL_PNPM_EXEC_BIOME" = "1" ] && [ "$1" = "exec" ] && [ "$2" = "biome" ] && [ "$3" = "check" ] && [ "$4" = "." ]; then
  echo "fixture pnpm exec biome unavailable" >&2
  exit 127
fi
if [ "$CAT_CAFE_TEST_FAIL_FULL_BIOME" = "1" ] && [ "$1" = "exec" ] && [ "$2" = "biome" ] && [ "$3" = "check" ] && [ "$4" = "." ]; then
  exit 1
fi
if [ "$1" = "exec" ] && [ "$2" = "biome" ] && [ "$3" = "check" ] && [ "$4" = "." ]; then
  if find . \\( -name '*.js' -o -name '*.jsx' -o -name '*.ts' -o -name '*.tsx' \\) -type f -exec grep -q 'BIOME_FAIL' {} \\; -print -quit | grep -q .; then
    echo "fixture biome found BIOME_FAIL" >&2
    exit 1
  fi
fi
exit 0
`,
    'utf8',
  );
  chmodSync(join(binDir, 'pnpm'), 0o755);
  writeFileSync(logPath, '', 'utf8');
  return { binDir, logPath };
}

export function seedBiomeInstall(dir) {
  const pkgPath = join(dir, 'node_modules', '@biomejs', 'biome', 'package.json');
  mkdirSync(dirname(pkgPath), { recursive: true });
  writeFileSync(pkgPath, '{"name":"@biomejs/biome","version":"2.4.1"}\n', 'utf8');
}

export function expectedIndexBiomeLog(dir) {
  return `${join(realpathSync(dir), 'node_modules', '.bin', 'biome')} check . --diagnostic-level=error`;
}

export function expectedNormalBiomeGuardLog(dir) {
  return ['pnpm run check:biome-version -- --lockfile <index-snapshot>/pnpm-lock.yaml', expectedIndexBiomeLog(dir)];
}

// B-3 (2026-07-16): staged-scope contract — tier b scans only staged lintable
// paths inside the index snapshot (xargs appends the file list).
export function expectedStagedBiomeLog(dir, files) {
  return `${join(realpathSync(dir), 'node_modules', '.bin', 'biome')} check --files-ignore-unknown=true --no-errors-on-unmatched --diagnostic-level=error -- ${files.join(' ')}`;
}

export function expectedStagedBiomeGuardLog(dir, files) {
  return [
    'pnpm run check:biome-version -- --lockfile <index-snapshot>/pnpm-lock.yaml',
    expectedStagedBiomeLog(dir, files),
  ];
}

// tier a (no lintable staged): the hook must not invoke pnpm/biome at all.
export function expectedTierASkipLog() {
  return [];
}

export function normalizeHookLog(lines) {
  return lines.map((line) =>
    line
      .replace(
        /--lockfile \S*cat-cafe-precommit-index\.[^/\s]+\/pnpm-lock\.yaml/,
        '--lockfile <index-snapshot>/pnpm-lock.yaml',
      )
      .replace(/--lockfile \S*cat-cafe-staged-lockfile\.\S+/, '--lockfile <staged-lockfile>'),
  );
}

export function stageAndHook(dir, relpath, content = 'x', extraEnv = {}) {
  const abs = join(dir, relpath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, 'add', '-f', relpath);
  return runHook(dir, extraEnv);
}

export function runHook(dir, extraEnv = {}) {
  const { binDir, logPath } = installPnpmStub(dir);
  const result = spawnSync('bash', [HOOK], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAT_CAFE_TEST_PNPM_LOG: logPath,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  });
  const pnpmLog = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  return { ...result, pnpmLog };
}

export function stageWithUnstagedOverlapAndHook(dir, relpath, stagedContent, unstagedContent) {
  const abs = join(dir, relpath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, stagedContent);
  git(dir, 'add', relpath);
  writeFileSync(abs, unstagedContent);
  return runHook(dir);
}

export function stageWithUntrackedAndHook(
  dir,
  stagedRelpath,
  stagedContent,
  untrackedRelpath,
  untrackedContent,
  extraEnv = {},
) {
  const stagedAbs = join(dir, stagedRelpath);
  const untrackedAbs = join(dir, untrackedRelpath);
  mkdirSync(dirname(stagedAbs), { recursive: true });
  mkdirSync(dirname(untrackedAbs), { recursive: true });
  writeFileSync(stagedAbs, stagedContent);
  git(dir, 'add', '-f', stagedRelpath);
  writeFileSync(untrackedAbs, untrackedContent);
  return runHook(dir, extraEnv);
}
