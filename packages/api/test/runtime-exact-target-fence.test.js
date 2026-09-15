import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { daemonStatePaths, writeDaemonState } from '../../../scripts/lib/daemon-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const runtimeScriptSource = join(repoRoot, 'scripts', 'runtime-worktree.sh');
const quickstartLibSource = join(repoRoot, 'scripts', 'lib', 'quickstart-freshness.sh');
const nodeRuntimeGuardSource = join(repoRoot, 'scripts', 'lib', 'node-runtime-guard.sh');
const runtimeRevisionTemplateSource = join(repoRoot, '.cat-cafe-runtime-revision');
const gitAttributesSource = join(repoRoot, '.gitattributes');
const tempRoots = [];
const helperProcesses = [];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function seedRuntimePrerequisites(runtimeDir, revision) {
  const artifactPaths = [
    ['shared', 'dist', 'index.js'],
    ['api', 'dist', 'index.js'],
    ['mcp-server', 'dist', 'index.js'],
    ['web', '.next', 'BUILD_ID'],
  ];
  for (const [pkg, dir, file] of artifactPaths) {
    mkdirSync(join(runtimeDir, 'packages', pkg, dir), { recursive: true });
    writeFileSync(join(runtimeDir, 'packages', pkg, dir, file), 'fixture\n');
    writeFileSync(join(runtimeDir, 'packages', pkg, dir, '.build-commit'), `${revision}\n`);
  }
  mkdirSync(join(runtimeDir, 'node_modules', '.pnpm'), { recursive: true });
  mkdirSync(join(runtimeDir, 'packages', 'web', 'node_modules', 'next'), { recursive: true });
  writeFileSync(join(runtimeDir, 'packages', 'web', 'node_modules', 'next', 'package.json'), '{}');
  mkdirSync(join(runtimeDir, 'packages', 'api', 'node_modules', 'tsx'), { recursive: true });
  writeFileSync(join(runtimeDir, 'packages', 'api', 'node_modules', 'tsx', 'package.json'), '{}');
  mkdirSync(join(runtimeDir, 'packages', 'mcp-server', 'node_modules', 'typescript'), { recursive: true });
  writeFileSync(join(runtimeDir, 'packages', 'mcp-server', 'node_modules', 'typescript', 'package.json'), '{}');
}

function createFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  tempRoots.push(root);
  const projectDir = join(root, 'project');
  const runtimeDir = join(root, 'runtime');
  const remoteDir = join(root, 'remote.git');
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const startMarker = join(root, 'started.txt');
  const pnpmLog = join(root, 'pnpm.log');
  mkdirSync(join(projectDir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  for (const pkg of ['shared', 'api', 'mcp-server', 'web']) {
    mkdirSync(join(projectDir, 'packages', pkg), { recursive: true });
  }
  writeExecutable(join(projectDir, 'scripts', 'runtime-worktree.sh'), readFileSync(runtimeScriptSource, 'utf8'));
  writeExecutable(
    join(projectDir, 'scripts', 'daemon-state.mjs'),
    readFileSync(join(repoRoot, 'scripts', 'daemon-state.mjs'), 'utf8'),
  );
  writeFileSync(
    join(projectDir, 'scripts', 'lib', 'quickstart-freshness.sh'),
    readFileSync(quickstartLibSource, 'utf8'),
  );
  writeFileSync(
    join(projectDir, 'scripts', 'lib', 'node-runtime-guard.sh'),
    readFileSync(nodeRuntimeGuardSource, 'utf8'),
  );
  for (const file of [
    'daemon-state.mjs',
    'process-identity.mjs',
    'daemon-health-probe.mjs',
    'daemon-stop-operation.mjs',
    'daemon-stop-record.mjs',
    'daemon-stop-claim.mjs',
    'process-tree.mjs',
  ]) {
    writeFileSync(
      join(projectDir, 'scripts', 'lib', file),
      readFileSync(join(repoRoot, 'scripts', 'lib', file), 'utf8'),
    );
  }
  writeExecutable(
    join(projectDir, 'scripts', 'start-dev.sh'),
    '#!/bin/bash\nprintf "%s\\n" "$PWD" > "$RUNTIME_TEST_START_MARKER"\n' +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture shell expands this placeholder.
      'if [ -n "${RUNTIME_TEST_ACTIVE_PID:-}" ]; then kill "$RUNTIME_TEST_ACTIVE_PID"; fi\n',
  );
  git(projectDir, ['init', '-b', 'main']);
  git(projectDir, ['config', 'user.email', 'test@example.com']);
  git(projectDir, ['config', 'user.name', 'Test User']);
  git(projectDir, ['add', '.']);
  git(projectDir, ['commit', '-m', 'initial runtime']);
  git(root, ['init', '--bare', remoteDir]);
  git(projectDir, ['remote', 'add', 'origin', remoteDir]);
  git(projectDir, ['push', '-u', 'origin', 'main']);
  git(projectDir, ['worktree', 'add', runtimeDir, '-b', 'runtime/main-sync', 'origin/main']);
  const initialRevision = git(runtimeDir, ['rev-parse', 'HEAD']);
  seedRuntimePrerequisites(runtimeDir, initialRevision);

  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    join(binDir, 'pnpm'),
    `#!/bin/bash
set -euo pipefail
command="$*"
target="$PWD"
if [ "\${1:-}" = "-C" ]; then target="$2"; shift 2; fi
revision="$(git -C "$target" rev-parse HEAD 2>/dev/null || printf 'non-git')"
printf '%s|%s\\n' "$revision" "$command" >> "${pnpmLog}"
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "build" ]; then
  case "$target" in
    */packages/shared) mkdir -p "$target/dist"; : > "$target/dist/index.js" ;;
    */packages/api) mkdir -p "$target/dist"; : > "$target/dist/index.js" ;;
    */packages/mcp-server) mkdir -p "$target/dist"; : > "$target/dist/index.js" ;;
    */packages/web) mkdir -p "$target/.next"; printf 'fixture\\n' > "$target/.next/BUILD_ID" ;;
  esac
fi
`,
  );
  return { root, projectDir, runtimeDir, remoteDir, binDir, homeDir, startMarker, pnpmLog, initialRevision };
}

function advanceRemote(fixture) {
  writeFileSync(join(fixture.projectDir, 'remote-advance.txt'), `${Date.now()}\n`);
  git(fixture.projectDir, ['add', 'remote-advance.txt']);
  git(fixture.projectDir, ['commit', '-m', 'remote advances']);
  git(fixture.projectDir, ['push', 'origin', 'main']);
  return git(fixture.projectDir, ['rev-parse', 'HEAD']);
}

function installFetchFreezeProbe(fixture) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const fetchedMarker = join(fixture.root, 'first-fetch-complete');
  const remoteAdvancedMarker = join(fixture.root, 'remote-advanced');
  const fetchLog = join(fixture.root, 'fetch.log');
  const mergeRefLog = join(fixture.root, 'merge-ref.log');
  const publisherDir = join(fixture.root, 'publisher');
  git(fixture.root, ['clone', '--branch', 'main', fixture.remoteDir, publisherDir]);
  git(publisherDir, ['config', 'user.email', 'publisher@example.com']);
  git(publisherDir, ['config', 'user.name', 'Remote Publisher']);

  writeExecutable(
    join(fixture.binDir, 'git'),
    `#!/bin/bash
set -euo pipefail
case " $* " in
  *" fetch origin "*)
    printf 'fetch\n' >> "${fetchLog}"
    if [ ! -e "${fetchedMarker}" ]; then
      "${realGit}" "$@"
      : > "${fetchedMarker}"
      attempts=0
      while [ ! -e "${remoteAdvancedMarker}" ] && [ "$attempts" -lt 200 ]; do
        sleep 0.01
        attempts=$((attempts + 1))
      done
      [ -e "${remoteAdvancedMarker}" ] || exit 91
      exit 0
    fi
    ;;
  *" merge --ff-only "*)
    "${realGit}" -C "${fixture.projectDir}" for-each-ref --format='%(refname)' refs/cat-cafe-runtime-target/ > "${mergeRefLog}"
    ;;
esac
exec "${realGit}" "$@"
`,
  );

  const publisher = spawn(
    process.execPath,
    [
      '-e',
      `const {execFileSync}=require('node:child_process');
const {existsSync,writeFileSync}=require('node:fs');
const sleeper=new Int32Array(new SharedArrayBuffer(4));
while(!existsSync(process.argv[3])) Atomics.wait(sleeper,0,0,10);
writeFileSync(process.argv[2]+'/remote-b.txt','B\\n');
execFileSync(process.argv[1],['add','remote-b.txt'],{cwd:process.argv[2]});
execFileSync(process.argv[1],['commit','-m','remote advances to B'],{cwd:process.argv[2]});
execFileSync(process.argv[1],['push','origin','main'],{cwd:process.argv[2]});
writeFileSync(process.argv[4],'done\\n');`,
      realGit,
      publisherDir,
      fetchedMarker,
      remoteAdvancedMarker,
    ],
    { stdio: 'ignore' },
  );
  helperProcesses.push(publisher);
  tempRoots.push(publisherDir);
  return { fetchLog, mergeRefLog, publisher };
}

function startRuntime(fixture, args = [], options = {}) {
  const { action = 'start', activePid, apiPort = 19876, runInstall = false, extraEnv = {} } = options;
  return spawnSync(
    'bash',
    [
      join(fixture.projectDir, 'scripts', 'runtime-worktree.sh'),
      action,
      '--dir',
      fixture.runtimeDir,
      ...(runInstall ? [] : ['--no-install']),
      ...args,
    ],
    {
      cwd: fixture.projectDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fixture.homeDir,
        CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
        API_SERVER_PORT: String(apiPort),
        FRONTEND_PORT: '19875',
        PREVIEW_GATEWAY_PORT: '0',
        PATH: `${fixture.binDir}:${process.env.PATH}`,
        RUNTIME_TEST_START_MARKER: fixture.startMarker,
        ...(activePid ? { RUNTIME_TEST_ACTIVE_PID: String(activePid) } : {}),
        ...extraEnv,
      },
    },
  );
}

async function seedManagedRuntimeDaemon(fixture) {
  const launchToken = `runtime-target-${Date.now()}`;
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', '--', `--cat-cafe-daemon-token=${launchToken}`],
    { cwd: fixture.runtimeDir, stdio: 'ignore' },
  );
  helperProcesses.push(child);
  await once(child, 'spawn');
  const paths = daemonStatePaths({
    homeDir: fixture.homeDir,
    projectRoot: fixture.runtimeDir,
    deploymentId: 'runtime',
  });
  writeDaemonState({
    paths,
    pid: child.pid,
    projectRoot: fixture.runtimeDir,
    deploymentId: 'runtime',
    launchToken,
    logFile: join(fixture.runtimeDir, 'cat-cafe-daemon.log'),
    ports: { api: 19876 },
  });
  return child;
}

function dirtyTrackedRuntimeSourceAndInvalidateApiStamp(fixture) {
  const runtimeSource = join(fixture.runtimeDir, 'scripts', 'start-dev.sh');
  writeFileSync(runtimeSource, `${readFileSync(runtimeSource, 'utf8')}\n# uncommitted runtime source\n`);
  rmSync(join(fixture.runtimeDir, 'packages', 'api', 'dist', '.build-commit'));
}

async function startActiveApiListener() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'const net=require("node:net");const server=net.createServer();' +
        'server.listen(0,"127.0.0.1",()=>process.stdout.write(String(server.address().port)+"\\n"));' +
        'process.on("SIGTERM",()=>server.close(()=>process.exit(0)));',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const [chunk] = await Promise.race([
    once(child.stdout, 'data'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('active API listener did not start')), 3000)),
  ]);
  const port = Number.parseInt(String(chunk).trim(), 10);
  if (!Number.isInteger(port)) throw new Error(`invalid active API listener port: ${String(chunk)}`);
  return { child, port };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopListener(child) {
  if (!processExists(child.pid)) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (processExists(child.pid)) child.kill('SIGKILL');
}

afterEach(() => {
  while (helperProcesses.length > 0) {
    const child = helperProcesses.pop();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  while (tempRoots.length > 0) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe('F313 D9 exact runtime target fence', () => {
  it('writes non-Git bundle identity from Git archive provenance instead of caller input', () => {
    assert.equal(existsSync(runtimeRevisionTemplateSource), true, 'runtime revision archive template must exist');
    assert.match(
      readFileSync(gitAttributesSource, 'utf8'),
      /^\.cat-cafe-runtime-revision\s+export-subst$/mu,
      'Git archive must expand the runtime revision template',
    );

    const root = mkdtempSync(join(tmpdir(), 'runtime-target-archive-'));
    tempRoots.push(root);
    writeFileSync(join(root, '.gitattributes'), readFileSync(gitAttributesSource, 'utf8'));
    writeFileSync(join(root, '.cat-cafe-runtime-revision'), readFileSync(runtimeRevisionTemplateSource, 'utf8'));
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test User']);
    git(root, ['add', '.gitattributes', '.cat-cafe-runtime-revision']);
    git(root, ['commit', '-m', 'archive revision fixture']);
    const expectedRevision = git(root, ['rev-parse', 'HEAD']);
    const archivePath = join(root, 'runtime.tar');
    execFileSync('git', ['archive', '--format=tar', '-o', archivePath, 'HEAD'], { cwd: root, stdio: 'ignore' });
    const archivedRevision = execFileSync('tar', ['-xOf', archivePath, '.cat-cafe-runtime-revision'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    assert.equal(archivedRevision, expectedRevision);
  });

  it('rejects a malformed explicit target before merge, build, or start', () => {
    for (const args of [['--expected-target-sha', 'deadbeef']]) {
      const fixture = createFixture('runtime-target-invalid');
      const before = git(fixture.runtimeDir, ['rev-parse', 'HEAD']);
      const result = startRuntime(fixture, args);
      assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /expected-target-sha.*full.*SHA/i);
      assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), before);
      assert.equal(existsSync(fixture.pnpmLog), false, 'rejection must precede build');
      assert.equal(existsSync(fixture.startMarker), false, 'rejection must precede process start');
    }
  });

  it('rejects the retired force option before fetch, merge, build, or start', () => {
    const fixture = createFixture('runtime-target-force-retired');
    const result = startRuntime(fixture, ['--force']);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /force is retired/i);
    assert.equal(existsSync(fixture.pnpmLog), false);
    assert.equal(existsSync(fixture.startMarker), false);
  });

  it('derives the default target from the fetched remote and carries it through build and start', () => {
    const fixture = createFixture('runtime-target-default');
    const target = advanceRemote(fixture);

    const result = startRuntime(fixture);

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), target);
    assert.equal(readFileSync(fixture.startMarker, 'utf8').trim(), realpathSync(fixture.runtimeDir));
  });

  it('returns already-running for the same managed daemon without fetching or touching its tree', async () => {
    const fixture = createFixture('runtime-target-already-running');
    const daemon = await seedManagedRuntimeDaemon(fixture);
    git(fixture.projectDir, ['remote', 'set-url', 'origin', join(fixture.root, 'missing-remote.git')]);

    const result = startRuntime(fixture);

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /already running|已运行/i);
    assert.equal(processExists(daemon.pid), true);
    assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), fixture.initialRevision);
    assert.equal(existsSync(fixture.pnpmLog), false);
    assert.equal(existsSync(fixture.startMarker), false);
  });

  it('checks an explicit target against an already-running managed runtime without fetching or relaunching', async () => {
    const fixture = createFixture('runtime-target-already-running-assertion');
    const daemon = await seedManagedRuntimeDaemon(fixture);
    git(fixture.projectDir, ['remote', 'set-url', 'origin', join(fixture.root, 'missing-remote.git')]);

    const result = startRuntime(fixture, ['--expected-target-sha', 'f'.repeat(40)]);

    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /runtime tree HEAD.*does not equal.*expected target/i);
    assert.equal(processExists(daemon.pid), true, 'the managed daemon must remain alive');
    assert.equal(existsSync(fixture.pnpmLog), false, 'the assertion must not fetch or build');
    assert.equal(existsSync(fixture.startMarker), false, 'the assertion must not relaunch');
  });

  it('fetches once and keeps target A frozen when the remote advances to B during the same invocation', () => {
    const fixture = createFixture('runtime-target-frozen-once');
    const targetA = advanceRemote(fixture);
    const probe = installFetchFreezeProbe(fixture);

    const result = startRuntime(fixture);

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const targetB = git(fixture.remoteDir, ['rev-parse', 'main']);
    assert.notEqual(targetB, targetA, 'the fixture must advance the remote after the first fetch');
    assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), targetA);
    assert.equal(readFileSync(probe.fetchLog, 'utf8').trim().split('\n').length, 1, 'one invocation gets one fetch');
    assert.match(
      readFileSync(probe.mergeRefLog, 'utf8'),
      /^refs\/cat-cafe-runtime-target\/\d+$/mu,
      'the invocation-private ref must keep target A reachable through the exact merge',
    );
    assert.equal(
      git(fixture.projectDir, ['for-each-ref', '--format=%(refname)', 'refs/cat-cafe-runtime-target/']),
      '',
      'the invocation-private ref must be cleaned after the lifecycle command',
    );
    assert.ok(probe.publisher.pid, 'the remote publisher helper must have started');
  });

  it('rejects fetched remote drift before mutating the preserved runtime tree', () => {
    const fixture = createFixture('runtime-target-remote-drift');
    advanceRemote(fixture);
    const result = startRuntime(fixture, ['--expected-target-sha', fixture.initialRevision]);
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /fetched.*does not equal.*expected/i);
    assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), fixture.initialRevision);
    assert.equal(existsSync(fixture.pnpmLog), false);
    assert.equal(existsSync(fixture.startMarker), false);
  });

  it('rejects an explicit remote mismatch before ending an owned managed daemon', async () => {
    const fixture = createFixture('runtime-target-live-remote-mismatch');
    advanceRemote(fixture);
    const daemon = await seedManagedRuntimeDaemon(fixture);

    const result = startRuntime(fixture, ['--expected-target-sha', fixture.initialRevision], { action: 'restart' });

    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /fetched.*does not equal.*expected/i);
    assert.equal(processExists(daemon.pid), true, 'target mismatch must preserve the managed daemon');
    assert.equal(existsSync(fixture.startMarker), false);
  });

  it('refuses an unowned active API on both normal and no-sync paths even when the legacy variable is set', async () => {
    const fixture = createFixture('runtime-target-active-remote-drift');
    advanceRemote(fixture);
    const listener = await startActiveApiListener();
    try {
      const normal = startRuntime(fixture, ['--expected-target-sha', fixture.initialRevision], {
        apiPort: listener.port,
        activePid: listener.child.pid,
        extraEnv: { CAT_CAFE_RUNTIME_RESTART_OK: '1' },
      });
      assert.notEqual(normal.status, 0, `stdout:\n${normal.stdout}\nstderr:\n${normal.stderr}`);
      assert.match(`${normal.stdout}\n${normal.stderr}`, /ownership|managed runtime|归属/i);
      assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), fixture.initialRevision);
      assert.equal(existsSync(fixture.pnpmLog), false, 'remote rejection must precede build');
      assert.equal(existsSync(fixture.startMarker), false, 'remote rejection must precede replacement start');
      assert.equal(processExists(listener.child.pid), true, 'remote rejection must preserve the active API process');

      const recovery = startRuntime(fixture, ['--no-sync', '--expected-target-sha', fixture.initialRevision], {
        apiPort: listener.port,
        activePid: listener.child.pid,
        extraEnv: { CAT_CAFE_RUNTIME_RESTART_OK: '1' },
      });
      assert.notEqual(recovery.status, 0, `stdout:\n${recovery.stdout}\nstderr:\n${recovery.stderr}`);
      assert.match(`${recovery.stdout}\n${recovery.stderr}`, /ownership|managed runtime|归属/i);
      assert.equal(existsSync(fixture.startMarker), false, 'unowned listener must reject before launch');
      assert.equal(
        processExists(listener.child.pid),
        true,
        'legacy variable must not authorize terminating the listener',
      );
    } finally {
      await stopListener(listener.child);
    }
  });

  it('loads only an exact fetched target and verifies every runtime build stamp before start', () => {
    const fixture = createFixture('runtime-target-exact');
    const target = advanceRemote(fixture);
    const result = startRuntime(fixture, ['--expected-target-sha', target]);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), target);
    for (const stamp of [
      ['api', 'dist'],
      ['mcp-server', 'dist'],
      ['web', '.next'],
    ]) {
      assert.equal(
        readFileSync(join(fixture.runtimeDir, 'packages', ...stamp, '.build-commit'), 'utf8').trim(),
        target,
      );
    }
    assert.equal(readFileSync(fixture.startMarker, 'utf8').trim(), realpathSync(fixture.runtimeDir));
  });

  it('syncs a recreated stale runtime branch to the exact target before any install lifecycle runs', () => {
    const fixture = createFixture('runtime-target-init-stale-branch');
    git(fixture.projectDir, ['worktree', 'remove', '--force', fixture.runtimeDir]);
    const target = advanceRemote(fixture);

    const result = startRuntime(fixture, ['--expected-target-sha', target], { runInstall: true });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const installRevisions = readFileSync(fixture.pnpmLog, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => /\|-C .* install(?: |$)/u.test(line))
      .map((line) => line.slice(0, line.indexOf('|')));
    assert.ok(installRevisions.length > 0, 'fixture must observe at least one install lifecycle');
    assert.deepEqual([...new Set(installRevisions)], [target]);
    assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), target);
    assert.equal(readFileSync(fixture.startMarker, 'utf8').trim(), realpathSync(fixture.runtimeDir));
  });

  it('rejects an ahead runtime branch before any install lifecycle runs', () => {
    const fixture = createFixture('runtime-target-ahead-branch');
    writeFileSync(join(fixture.runtimeDir, 'local-ahead.txt'), 'not on the authorized remote\n');
    git(fixture.runtimeDir, ['add', 'local-ahead.txt']);
    git(fixture.runtimeDir, ['commit', '-m', 'local runtime ahead']);

    const result = startRuntime(fixture, ['--expected-target-sha', fixture.initialRevision], { runInstall: true });

    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /diverged from the frozen target/i);
    assert.equal(existsSync(fixture.pnpmLog), false, 'tree mismatch must reject before install lifecycle');
    assert.equal(existsSync(fixture.startMarker), false, 'tree mismatch must reject before process start');
  });

  it('rejects a diverged runtime tree before ending an owned managed daemon', async () => {
    const fixture = createFixture('runtime-target-live-diverged');
    writeFileSync(join(fixture.runtimeDir, 'local-ahead.txt'), 'not on the frozen remote target\n');
    git(fixture.runtimeDir, ['add', 'local-ahead.txt']);
    git(fixture.runtimeDir, ['commit', '-m', 'local runtime diverges']);
    const daemon = await seedManagedRuntimeDaemon(fixture);

    const result = startRuntime(fixture, [], { action: 'restart' });

    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /diverged from the frozen target/i);
    assert.equal(processExists(daemon.pid), true, 'divergence must preserve the managed daemon');
    assert.equal(existsSync(fixture.pnpmLog), false);
    assert.equal(existsSync(fixture.startMarker), false);
  });

  it('rejects no-sync before creating or installing a missing preserved runtime worktree', () => {
    const fixture = createFixture('runtime-target-no-preserved-tree');
    git(fixture.projectDir, ['worktree', 'remove', '--force', fixture.runtimeDir]);

    const result = startRuntime(fixture, ['--no-sync', '--expected-target-sha', fixture.initialRevision], {
      runInstall: true,
    });

    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /no-sync.*existing preserved runtime worktree/i);
    assert.equal(existsSync(fixture.runtimeDir), false, 'rejection must precede checkout creation');
    assert.equal(existsSync(fixture.pnpmLog), false, 'rejection must precede install lifecycle');
    assert.equal(existsSync(fixture.startMarker), false, 'rejection must precede process start');
  });

  it('derives the no-sync target from the preserved exact tree', () => {
    const fixture = createFixture('runtime-target-recovery');
    advanceRemote(fixture);
    const result = startRuntime(fixture, ['--no-sync']);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), fixture.initialRevision);
    assert.equal(existsSync(fixture.pnpmLog), false, 'fresh preserved artifacts must not rebuild');
    assert.equal(readFileSync(fixture.startMarker, 'utf8').trim(), realpathSync(fixture.runtimeDir));
  });

  it('rejects tracked runtime source drift on the explicit no-sync recovery path before build or start', () => {
    const fixture = createFixture('runtime-target-dirty-no-sync');
    dirtyTrackedRuntimeSourceAndInvalidateApiStamp(fixture);

    const result = startRuntime(fixture, ['--no-sync', '--expected-target-sha', fixture.initialRevision]);

    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /runtime worktree has local changes.*frozen target/i);
    assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), fixture.initialRevision);
    assert.equal(existsSync(fixture.pnpmLog), false, 'tracked-source rejection must precede build');
    assert.equal(existsSync(fixture.startMarker), false, 'tracked-source rejection must precede process start');
  });

  it('rejects tracked source drift before ending an owned managed daemon', async () => {
    const fixture = createFixture('runtime-target-live-dirty');
    const daemon = await seedManagedRuntimeDaemon(fixture);
    dirtyTrackedRuntimeSourceAndInvalidateApiStamp(fixture);

    const result = startRuntime(fixture, ['--no-sync'], { action: 'restart' });

    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /runtime worktree has local changes.*frozen target/i);
    assert.equal(processExists(daemon.pid), true, 'dirty-source rejection must preserve the managed daemon');
    assert.equal(existsSync(fixture.startMarker), false);
  });

  it('rejects tracked runtime source drift on a normal-sync start before build or start', () => {
    const fixture = createFixture('runtime-target-dirty-force');
    const target = advanceRemote(fixture);
    dirtyTrackedRuntimeSourceAndInvalidateApiStamp(fixture);

    const result = startRuntime(fixture, ['--expected-target-sha', target]);

    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /runtime worktree has local changes.*frozen target/i);
    assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), fixture.initialRevision);
    assert.equal(existsSync(fixture.pnpmLog), false, 'tracked-source rejection must precede build');
    assert.equal(existsSync(fixture.startMarker), false, 'tracked-source rejection must precede process start');
  });

  it('rejects a no-sync target that does not equal the preserved runtime tree', () => {
    const fixture = createFixture('runtime-target-tree-drift');
    const newerTarget = advanceRemote(fixture);
    const result = startRuntime(fixture, ['--no-sync', '--expected-target-sha', newerTarget]);
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /runtime tree HEAD.*does not equal.*expected/i);
    assert.equal(git(fixture.runtimeDir, ['rev-parse', 'HEAD']), fixture.initialRevision);
    assert.equal(existsSync(fixture.pnpmLog), false);
    assert.equal(existsSync(fixture.startMarker), false);
  });

  it('rejects a build stamp that remains mismatched after the freshness build', () => {
    const fixture = createFixture('runtime-target-build-drift');
    const mcpStamp = join(fixture.runtimeDir, 'packages', 'mcp-server', 'dist', '.build-commit');
    writeFileSync(mcpStamp, `${'f'.repeat(40)}\n`);
    chmodSync(mcpStamp, 0o444);
    const result = startRuntime(fixture, ['--no-sync', '--expected-target-sha', fixture.initialRevision]);
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /MCP build stamp.*does not equal.*expected/i);
    assert.equal(existsSync(fixture.pnpmLog), true, 'freshness should attempt the stale MCP build');
    assert.equal(existsSync(fixture.startMarker), false);
  });
});
