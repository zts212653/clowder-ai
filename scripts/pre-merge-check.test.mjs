import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { requireBash } from './test-bash-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'pre-merge-check.sh');
const PREPARED_ARTIFACT_SCRIPT = path.join(repoRoot, 'scripts', 'gate-prepared-artifacts.mjs');
const PREPARED_ARTIFACT_TEST_OPTIONS = {
  skip: !existsSync(PREPARED_ARTIFACT_SCRIPT) && 'home-only prepared-artifact support is absent from public export',
};
const GATE_TERMINAL_RECEIPT_SCRIPT = path.join(repoRoot, 'scripts', 'gate-terminal-receipt.mjs');
const SOURCE_GATE_CONTROL_TEST_OPTIONS = {
  skip:
    !existsSync(GATE_TERMINAL_RECEIPT_SCRIPT) &&
    'home-only route and terminal-receipt control plane is absent from public export',
};

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source, 'utf8');
  chmodSync(filePath, 0o755);
}

function createGitStub(logPath, stubRoot = repoRoot) {
  return `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const rebaseStatePath = ${JSON.stringify(`${logPath}.rebase-state`)};
const rebaseCount = () => (existsSync(rebaseStatePath) ? Number(readFileSync(rebaseStatePath, 'utf8')) : 0);
appendFileSync(${JSON.stringify(logPath)}, \`git \${args.join(' ')}\\n\`);

if (args[0] === 'branch' && args[1] === '--show-current') {
  process.stdout.write('fix/test\\n');
  process.exit(0);
}

if (args[0] === 'status' && args[1] === '--porcelain') {
  if (process.env.STUB_GIT_DIRTY) {
    process.stdout.write(process.env.STUB_GIT_DIRTY + '\\n');
  }
  process.exit(0);
}

if (args[0] === 'fetch' && args[1] === 'origin' && args[2] === 'main') {
  process.exit(0);
}

if (args[0] === 'rebase' && args[1] === 'origin/main') {
  process.exit(0);
}

if (args[0] === 'rebase' && args[1] === '1111111111111111111111111111111111111111') {
  if (process.env.STUB_REBASE_ALWAYS_CHANGES_HEAD === '1') {
    writeFileSync(rebaseStatePath, String(rebaseCount() + 1));
  } else if (process.env.STUB_REBASE_CHANGES_HEAD === '1' && !existsSync(rebaseStatePath)) {
    writeFileSync(rebaseStatePath, '1');
  }
  process.exit(0);
}

if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === 'origin/main') {
  process.stdout.write('1111111111111111111111111111111111111111\\n');
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === '--short' && args[2] === 'HEAD') {
  process.stdout.write(String.fromCharCode(97 + Math.min(rebaseCount(), 5)).repeat(7) + '\\n');
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
  process.stdout.write(String.fromCharCode(97 + Math.min(rebaseCount(), 5)).repeat(40) + '\\n');
  process.exit(0);
}

if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
  process.stdout.write(${JSON.stringify(`worktree ${stubRoot}\n`)});
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
  process.stdout.write(${JSON.stringify(`${stubRoot}\n`)});
  process.exit(0);
}

if (args[0] === 'add') {
  process.exit(0);
}

if (args[0] === 'commit') {
  process.exit(0);
}

process.stderr.write(\`unexpected git invocation: \${args.join(' ')}\\n\`);
process.exit(1);
`;
}

function createPnpmStub(logPath) {
  return `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, \`pnpm \${args.join(' ')}\\n\`);
appendFileSync(
  ${JSON.stringify(logPath)},
  \`gate-base \${process.env.CAT_CAFE_GATE_BASE_SHA ?? '<unset>'}\\n\`,
);
appendFileSync(
  ${JSON.stringify(logPath)},
  \`prepared-artifacts \${process.env.CAT_CAFE_GATE_PREPARED_ARTIFACTS ?? '<unset>'}\\n\`,
);
appendFileSync(
  ${JSON.stringify(logPath)},
  \`gate-reexec-depth \${process.env.CAT_CAFE_GATE_REEXEC_DEPTH ?? '<unset>'}\\n\`,
);
if (args[0] === 'install') {
  appendFileSync(
    ${JSON.stringify(logPath)},
    \`env NODE_ENV=\${process.env.NODE_ENV ?? '<unset>'} npm_config_production=\${process.env.npm_config_production ?? '<unset>'} NPM_CONFIG_PRODUCTION=\${process.env.NPM_CONFIG_PRODUCTION ?? '<unset>'}\\n\`,
  );
}

const command =
  args[0] === '-r'
    ? args.slice(0, 4).join(' ')
    : args[0] === '--filter'
      ? args.slice(0, 3).join(' ')
      : args[0] === 'run'
        ? args.slice(0, 2).join(' ')
        : args[0];
const knownCommands = new Set([
  'install',
  'run check:fix',
  'run check:biome-version',
  'build',
  'test',
  'check',
  '-r --if-present run build',
  '-r --workspace-concurrency=1 --if-present --filter',
  '-r exec bash -lc',
  '--filter @cat-cafe/web lint',
  '--filter @cat-cafe/web run',
  '--filter @cat-cafe/api run',
]);
if (command === 'run check:fix' && process.env.STUB_CHECKFIX_FAIL === '1') {
  process.exit(1);
}
if (!knownCommands.has(command)) {
  process.stderr.write(\`unexpected pnpm invocation: \${args.join(' ')}\\n\`);
  process.exit(1);
}

process.exit(0);
`;
}

function createNodeStub(logPath) {
  return `#!${process.execPath}
const { appendFileSync, mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, 'node ' + args.join(' ') + '\\n');
if (args[0]?.endsWith('gate-prepared-artifacts.mjs') && args[1] === 'record') {
  process.exit(process.env.STUB_PREPARED_RECEIPT_FAIL === '1' ? 1 : 0);
}
if (args[0]?.endsWith('gate-prepared-artifacts.mjs') && args[1] === 'verify') {
  process.exit(process.env.STUB_PREPARED_VERIFY_FAIL === '1' ? 1 : 0);
}
if (args[0]?.endsWith('classify-gate-route.mjs')) {
  const currentHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  process.stdout.write(JSON.stringify({
    route: process.env.STUB_GATE_ROUTE ?? 'full',
    fingerprint: 'fingerprint-test',
    headSha: process.env.STUB_ROUTE_HEAD_SHA ?? currentHead,
    reasons: ['stub route'],
    requiredChecks: process.env.STUB_GATE_ROUTE === 'targeted' ? ['risk-matched-targeted-evidence'] : ['canonical-full-gate'],
  }) + '\\n');
  process.exit(0);
}
if (args[0]?.endsWith('snapshot-gate-control-plane.mjs')) {
  const destination = args[args.indexOf('--destination') + 1];
  mkdirSync(destination, { recursive: true });
  process.exit(0);
}
if (args[0]?.endsWith('gate-terminal-receipt.mjs')) {
  if (args[1] === 'begin') {
    process.stdout.write(JSON.stringify({ role: 'producer', runId: 'gate-run-test', fingerprint: 'fingerprint-test' }) + '\\n');
  }
  if (args[1] === 'stage-check') {
    const stage = args[args.indexOf('--stage') + 1];
    if (process.env.STUB_STAGE_CHECK_ERROR_STAGE === stage) process.exit(1);
    const greenStages = new Set((process.env.STUB_GREEN_STAGES ?? '').split(',').filter(Boolean));
    process.exit(greenStages.has(stage) ? 0 : 3);
  }
  if (args[1] === 'heartbeat' && process.env.STUB_HEARTBEAT_ERROR === '1') process.exit(1);
  if (args[1] === 'stage-green') {
    const stage = args[args.indexOf('--stage') + 1];
    if (process.env.STUB_STAGE_GREEN_ERROR_STAGE === stage) process.exit(1);
  }
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(process.execPath)}, args, { env: process.env, stdio: 'inherit' });
if (result.error) {
  process.stderr.write(result.error.message + '\\n');
  process.exit(1);
}
process.exit(typeof result.status === 'number' ? result.status : 1);
`;
}

function createPublicSyncFixture(baseDir) {
  const fakeRoot = path.join(baseDir, 'fake-repo');
  mkdirSync(path.join(fakeRoot, 'packages', 'api'), { recursive: true });
  mkdirSync(path.join(fakeRoot, 'scripts', 'lib'), { recursive: true });
  // Model the real public export closure instead of exposing every source-only
  // home script through one broad scripts/ symlink. In particular, the public
  // package does not export the resource scheduler or prepared-artifact helper.
  for (const relativePath of ['scripts/pre-merge-gate-guard.mjs', 'scripts/lib/fseventsd-pressure.mjs']) {
    symlinkSync(path.join(repoRoot, relativePath), path.join(fakeRoot, relativePath));
  }
  // Minimal package.json with test:public script — simulates public sync target
  writeFileSync(
    path.join(fakeRoot, 'packages', 'api', 'package.json'),
    JSON.stringify({ scripts: { 'test:public': 'echo ok' } }),
    'utf8',
  );
  // NO .claude/settings.json — that's the sentinel resolve_test_mode checks
  return fakeRoot;
}

function runGate(bash, args = [], extraEnv = {}, options = {}) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pre-merge-check-test-'));
  const binDir = path.join(tempDir, 'bin');
  const logPath = path.join(tempDir, 'commands.log');
  const pressurePath = path.join(tempDir, 'normal-pressure.json');

  const effectiveRoot = options.publicSyncFixture ? createPublicSyncFixture(tempDir) : repoRoot;

  try {
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(pressurePath, JSON.stringify({ pressure: 'normal' }), 'utf8');
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, 'git'), createGitStub(logPath, effectiveRoot));
    writeExecutable(path.join(binDir, 'pnpm'), createPnpmStub(logPath));
    writeExecutable(path.join(binDir, 'node'), createNodeStub(logPath));

    const gateEnv = {
      ...process.env,
      ...extraEnv,
      CAT_CAFE_GATE_GUARD_SKIP_PRESSURE: '1',
      CAT_CAFE_FULL_GATE_LEASE_HELD: options.leaseHeld === false ? '0' : '1',
      CAT_CAFE_FULL_GATE_LOCK_PATH: path.join(tempDir, 'full-gate-resource.lock'),
      CAT_CAFE_FULL_GATE_RESOURCE_DB_PATH: path.join(tempDir, 'full-gate-resources.sqlite'),
      CAT_CAFE_FULL_GATE_PRESSURE_FIXTURE: pressurePath,
      CAT_CAFE_FULL_GATE_LEASE_POLL_MS: '5',
      CAT_CAFE_GATE_LOCK_DIR: path.join(tempDir, 'pre-merge-check.lock'),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    if (!Object.hasOwn(extraEnv, 'CAT_CAFE_PROCESS_OWNER_ID')) {
      delete gateEnv.CAT_CAFE_PROCESS_OWNER_ID;
    }
    if (!Object.hasOwn(extraEnv, 'CAT_CAFE_CLI_PROCESS_CONTEXT')) {
      delete gateEnv.CAT_CAFE_CLI_PROCESS_CONTEXT;
    }

    const result = spawnSync(bash, [scriptPath, ...args], {
      cwd: effectiveRoot,
      encoding: 'utf8',
      env: gateEnv,
    });

    const logLines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    return { ...result, logLines };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('pre-merge-check dependency refresh order', () => {
  it(
    'does not enter full-gate guards or expensive stages when the canonical route is targeted',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const bash = requireBash(t);
      const result = runGate(bash, [], {
        CAT_CAFE_PROCESS_OWNER_ID: 'cat-owned-process',
        STUB_GATE_ROUTE: 'targeted',
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /route=targeted/i);
      assert.ok(!result.logLines.some((line) => line.includes('pre-merge-gate-guard.mjs acquire')));
      assert.ok(!result.logLines.some((line) => line.includes('gate-terminal-receipt.mjs begin')));
      assert.ok(!result.logLines.some((line) => line.startsWith('pnpm ')));
    },
  );

  it('rejects a full gate launched directly from a cat CLI process', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { CAT_CAFE_PROCESS_OWNER_ID: 'cat-owned-process' });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /cat_cafe_hold_ball/);
    assert.match(result.stderr, /wakeWhen/);
    assert.ok(!result.logLines.some((line) => line.includes('pre-merge-gate-guard.mjs acquire')));
    assert.ok(!result.logLines.some((line) => line.includes('gate-terminal-receipt.mjs begin')));
    assert.ok(!result.logLines.some((line) => line.startsWith('pnpm ')));
  });

  it('rejects a full gate launched by a cat carrier without a process-owner token', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { CAT_CAFE_CLI_PROCESS_CONTEXT: 'cat' });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /cat_cafe_hold_ball/);
    assert.match(result.stderr, /wakeWhen/);
    assert.ok(!result.logLines.some((line) => line.includes('pre-merge-gate-guard.mjs acquire')));
    assert.ok(!result.logLines.some((line) => line.includes('gate-terminal-receipt.mjs begin')));
    assert.ok(!result.logLines.some((line) => line.startsWith('pnpm ')));
  });

  it('runs the canonical empty-argv gate through resource-scoped permits', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], {}, { leaseHeld: false });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.logLines.includes('pnpm install --frozen-lockfile'),
      `expected the resource-scoped gate to run with empty argv, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('preserves non-empty argv without a whole-gate re-entry wrapper', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, ['--no-rebase', '--skip-install'], {}, { leaseHeld: false });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      !result.logLines.some((line) => line.startsWith('git fetch ') || line.startsWith('git rebase ')),
      `expected --no-rebase to survive lease re-entry, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      !result.logLines.some((line) => line.startsWith('pnpm install ')),
      `expected --skip-install to survive lease re-entry, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('passes --risk through when preceded by pnpm passthrough -- separator', SOURCE_GATE_CONTROL_TEST_OPTIONS, (t) => {
    const bash = requireBash(t);
    // Simulates: pnpm gate -- --risk contract
    // pnpm 9.x passes '--' as a literal arg to the script
    const result = runGate(bash, ['--', '--risk', 'contract'], {}, { leaseHeld: false });

    assert.equal(result.status, 0, `gate should succeed, stderr: ${result.stderr}`);
    // The classifier (not receipt begin, which always logs GATE_ORIGINAL_ARGS) must receive --risk
    const classifierLine = result.logLines.find((line) => line.includes('classify-gate-route.mjs'));
    assert.ok(classifierLine, `expected classifier invocation in log, got:\n${result.logLines.join('\n')}`);
    assert.ok(
      classifierLine.includes('--risk') && classifierLine.includes('contract'),
      `expected classifier to receive --risk contract, got: ${classifierLine}`,
    );
  });

  it('keeps the directory-size guard in the root check chain', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    assert.match(
      packageJson.scripts.check,
      /(?:^|&&\s*)pnpm check:dir-size(?:\s*&&|$)/,
      'pnpm gate must fail locally before public CI when a source directory crosses ADR-010 limits',
    );
  });

  it(
    'includes prepared-artifact receipt checks in the pre-merge gate check suite',
    PREPARED_ARTIFACT_TEST_OPTIONS,
    () => {
      const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

      assert.match(
        packageJson.scripts['check:pre-merge-gate'],
        /scripts\/gate-prepared-artifacts\.test\.mjs/,
        'pnpm check must run the prepared-artifact fail-closed contract tests',
      );
    },
  );

  it('does not truncate git worktree output with a pipe that can SIGPIPE under pipefail', () => {
    const source = readFileSync(scriptPath, 'utf8');

    assert.doesNotMatch(source, /git worktree list --porcelain\s*\|\s*head\b/);
    assert.match(source, /git worktree list --porcelain\s*\|\s*sed -n/);
  });

  it('runs pnpm install after rebasing onto origin/main', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash);

    assert.equal(result.status, 0, result.stderr);
    const rebaseIndex = result.logLines.findIndex((line) =>
      line.startsWith('git rebase 1111111111111111111111111111111111111111'),
    );
    const installIndex = result.logLines.indexOf('pnpm install --frozen-lockfile');
    const biomeVersionIndex = result.logLines.indexOf('pnpm run check:biome-version');
    const buildIndex = result.logLines.indexOf('pnpm -r --if-present run build');

    assert.notEqual(rebaseIndex, -1, 'expected rebase to run');
    assert.notEqual(installIndex, -1, 'expected pnpm install to run');
    assert.notEqual(biomeVersionIndex, -1, 'expected biome version guard to run');
    assert.notEqual(buildIndex, -1, 'expected pnpm build to run');
    assert.ok(rebaseIndex < installIndex, `expected install after rebase, got:\n${result.logLines.join('\n')}`);
    assert.ok(
      installIndex < biomeVersionIndex,
      `expected biome version guard after install, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      biomeVersionIndex < buildIndex,
      `expected build after biome version guard, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(installIndex < buildIndex, `expected build after install, got:\n${result.logLines.join('\n')}`);
    assert.ok(
      result.logLines.some((line) => line === 'gate-base 1111111111111111111111111111111111111111'),
      `expected every gate child to inherit the frozen base SHA, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('re-execs the current gate before post-rebase commands when rebase changes HEAD', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { STUB_REBASE_CHANGES_HEAD: '1' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /restarting gate from the rebased tree/i);

    const rebaseIndexes = result.logLines
      .map((line, index) => (line.startsWith('git rebase ') ? index : -1))
      .filter((index) => index >= 0);
    const branchIndexes = result.logLines
      .map((line, index) => (line === 'git branch --show-current' ? index : -1))
      .filter((index) => index >= 0);
    const firstPostRebaseCommand = result.logLines.findIndex(
      (line) => line.includes('classify-gate-route.mjs') || line.startsWith('pnpm '),
    );

    assert.equal(
      rebaseIndexes.length,
      2,
      `expected the fresh process to verify the integration cut with one no-op rebase, got:\n${result.logLines.join('\n')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(branchIndexes.length, 2, `expected one fresh gate process, got:\n${result.logLines.join('\n')}`);
    assert.ok(
      rebaseIndexes[0] < branchIndexes[1] &&
        branchIndexes[1] < rebaseIndexes[1] &&
        rebaseIndexes[1] < firstPostRebaseCommand,
      `expected fresh process startup before post-rebase commands, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      result.logLines
        .filter((line) => line.startsWith('gate-reexec-depth '))
        .every((line) => line === 'gate-reexec-depth <unset>'),
      `internal restart marker must not leak to gate children, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('fails closed before post-rebase commands when the integration cut never stabilizes', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { STUB_REBASE_ALWAYS_CHANGES_HEAD: '1' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HEAD kept changing across 3 post-rebase restarts/);
    assert.equal(
      result.logLines.filter((line) => line.startsWith('git rebase ')).length,
      4,
      `expected the initial attempt plus three bounded restarts, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      !result.logLines.some((line) => line.includes('classify-gate-route.mjs') || line.startsWith('pnpm ')),
      `unstable control plane must not execute post-rebase commands, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('records Step 3 artifacts before enabling prepared-artifact reuse', PREPARED_ARTIFACT_TEST_OPTIONS, (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { CAT_CAFE_GATE_PREPARED_ARTIFACTS: '1' });

    assert.equal(result.status, 0, result.stderr);
    const buildIndex = result.logLines.indexOf('pnpm -r --if-present run build');
    const receiptIndex = result.logLines.findIndex((line) => line.endsWith('gate-prepared-artifacts.mjs record'));
    const tscIndex = result.logLines.findIndex((line) => line.startsWith('pnpm -r exec bash -lc'));
    const stateAfter = (index) =>
      result.logLines.slice(index + 1).find((line) => line.startsWith('prepared-artifacts '));

    assert.notEqual(buildIndex, -1, `expected Step 3 build, got:\n${result.logLines.join('\n')}`);
    assert.notEqual(receiptIndex, -1, `expected prepared-artifact receipt, got:\n${result.logLines.join('\n')}`);
    assert.notEqual(tscIndex, -1, `expected Step 4 tsc, got:\n${result.logLines.join('\n')}`);
    assert.ok(buildIndex < receiptIndex, `receipt must follow Step 3 build, got:\n${result.logLines.join('\n')}`);
    assert.ok(receiptIndex < tscIndex, `reuse must start after receipt, got:\n${result.logLines.join('\n')}`);
    assert.equal(stateAfter(buildIndex), 'prepared-artifacts <unset>');
    assert.equal(stateAfter(tscIndex), 'prepared-artifacts 1');
  });

  it(
    'fails closed before Step 4 when the prepared-artifact receipt cannot be recorded',
    PREPARED_ARTIFACT_TEST_OPTIONS,
    (t) => {
      const bash = requireBash(t);
      const result = runGate(bash, [], { STUB_PREPARED_RECEIPT_FAIL: '1' });

      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /Build 产物收据记录失败/);
      assert.ok(
        !result.logLines.some((line) => line.startsWith('pnpm -r exec bash -lc')),
        `gate must not enter Step 4 after a receipt failure, got:\n${result.logLines.join('\n')}`,
      );
    },
  );

  it(
    'resumes exact-tree green stages while always refreshing worktree dependencies',
    PREPARED_ARTIFACT_TEST_OPTIONS,
    (t) => {
      const bash = requireBash(t);
      const greenStages = [
        'build',
        'tsc',
        'test-non-browser',
        'test-web-unit',
        'test-web-browser',
        'test-web-guards',
        'lint-web',
        'check',
      ].join(',');
      const result = runGate(bash, [], { STUB_GREEN_STAGES: greenStages });

      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.logLines.includes('pnpm install --frozen-lockfile'));
      assert.ok(result.logLines.includes('pnpm -r --if-present run build'));
      assert.ok(!result.logLines.some((line) => line.endsWith('gate-prepared-artifacts.mjs verify')));
      assert.ok(!result.logLines.some((line) => line.startsWith('pnpm -r exec bash -lc')));
      assert.ok(!result.logLines.includes('pnpm test'));
      const settle = result.logLines.find((line) => line.includes('gate-terminal-receipt.mjs settle'));
      assert.match(settle, /--required-stages tsc,test-non-browser/);
    },
  );

  it(
    'fails closed when the stage receipt control plane reports an integrity error',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const bash = requireBash(t);
      const result = runGate(bash, [], { STUB_STAGE_CHECK_ERROR_STAGE: 'tsc' });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /stage receipt integrity check failed/i);
      assert.ok(
        !result.logLines.some((line) => line.startsWith('pnpm -r exec bash -lc')),
        `an integrity error must not be downgraded to a cache miss:\n${result.logLines.join('\n')}`,
      );
    },
  );

  it(
    'propagates a receipt heartbeat failure before starting the guarded stage',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const bash = requireBash(t);
      const result = runGate(bash, [], { STUB_HEARTBEAT_ERROR: '1' });

      assert.notEqual(result.status, 0);
      assert.ok(
        !result.logLines.includes('pnpm install --frozen-lockfile'),
        `a failed heartbeat must stop before the stage command:\n${result.logLines.join('\n')}`,
      );
    },
  );

  it(
    'propagates a green receipt write failure instead of reporting the stage as reusable',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const bash = requireBash(t);
      const result = runGate(bash, [], { STUB_STAGE_GREEN_ERROR_STAGE: 'tsc' });

      assert.notEqual(result.status, 0);
      assert.ok(
        !result.logLines.some((line) => line.includes('--stage test-non-browser')),
        `a failed green write must stop before the next stage:\n${result.logLines.join('\n')}`,
      );
    },
  );

  it(
    'uses an exact-revision control-plane snapshot for route and receipt commands',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const bash = requireBash(t);
      const result = runGate(bash);

      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        result.logLines.some((line) => line.includes('snapshot-gate-control-plane.mjs')),
        `expected an immutable control-plane snapshot:\n${result.logLines.join('\n')}`,
      );
      const receiptCommands = result.logLines.filter((line) => line.includes('gate-terminal-receipt.mjs'));
      assert.ok(receiptCommands.length > 0);
      assert.ok(
        receiptCommands.every((line) => !line.includes(GATE_TERMINAL_RECEIPT_SCRIPT)),
        `receipt commands must not reload the mutable worktree copy:\n${receiptCommands.join('\n')}`,
      );
    },
  );

  it(
    'rejects route evidence computed after the worktree leaves the snapshotted revision',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const bash = requireBash(t);
      const result = runGate(bash, [], { STUB_ROUTE_HEAD_SHA: 'f'.repeat(40) });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /route tree no longer matches.*control-plane snapshot/i);
      assert.ok(!result.logLines.some((line) => line.includes('gate-terminal-receipt.mjs begin')));
    },
  );

  it(
    'writes route and stage duration into the existing terminal and stage receipts',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const bash = requireBash(t);
      const result = runGate(bash);

      assert.equal(result.status, 0, result.stderr);
      const stageGreen = result.logLines.find((line) => line.includes('gate-terminal-receipt.mjs stage-green'));
      const settle = result.logLines.find((line) => line.includes('gate-terminal-receipt.mjs settle'));
      assert.match(stageGreen, /--duration-ms \d+ --route full/);
      assert.match(settle, /--route-json \{/);
      assert.match(settle, /--failure-output-file /);
    },
  );

  it('never reuses the recursive root build without its complete output closure', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], {
      STUB_GREEN_STAGES: 'build',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.logLines.some((line) => line.endsWith('gate-prepared-artifacts.mjs verify')));
    assert.ok(result.logLines.includes('pnpm -r --if-present run build'));
  });

  it('clears inherited production install env before pnpm install', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], {
      NODE_ENV: 'production',
      npm_config_production: 'true',
      NPM_CONFIG_PRODUCTION: 'true',
    });

    assert.equal(result.status, 0, result.stderr);
    const envLine = result.logLines.find((line) => line.startsWith('env NODE_ENV='));

    assert.ok(envLine, `expected install env line, got:\n${result.logLines.join('\n')}`);
    assert.equal(
      envLine,
      'env NODE_ENV=<unset> npm_config_production=<unset> NPM_CONFIG_PRODUCTION=<unset>',
      `expected gate to clear inherited production install env, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('does not truncate git worktree output through head under pipefail', () => {
    const source = readFileSync(scriptPath, 'utf8');

    assert.doesNotMatch(source, /git worktree list --porcelain\s*\|\s*head\b/);
  });

  it('uses public API tests when source-only Claude settings are absent', (t) => {
    const bash = requireBash(t);
    // Use a fake repo root without .claude/settings.json to simulate public sync target.
    // Without this fixture, source checkouts have the sentinel → resolve_test_mode picks "full".
    const result = runGate(bash, [], {}, { publicSyncFixture: true });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.logLines.includes('pnpm --filter @cat-cafe/api run test:public'),
      `expected public test suite in public sync target, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      result.logLines.includes('pnpm -r --if-present run build'),
      `expected public gate to retain its build phase, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      result.logLines.includes('pnpm -r exec bash -lc if command -v tsc >/dev/null 2>&1; then tsc --noEmit; fi'),
      `expected public gate to retain its typecheck phase, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      !result.logLines.some(
        (line) => line.includes('run-with-gate-resource-permit.mjs') || line.includes('gate-prepared-artifacts.mjs'),
      ),
      `public gate must not consume source-only scheduler helpers, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      !result.logLines.includes('pnpm test'),
      `public sync target must not run source-only full tests, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('allows full test mode to be forced explicitly', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { CAT_CAFE_GATE_TEST_MODE: 'full' });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.logLines.includes('pnpm -r --workspace-concurrency=1 --if-present --filter !@cat-cafe/web run test'),
      `expected non-browser workspace tests, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      result.logLines.includes('pnpm --filter @cat-cafe/web run test:browser'),
      `expected exclusive web browser tests, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      !result.logLines.includes('pnpm --filter @cat-cafe/api run test:public'),
      `full mode must not run public test suite, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('keeps a source checkout forced to public mode outside canonical receipt reuse', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { CAT_CAFE_GATE_TEST_MODE: 'public' });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.logLines.includes('pnpm --filter @cat-cafe/api run test:public'));
    assert.ok(
      !result.logLines.some((line) => line.includes('gate-terminal-receipt.mjs')),
      `source public probes must not produce or consume canonical receipts, got:\n${result.logLines.join('\n')}`,
    );
  });
});

describe('pre-merge-check --auto-fix mode (F253)', () => {
  it('runs pnpm run check:fix before normal gate steps when --auto-fix is passed', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, ['--auto-fix']);

    assert.equal(result.status, 0, result.stderr);
    const checkFixIndex = result.logLines.indexOf('pnpm run check:fix');
    const installIndex = result.logLines.indexOf('pnpm install --frozen-lockfile');

    assert.notEqual(checkFixIndex, -1, `expected pnpm run check:fix to run, got:\n${result.logLines.join('\n')}`);
    assert.ok(checkFixIndex < installIndex, `expected check:fix before install, got:\n${result.logLines.join('\n')}`);
  });

  it('does not run pnpm run check:fix when --auto-fix is not passed', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      !result.logLines.includes('pnpm run check:fix'),
      `check:fix must not run without --auto-fix, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('does not commit pre-existing dirty files with --auto-fix (P1)', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, ['--no-rebase', '--auto-fix'], {
      STUB_GIT_DIRTY: ' M user-wip.ts',
    });

    assert.equal(result.status, 0, result.stderr);
    // git add -A must NOT be used — it would swallow user WIP
    assert.ok(
      !result.logLines.some((l) => l === 'git add -A'),
      `git add -A must not be used when pre-existing dirty files exist, got:\n${result.logLines.join('\n')}`,
    );
    // No commit should happen since the only dirty file was pre-existing, not auto-fix produced
    assert.ok(
      !result.logLines.some((l) => l.startsWith('git commit')),
      `must not commit when only pre-existing dirty files exist, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('shows warning when check:fix fails instead of success message (P2)', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, ['--auto-fix'], {
      STUB_CHECKFIX_FAIL: '1',
    });

    assert.equal(result.status, 0, result.stderr);
    // Must show warning about failure, not unconditional success
    assert.ok(
      result.stdout.includes('auto-fix exited with code'),
      `expected warning about check:fix failure, got stdout:\n${result.stdout}`,
    );
  });
});
