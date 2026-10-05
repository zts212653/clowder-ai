import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const NAMED_ALPHA_PORTS = '5311,5312,5411,5511,15397';

/** Actual Git/worktree and launcher fixture; process/document stores are not simulated deployments. */
export function namedAlphaFixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'named-alpha-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mainRoot = join(directory, 'cat-cafe');
  const alphaRoot = join(directory, 'cat-cafe-alpha-f290-communication');
  const branch = 'alpha/f290-communication-main-sync';
  const remote = join(directory, 'remote.git');
  const home = join(directory, 'home');
  mkdirSync(mainRoot);
  mkdirSync(home);
  for (const entry of [
    'scripts/alpha-worktree.sh',
    'scripts/start-dev.sh',
    'scripts/download-source-overrides.sh',
    'scripts/lib/node-runtime-guard.sh',
    'scripts/lib/quickstart-freshness.sh',
    'scripts/lib/alpha-redis-identity.sh',
    'scripts/lib/redis-rdb-first.sh',
    'scripts/lib/alpha-coordinates.mjs',
    'scripts/lib/alpha-named-launch.sh',
    'scripts/lib/alpha-redis-process.mjs',
    'scripts/lib/alpha-redis-leases.mjs',
    'scripts/lib/process-identity.mjs',
    'scripts/lib/process-tree.mjs',
    'packages/api/src/config/alpha-coordinates.ts',
  ]) {
    if (!existsSync(join(SOURCE_ROOT, entry))) continue;
    mkdirSync(dirname(join(mainRoot, entry)), { recursive: true });
    cpSync(join(SOURCE_ROOT, entry), join(mainRoot, entry));
  }
  writeFileSync(
    join(mainRoot, '.gitignore'),
    '.env\n.env.local\n.cat-cafe/\nnode_modules/\ndist/\npackages/web/.env.local\n*.log\n',
  );
  writeFileSync(join(mainRoot, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
  for (const name of ['web', 'api', 'mcp-server', 'shared', 'collective-service']) {
    mkdirSync(join(mainRoot, 'packages', name), { recursive: true });
    writeFileSync(join(mainRoot, 'packages', name, 'package.json'), '{}\n');
  }
  const git = (args, cwd = mainRoot) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Named Alpha Fixture']);
  git(['config', 'user.email', 'named-alpha@example.invalid']);
  git(['config', 'core.hooksPath', '/dev/null']);
  git(['add', '.']);
  git(['commit', '-m', 'main fixture']);
  git(['init', '--bare', remote]);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'main']);
  git(['fetch', 'origin', 'main']);
  git(['worktree', 'add', '-b', branch, alphaRoot, 'origin/main']);
  const head = git(['rev-parse', 'HEAD'], alphaRoot);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const calls = join(directory, 'calls.log');
  writeFileSync(calls, '');
  writeFileSync(
    join(bin, 'pnpm'),
    '#!/bin/bash\nset -eu\nprintf "pnpm %s\\n" "$*" >> "$ALPHA_TEST_CALLS"\ntarget="$PWD"\nif [ "$1" = "-C" ]; then target="$2"; shift 2; fi\nif [ "$1" = install ]; then\n mkdir -p "$target/node_modules" "$target/packages/web/node_modules/next" "$target/packages/api/node_modules/tsx" "$target/packages/mcp-server/node_modules/typescript"\n touch "$target/packages/web/node_modules/next/package.json" "$target/packages/api/node_modules/tsx/package.json" "$target/packages/mcp-server/node_modules/typescript/package.json"\nelse\n mkdir -p "$target/dist"; printf fixture > "$target/dist/index.js"\nfi\n',
    { mode: 0o755 },
  );
  const lsofPath = execFileSync('which', ['lsof'], { encoding: 'utf8' }).trim();
  for (const command of ['redis-cli', 'lsof']) {
    const cwdProbe = command === 'lsof' ? `case "$*" in *"-d cwd"*) exec ${lsofPath} "$@" ;; esac\n` : '';
    writeFileSync(
      join(bin, command),
      `#!/bin/sh\nprintf '${command} %s\\n' "$*" >> "$ALPHA_TEST_CALLS"\n${cwdProbe}exit 1\n`,
      { mode: 0o755 },
    );
  }
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    TERM: 'xterm',
    CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
    ALPHA_TEST_CALLS: calls,
  };
  const run = (args, options = {}) =>
    spawnSync('bash', [join(mainRoot, 'scripts/alpha-worktree.sh'), ...args], {
      cwd: mainRoot,
      encoding: 'utf8',
      env: { ...env, ...options.env },
      timeout: 30_000,
    });
  function captureChild() {
    // The launcher must load this actual main revision through its normal ff-only path.
    writeFileSync(
      join(mainRoot, 'scripts/start-dev.sh'),
      "#!/bin/sh\nnode -e 'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CAT_CAFE_|COLLECTIVE_|REDIS_|FRONTEND_|API_SERVER_|NEXT_PUBLIC_|WORKTREE_|PREVIEW_)/.test(k)))))'\n",
      { mode: 0o755 },
    );
    git(['add', 'scripts/start-dev.sh']);
    git(['commit', '-m', 'capture child environment']);
    git(['push', 'origin', 'main']);
  }
  function preparedBuilds(revision = git(['rev-parse', 'HEAD'], alphaRoot)) {
    for (const name of ['shared', 'api', 'mcp-server']) {
      mkdirSync(join(alphaRoot, 'packages', name, 'dist'), { recursive: true });
      writeFileSync(join(alphaRoot, 'packages', name, 'dist/index.js'), 'fixture\n');
      writeFileSync(join(alphaRoot, 'packages', name, 'dist/.build-commit'), revision);
    }
  }
  return {
    directory,
    mainRoot,
    alphaRoot,
    branch,
    head,
    git,
    env,
    run,
    calls,
    captureChild,
    preparedBuilds,
    childEnvironment(result) {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout.trim().split('\n').at(-1));
    },
    readCalls: () => readFileSync(calls, 'utf8'),
  };
}
