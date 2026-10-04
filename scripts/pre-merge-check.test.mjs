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
import { rootCheckChain } from './lib/root-check-chain.mjs';

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

function testSourceAndPublic(name, verify) {
  // The public export closure guard verifies this direct source-only skip binding.
  it(`${name} (source)`, SOURCE_GATE_CONTROL_TEST_OPTIONS, (t) => verify(t, { sourceFixture: true }));
  it(`${name} (public export)`, (t) => verify(t, { publicSyncFixture: true }));
}

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
const mergeStatePath = ${JSON.stringify(`${logPath}.merge-state`)};
const mergeCount = () => (existsSync(mergeStatePath) ? Number(readFileSync(mergeStatePath, 'utf8')) : 0);
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

if (args[0] === 'show-ref' && args.includes('refs/remotes/origin/fix/test')) {
  process.exit(process.env.STUB_PUBLISHED_BRANCH === '1' ? 0 : 1);
}

if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/fix/test^{commit}')) {
  process.stdout.write('3'.repeat(40) + '\\n');
  process.exit(0);
}

if (args[0] === 'merge' && args.includes('1111111111111111111111111111111111111111')) {
  if (process.env.STUB_PUBLICATION_MERGE_FAIL === '1') process.exit(1);
  writeFileSync(mergeStatePath, '1');
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
  if (process.env.STUB_MERGE_BASE_ERROR === '1') process.exit(128);
  if (args[2] === '3'.repeat(40)) {
    if (process.env.STUB_PUBLISHED_ANCESTRY_ERROR === '1') process.exit(128);
    process.exit(args[3] === 'HEAD'
      ? (process.env.STUB_REMOTE_DIVERGED === '1' ? 1 : 0)
      : (process.env.STUB_PUBLISHED_IN_MAIN === '1' ? 0 : 1));
  }
  process.exit(process.env.STUB_BASE_IS_ANCESTOR === '1' || mergeCount() > 0 ? 0 : 1);
}

if (args[0] === 'rev-parse' && args[1] === 'origin/main') {
  process.stdout.write('1111111111111111111111111111111111111111\\n');
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === '--short' && args[2] === 'HEAD') {
  process.stdout.write(String.fromCharCode(97 + Math.min(rebaseCount() + mergeCount(), 5)).repeat(7) + '\\n');
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
  process.stdout.write(String.fromCharCode(97 + Math.min(rebaseCount() + mergeCount(), 5)).repeat(40) + '\\n');
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') {
  process.stdout.write('2'.repeat(40) + '\\n');
  process.exit(0);
}

if (args[0] === 'cat-file' && args[1] === '-e') {
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
// Every stage records the production-env triple so the environment matrix is
// observable per stage, not only for install.
appendFileSync(
  ${JSON.stringify(logPath)},
  \`stage-env \${args.join(' ')} :: NODE_ENV=\${process.env.NODE_ENV ?? '<unset>'} npm_config_production=\${process.env.npm_config_production ?? '<unset>'} NPM_CONFIG_PRODUCTION=\${process.env.NPM_CONFIG_PRODUCTION ?? '<unset>'}\\n\`,
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
  'check:sources',
  'check:installed',
  'check:artifacts',
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
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, 'node ' + args.join(' ') + '\\n');
if (args[0]?.endsWith('gate-continuity-claim.mjs') && args[1] === 'inspect') {
  process.stdout.write(JSON.stringify({ target: { baseSha: '1'.repeat(40) } }));
  process.exit(0);
}
if (args[0]?.endsWith('plan-browser-verification.mjs')) {
  const code = Number(process.env.STUB_BROWSER_PLAN_EXIT ?? '0');
  if (code === 1) {
    process.stderr.write('Browser catalog requires explicit admission\\n');
    process.exit(1);
  }
  const plan = JSON.stringify({
    status: code === 3 ? 'blocked' : 'ready',
    planFingerprint: 'f'.repeat(64),
    requiredUnitIds: ['browser:core'],
    coverageGaps: code === 3 ? [{ path: 'new-runtime/data.json', reason: 'unmapped-input' }] : [],
    nativeVerificationRequirements: process.env.STUB_NATIVE_REQUIRED === '1' ? [{
      path: 'desktop/plugin-window/pet-window.cjs', ownerRef: 'docs/features/F317-coactive-companion.md',
      reason: 'native-desktop-verification-required',
    }] : [],
  }) + '\\n';
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], plan, { flag: 'wx' });
  else process.stdout.write(plan);
  process.exit(code);
}
if (args[0]?.endsWith('run-browser-verification.mjs')) {
  appendFileSync(${JSON.stringify(logPath)}, 'browser-outer-permit ' + (process.env.CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD ?? '<unset>') + '\\n');
  process.exit(Number(process.env.STUB_BROWSER_VERIFICATION_EXIT ?? '0'));
}
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
if (args[0]?.endsWith('check-gate-browser-membership.mjs')) {
  if (process.env.STUB_BROWSER_MEMBERSHIP_EXIT === '2') {
    process.stderr.write('Browser journey has no admitted owner reference: test-unowned\\n');
    process.exit(2);
  }
  process.stdout.write(readFileSync(0, 'utf8'));
  process.exit(0);
}
if (args[0]?.endsWith('snapshot-gate-control-plane.mjs')) {
  const destination = args[args.indexOf('--destination') + 1];
  mkdirSync(destination, { recursive: true });
  process.exit(0);
}
if (args[0]?.endsWith('gate-terminal-receipt.mjs')) {
  if (args[1] === 'resume-inspect') {
    process.stdout.write(JSON.stringify({
      runId: '11111111-2222-4333-8444-555555555555',
      terminalStatus: 'failed',
      fingerprint: 'fingerprint-test',
      executionOwnerJobId: 'managed-source-job',
      executionOriginTaskId: 'hold-ball-source-task',
      frozenIdentity: {
        protocolVersion: 2,
        headSha: 'a'.repeat(40),
        treeSha: '2'.repeat(40),
        baseSha: (process.env.STUB_RESUME_SOURCE_FULL === '1' ? 'a' : '1').repeat(40),
        ...(process.env.STUB_RESUME_SOURCE_FULL === '1' ? { verificationScope: 'source_full' } : {}),
        route: 'full',
        risk: 'contract',
        mode: 'full',
        fingerprint: 'fingerprint-test',
        runnerFingerprint: '5'.repeat(64),
        toolchainFingerprint: '6'.repeat(64),
      },
    }) + '\\n');
  }
  if (args[1] === 'resume-parse') {
    process.stdout.write(args[args.indexOf('--frozen-identity-json') + 1] + '\\n');
  }
  if (args[1] === 'resume-validate') process.exit(0);
  if (args[1] === 'begin') {
    if (
      process.env.STUB_EXPECT_RESUME_OWNER === '1' &&
      (process.env.CAT_CAFE_GATE_EXECUTION_OWNER_JOB_ID !== 'managed-source-job' ||
        process.env.CAT_CAFE_GATE_EXECUTION_ORIGIN_TASK_ID !== 'hold-ball-source-task' ||
        process.env.CAT_CAFE_GATE_EXECUTION_RESUME_KIND !== 'explicit_resume' ||
        process.env.CAT_CAFE_GATE_EXECUTION_RESUME_KEY !== 'explicit:11111111-2222-4333-8444-555555555555' ||
        process.env.CAT_CAFE_GATE_EXECUTION_RESUME_SOURCE_RUN_ID !== '11111111-2222-4333-8444-555555555555')
    ) {
      process.stderr.write('resume execution owner identity was not propagated\\n');
      process.exit(1);
    }
    if (
      process.env.STUB_EXPECT_AUTO_RESUME_OWNER === '1' &&
      (process.env.CAT_CAFE_GATE_EXECUTION_OWNER_JOB_ID !== 'managed-current-job' ||
        process.env.CAT_CAFE_GATE_EXECUTION_ORIGIN_TASK_ID !== 'hold-ball-current-task' ||
        process.env.CAT_CAFE_GATE_EXECUTION_RESUME_KIND !== 'owner_recovery' ||
        process.env.CAT_CAFE_GATE_EXECUTION_RESUME_KEY !== 'owner:managed-current-job:1')
    ) {
      process.stderr.write('managed recovery execution owner identity was not propagated\\n');
      process.exit(1);
    }
    if (
      process.env.STUB_EXPECT_NESTED_RESUME_OWNER === '1' &&
      (process.env.CAT_CAFE_GATE_EXECUTION_OWNER_JOB_ID !== 'managed-source-job' ||
        process.env.CAT_CAFE_GATE_EXECUTION_ORIGIN_TASK_ID !== 'hold-ball-source-task' ||
        process.env.CAT_CAFE_GATE_EXECUTION_RESUME_KIND !== 'owner_recovery' ||
        process.env.CAT_CAFE_GATE_EXECUTION_RESUME_KEY !== 'owner:managed-current-job:1')
    ) {
      process.stderr.write('nested managed recovery lost its original execution owner identity\\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ role: process.env.STUB_TERMINAL_ROLE ?? 'producer', terminalStatus: process.env.STUB_TERMINAL_STATUS ?? null, runId: 'gate-run-test', fingerprint: 'fingerprint-test' }) + '\\n');
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
  for (const relativePath of [
    // A publication-preserving merge re-execs from this root; include the
    // public shell entrypoint and both of its dirname-relative completion helpers.
    'scripts/pre-merge-check.sh',
    'scripts/check-worktree-dirty-ledger.mjs',
    'scripts/write-gate-last-run.sh',
    'scripts/pre-merge-gate-guard.mjs',
    'scripts/lib/fseventsd-pressure.mjs',
  ]) {
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

function createSourceFixture(baseDir) {
  const root = path.join(baseDir, 'source-repo');
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
  symlinkSync(path.join(repoRoot, 'scripts'), path.join(root, 'scripts'), 'dir');
  return root;
}

function runGate(bash, args = [], extraEnv = {}, options = {}) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pre-merge-check-test-'));
  const binDir = path.join(tempDir, 'bin');
  const logPath = path.join(tempDir, 'commands.log');
  const pressurePath = path.join(tempDir, 'normal-pressure.json');

  const effectiveRoot = options.publicSyncFixture
    ? createPublicSyncFixture(tempDir)
    : options.sourceFixture
      ? createSourceFixture(tempDir)
      : repoRoot;

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
    return { ...result, logLines, sentinelWritten: existsSync(path.join(effectiveRoot, '.gate-last-run')) };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('pre-merge-check dependency refresh order', () => {
  it(
    'resumes source-full through the canonical producer without fetching or publishing merge evidence',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const sha = 'a'.repeat(40);
      const result = runGate(
        requireBash(t),
        ['--source-full', sha, '--risk', 'contract', '--resume', '11111111-2222-4333-8444-555555555555'],
        { STUB_RESUME_SOURCE_FULL: '1', STUB_EXPECT_RESUME_OWNER: '1' },
        { sourceFixture: true },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.sentinelWritten, false);
      assert.ok(!result.logLines.some((line) => /^git (fetch|rebase|merge) /.test(line)));
      const begin = result.logLines.find((line) => line.includes('gate-terminal-receipt.mjs begin'));
      assert.match(begin, new RegExp(`--base-sha ${sha}`));
      assert.match(begin, new RegExp(`-- --source-full ${sha} --risk contract`));
      assert.doesNotMatch(begin, /--resume/);
    },
  );
  it(
    'source-full freezes the source, runs the complete plan and emits no merge sentinel',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const sha = 'a'.repeat(40);
      const result = runGate(requireBash(t), ['--source-full', sha], {}, { sourceFixture: true });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.logLines.some((line) => /^git (fetch|rebase|merge) /.test(line)));
      assert.equal(result.sentinelWritten, false);
      assert.match(result.stdout, /source_full/);
      const planner = result.logLines.find((line) => line.includes('plan-browser-verification.mjs'));
      const planPath = planner.match(/--output (.+)$/)?.[1];
      assert.ok(planPath, 'the planner must write its complete plan to a file');
      for (const receipt of result.logLines.filter((line) =>
        /gate-terminal-receipt\.mjs (?:settle|stage-green .*--stage test-web-browser)/.test(line),
      )) {
        assert.ok(receipt.includes(`--browser-plan-file ${planPath}`), receipt);
        assert.ok(receipt.includes(`--expected-plan-fingerprint ${'f'.repeat(64)}`), receipt);
        assert.doesNotMatch(receipt, /--browser-plan-json/);
      }
      assert.equal(existsSync(planPath), false, 'EXIT cleanup owns the plan with its control plane');
      assert.doesNotMatch(result.stdout, /可以安全执行 merge-gate|origin\/main advanced/);
      assert.ok(result.logLines.includes('pnpm install --frozen-lockfile'));
      const begin = result.logLines.find((line) => line.includes('gate-terminal-receipt.mjs begin'));
      assert.match(begin, new RegExp(`--base-sha ${sha}`));
      assert.match(begin, new RegExp(`-- --source-full ${sha}`));
      for (const command of ['plan-browser-verification.mjs', 'run-browser-verification.mjs']) {
        assert.match(
          result.logLines.find((line) => line.includes(command)),
          /--mode source_full/,
        );
      }
      assert.match(
        result.logLines.find((line) => line.includes('gate-terminal-receipt.mjs settle')),
        /--required-stages check-sources,check-installed,tsc,test-non-browser,test-web-unit,test-web-browser,test-web-guards,lint-web,check/,
      );
    },
  );

  it(
    'source-full rejects mismatched source and incompatible flags before execution',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      for (const args of [
        ['--source-full', 'b'.repeat(40)],
        ['--source-full', 'main'],
        ...['--no-rebase', '--skip-install', '--auto-fix'].map((flag) => ['--source-full', 'a'.repeat(40), flag]),
      ]) {
        const result = runGate(requireBash(t), args, {}, { sourceFixture: true });
        assert.notEqual(result.status, 0);
        assert.ok(
          !result.logLines.some((line) => /^git (fetch|rebase)|^pnpm |gate-terminal-receipt.mjs begin/.test(line)),
        );
        assert.match(result.stderr + result.stdout, /source-full|source_full/);
      }
    },
  );

  it(
    'consumes a C2 claim locator outside invocation identity and never fetches or publishes green',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const claimHash = 'a'.repeat(64);
      const result = runGate(
        requireBash(t),
        ['--continuity-claim', claimHash, '--risk', 'contract'],
        {
          STUB_GATE_ROUTE: 'targeted',
        },
        { sourceFixture: true },
      );
      assert.equal(result.status, 3, result.stderr);
      const line = result.logLines.find((item) => item.includes('classify-gate-route.mjs'));
      assert.ok(line.includes(`--continuity-claim ${claimHash}`), line);
      assert.ok(line.includes('--invocation-args-json ["--risk","contract"]'), line);
      assert.ok(
        !result.logLines.some((item) =>
          /git (fetch|rebase)|gate-terminal-receipt.mjs begin|write-gate-last-run/.test(item),
        ),
      );
      assert.ok(!result.logLines.some((item) => item.startsWith('pnpm ')));
      assert.match(result.stdout, new RegExp(`C2 claimHash=${claimHash}`));
      assert.equal(result.sentinelWritten, false);
    },
  );

  it('rejects C2 consumption in public exports without running or publishing a gate', (t) => {
    const result = runGate(requireBash(t), ['--continuity-claim', 'a'.repeat(64)], {}, { publicSyncFixture: true });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /require the canonical source gate classifier/);
    assert.equal(result.sentinelWritten, false);
    assert.ok(
      !result.logLines.some((line) => /git fetch|git rebase|pnpm (check|test)|settle .*--status green/.test(line)),
    );
  });

  it('rejects a stale C2 claim without quietly starting another full gate', SOURCE_GATE_CONTROL_TEST_OPTIONS, (t) => {
    const result = runGate(
      requireBash(t),
      ['--continuity-claim', 'a'.repeat(64)],
      { STUB_GATE_ROUTE: 'full' },
      { sourceFixture: true },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Continuity claim rejected/);
    assert.ok(
      !result.logLines.some((item) =>
        /git (fetch|rebase)|gate-terminal-receipt.mjs begin|plan-browser-verification/.test(item),
      ),
    );
    assert.equal(result.sentinelWritten, false);
  });

  it(
    'does not enter full-gate guards or expensive stages when the canonical route is targeted',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const bash = requireBash(t);
      const result = runGate(bash, [], {
        CAT_CAFE_PROCESS_OWNER_ID: 'cat-owned-process',
        STUB_GATE_ROUTE: 'targeted',
      });

      // Classification alone never yields a passing terminal state; this case
      // exists to prove the expensive stages are skipped, which still holds.
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stdout, /route=targeted/i);
      assert.ok(!result.logLines.some((line) => line.includes('pre-merge-gate-guard.mjs acquire')));
      assert.ok(!result.logLines.some((line) => line.includes('gate-terminal-receipt.mjs begin')));
      assert.ok(!result.logLines.some((line) => line.startsWith('pnpm ')));
    },
  );

  it(
    'classifies a --no-rebase targeted probe before resources without publishing merge evidence',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(requireBash(t), ['--no-rebase'], {
        CAT_CAFE_PROCESS_OWNER_ID: 'cat-owned-process',
        STUB_GATE_ROUTE: 'targeted',
      });
      // A targeted route is a classification result, not a verification result:
      // it terminates as UNVERIFIED so no consumer reads it as a passing gate.
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stdout, /route=targeted/);
      assert.ok(result.logLines.some((line) => line.includes('classify-gate-route.mjs')));
      assert.ok(
        !result.logLines.some((line) =>
          /git (fetch|rebase)|pre-merge-gate-guard.mjs acquire|gate-terminal-receipt.mjs begin|write-gate-last-run.sh/.test(
            line,
          ),
        ),
      );
      assert.ok(!result.logLines.some((line) => line.startsWith('pnpm ')));
    },
  );

  it(
    'resumes the persisted integration cut without fetching or rebasing and keeps --resume out of identity',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(
        requireBash(t),
        ['--resume', '11111111-2222-4333-8444-555555555555', '--risk', 'contract'],
        { STUB_GATE_ROUTE: 'full', STUB_EXPECT_RESUME_OWNER: '1' },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        !result.logLines.some((line) => line.startsWith('git fetch ') || line.startsWith('git rebase ')),
        `resume must preserve the frozen base without network/rebase:\n${result.logLines.join('\n')}`,
      );
      const classifierLine = result.logLines.find((line) => line.includes('classify-gate-route.mjs'));
      assert.ok(classifierLine?.includes('1111111111111111111111111111111111111111'), classifierLine);
      assert.ok(!classifierLine?.includes('--resume'), classifierLine);
      const beginLine = result.logLines.find((line) => line.includes('gate-terminal-receipt.mjs begin'));
      assert.ok(beginLine?.includes('--risk contract'), beginLine);
      assert.ok(!beginLine?.includes('--resume'), beginLine);
    },
  );

  it('maps a managed wake to the original execution owner and frozen cut', SOURCE_GATE_CONTROL_TEST_OPTIONS, (t) => {
    const frozenIdentity = {
      protocolVersion: 2,
      headSha: 'a'.repeat(40),
      treeSha: '2'.repeat(40),
      baseSha: '1'.repeat(40),
      route: 'full',
      risk: null,
      mode: 'full',
      fingerprint: 'fingerprint-test',
      runnerFingerprint: '5'.repeat(64),
      toolchainFingerprint: '6'.repeat(64),
    };
    const result = runGate(requireBash(t), [], {
      CAT_CAFE_MANAGED_GATE_FROZEN_IDENTITY_JSON: JSON.stringify(frozenIdentity),
      CAT_CAFE_MANAGED_GATE_RECONCILE_FROM: '1000',
      CAT_CAFE_MANAGED_GATE_RECOVERY_PROTOCOL: '2',
      CAT_CAFE_MANAGED_GATE_RESUME_EPOCH: '1',
      CAT_CAFE_MANAGED_JOB_ID: 'managed-current-job',
      CAT_CAFE_GATE_ORIGIN_TASK_ID: 'hold-ball-current-task',
      STUB_EXPECT_AUTO_RESUME_OWNER: '1',
      STUB_GATE_ROUTE: 'full',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.logLines.some((line) => line.startsWith('git fetch ') || line.startsWith('git rebase ')));
    assert.match(result.stdout, /恢复冻结 integration cut/u);
  });

  it(
    'keeps the source owner when an explicit continuation crosses another managed wake',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const frozenIdentity = {
        protocolVersion: 2,
        headSha: 'a'.repeat(40),
        treeSha: '2'.repeat(40),
        baseSha: '1'.repeat(40),
        route: 'full',
        risk: 'contract',
        mode: 'full',
        fingerprint: 'fingerprint-test',
        runnerFingerprint: '5'.repeat(64),
        toolchainFingerprint: '6'.repeat(64),
      };
      const result = runGate(
        requireBash(t),
        ['--resume', '11111111-2222-4333-8444-555555555555', '--risk', 'contract'],
        {
          CAT_CAFE_MANAGED_GATE_FROZEN_IDENTITY_JSON: JSON.stringify(frozenIdentity),
          CAT_CAFE_MANAGED_GATE_RECONCILE_FROM: '1000',
          CAT_CAFE_MANAGED_GATE_RECOVERY_PROTOCOL: '2',
          CAT_CAFE_MANAGED_GATE_RESUME_EPOCH: '1',
          CAT_CAFE_MANAGED_JOB_ID: 'managed-current-job',
          CAT_CAFE_GATE_ORIGIN_TASK_ID: 'carrier-task-must-not-replace-source',
          STUB_EXPECT_NESTED_RESUME_OWNER: '1',
          STUB_GATE_ROUTE: 'full',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.logLines.some((line) => line.startsWith('git fetch ') || line.startsWith('git rebase ')));
    },
  );

  it(
    'does not publish a canonical sentinel when --no-rebase finds reusable evidence',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(requireBash(t), ['--no-rebase'], { STUB_GATE_ROUTE: 'reuse' }, { sourceFixture: true });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.sentinelWritten, false);
      assert.ok(result.logLines.some((line) => line.includes('classify-gate-route.mjs')));
      assert.ok(!result.logLines.some((line) => /write-gate-last-run.sh|gate-terminal-receipt.mjs begin/.test(line)));
      assert.ok(!result.logLines.some((line) => line.startsWith('pnpm ')));
    },
  );

  it('keeps a completed --no-rebase full probe noncanonical', SOURCE_GATE_CONTROL_TEST_OPTIONS, (t) => {
    const result = runGate(requireBash(t), ['--no-rebase'], { STUB_GATE_ROUTE: 'full' }, { sourceFixture: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /route=full/);
    assert.equal(result.sentinelWritten, false);
    assert.ok(!result.logLines.some((line) => line.includes('gate-terminal-receipt.mjs begin')));
  });

  it(
    'rejects unknown browser coverage before install, claims, or durable gate creation',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(requireBash(t), [], { STUB_BROWSER_PLAN_EXIT: '3' }, { sourceFixture: true });
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stderr, /new-runtime\/data\.json/);
      assert.match(result.stderr, /unmapped-input/);
      assert.equal(result.stderr.trim().split('\n').at(-1), 'CAT_CAFE_MANAGED_TERMINAL_STATE=unverified');
      assert.equal(result.sentinelWritten, false);
      assert.ok(!result.logLines.some((line) => line.startsWith('pnpm ')));
      assert.ok(!result.logLines.some((line) => line.includes('pre-merge-gate-guard.mjs acquire')));
      assert.ok(!result.logLines.some((line) => line.includes('gate-terminal-receipt.mjs begin')));
      assert.ok(!result.logLines.some((line) => line.includes('run-browser-verification.mjs')));
    },
  );

  it(
    'runs available checks but never publishes full green while native verification is owed',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(requireBash(t), [], { STUB_NATIVE_REQUIRED: '1' }, { sourceFixture: true });
      assert.equal(result.status, 3, result.stdout + result.stderr);
      assert.match(result.stderr, /pet-window\.cjs/);
      assert.match(result.stderr, /F317-coactive-companion\.md/);
      assert.equal(result.stderr.trim().split('\n').at(-1), 'CAT_CAFE_MANAGED_TERMINAL_STATE=unverified');
      assert.ok(result.logLines.some((line) => line.includes('run-browser-verification.mjs')));
      // Every tier of the check chain still runs before the partial settlement.
      for (const tier of ['pnpm check:sources', 'pnpm check:installed', 'pnpm check:artifacts']) {
        assert.ok(
          result.logLines.some((line) => line === tier),
          `${tier} did not run`,
        );
      }
      assert.doesNotMatch(result.stdout, /GATE PASSED/);
      assert.equal(result.sentinelWritten, false);
      assert.ok(result.logLines.some((line) => line.includes('gate-terminal-receipt.mjs begin')));
      assert.ok(result.logLines.some((line) => /gate-terminal-receipt.mjs settle .*--status partial/.test(line)));
      assert.ok(!result.logLines.some((line) => /settle .*--status green|write-gate-last-run.sh/.test(line)));
    },
  );

  it(
    'keeps a real check failure failed even when native verification is also owed',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(
        requireBash(t),
        [],
        { STUB_NATIVE_REQUIRED: '1', STUB_BROWSER_VERIFICATION_EXIT: '1' },
        { sourceFixture: true },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stderr, /CAT_CAFE_MANAGED_TERMINAL_STATE=unverified/);
      assert.equal(result.sentinelWritten, false);
    },
  );

  it(
    'a follower preserves native obligations when consuming a partial producer',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(
        requireBash(t),
        [],
        {
          STUB_NATIVE_REQUIRED: '1',
          STUB_TERMINAL_ROLE: 'consumed',
          STUB_TERMINAL_STATUS: 'partial',
        },
        { sourceFixture: true },
      );
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stderr, /pet-window\.cjs/);
      assert.equal(result.stderr.trim().split('\n').at(-1), 'CAT_CAFE_MANAGED_TERMINAL_STATE=unverified');
      assert.ok(!result.logLines.some((line) => line.startsWith('pnpm ')));
      assert.ok(!result.logLines.some((line) => line.includes('gate-terminal-receipt.mjs settle')));
      assert.equal(result.sentinelWritten, false);
    },
  );

  it(
    'surfaces browser coverage planner errors before expensive work without claiming a classified result',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(requireBash(t), [], { STUB_BROWSER_PLAN_EXIT: '1' }, { sourceFixture: true });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Browser catalog requires explicit admission/);
      assert.doesNotMatch(result.stderr, /CAT_CAFE_MANAGED_TERMINAL_STATE/);
      assert.ok(!result.logLines.some((line) => line.startsWith('pnpm ')));
      assert.equal(result.sentinelWritten, false);
    },
  );

  it(
    'preflights browser coverage from the frozen planner before the full stages',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(requireBash(t), [], {}, { sourceFixture: true });
      assert.equal(result.status, 0, result.stderr);
      const index = result.logLines.findIndex((line) => line.includes('plan-browser-verification.mjs'));
      assert.ok(index >= 0);
      assert.match(result.logLines[index], /cat-cafe-gate-control\.[^/]+\/scripts\/plan-browser-verification\.mjs/);
      assert.match(result.logLines[index], /--head a{40} --base 1{40} --mode merge/);
      assert.ok(index < result.logLines.indexOf('pnpm install --frozen-lockfile'));
      assert.ok(result.logLines.some((line) => line.includes('run-browser-verification.mjs')));
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
      rootCheckChain(packageJson.scripts),
      /(?:^|&& )pnpm check:dir-size(?: &&|$)/,
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

  it('keeps an existing latest-main merge instead of replaying both feature parents', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { STUB_BASE_IS_ANCESTOR: '1' });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.logLines.includes('git merge-base --is-ancestor 1111111111111111111111111111111111111111 HEAD'));
    assert.ok(!result.logLines.some((line) => line.startsWith('git rebase ')));
    assert.match(result.stdout, /already contains frozen origin\/main/i);
    assert.ok(result.logLines.includes('pnpm install --frozen-lockfile'));
  });

  it('fails before post-rebase commands when latest-main ancestry cannot be checked', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { STUB_MERGE_BASE_ERROR: '1' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot verify frozen origin\/main ancestry/i);
    assert.ok(!result.logLines.some((line) => line.startsWith('git rebase ')));
    assert.ok(!result.logLines.some((line) => line.includes('classify-gate-route.mjs')));
  });

  testSourceAndPublic('preserves published branch history when main advances after a merge', (t, fixture) => {
    const result = runGate(requireBash(t), [], { STUB_PUBLISHED_BRANCH: '1' }, fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.logLines.filter((line) => line.startsWith('git merge ')).length,
      1,
      `${result.stdout}\n${result.stderr}\n${result.logLines.join('\n')}`,
    );
    assert.ok(!result.logLines.some((line) => line.startsWith('git rebase ')));
    assert.match(result.stdout, /preserving published branch history/i);
    assert.match(result.stdout, /restarting gate from the merged tree/i);
    const merge = result.logLines.findIndex((line) => line.startsWith('git merge '));
    const validation = fixture.publicSyncFixture
      ? result.logLines.indexOf('pnpm check:sources')
      : result.logLines.findIndex((line) => line.includes('classify-gate-route.mjs'));
    assert.ok(merge >= 0 && validation > merge, result.logLines.join('\n'));
  });

  it('real git preserves the published merge resolution when main advances', (t) => {
    const bash = requireBash(t);
    const root = mkdtempSync(path.join(os.tmpdir(), 'f325-published-gate-'));
    const git = (args, status = 0) => {
      const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(result.status, status, result.stderr);
      return result.stdout.trim();
    };
    try {
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.name', 'Gate Fixture']);
      git(['config', 'user.email', 'gate-fixture@example.invalid']);
      git(['config', 'core.hooksPath', '/dev/null']);
      git(['config', 'commit.gpgsign', 'false']);
      writeFileSync(path.join(root, 'base.txt'), 'base\n');
      git(['add', '.']);
      git(['commit', '-qm', 'base']);
      git(['checkout', '-qb', 'fix/test']);
      writeFileSync(path.join(root, 'probe.md'), 'author probe\n');
      git(['add', '.']);
      git(['commit', '-qm', 'author probe']);
      git(['checkout', '-q', 'main']);
      writeFileSync(path.join(root, 'probe.md'), 'main probe\n');
      git(['add', '.']);
      git(['commit', '-qm', 'main probe']);
      git(['checkout', '-q', 'fix/test']);
      git(['merge', '--no-edit', 'main'], 1);
      writeFileSync(path.join(root, 'probe.md'), 'author probe\n');
      git(['add', '.']);
      git(['commit', '-qm', 'preserved merge resolution']);
      const published = git(['rev-parse', 'HEAD']);
      git(['update-ref', 'refs/remotes/origin/fix/test', published]);
      git(['checkout', '-q', 'main']);
      writeFileSync(path.join(root, 'advanced.txt'), 'new main\n');
      git(['add', '.']);
      git(['commit', '-qm', 'main advanced']);
      const base = git(['rev-parse', 'HEAD']);
      git(['checkout', '-q', 'fix/test']);

      const source = readFileSync(scriptPath, 'utf8');
      const start = source.indexOf('  ANCESTRY_RESULT=0\n');
      const end = source.indexOf('  record_step "rebase"', start);
      assert.ok(start > 0 && end > start);
      const result = spawnSync(bash, ['-c', `set -euo pipefail\n${source.slice(start, end)}`], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GATE_BASE_SHA: base, BRANCH: 'fix/test', RED: '', GREEN: '', NC: '' },
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      git(['merge-base', '--is-ancestor', published, 'HEAD']);
      git(['merge-base', '--is-ancestor', base, 'HEAD']);
      assert.equal(readFileSync(path.join(root, 'probe.md'), 'utf8'), 'author probe\n');
      assert.equal(readFileSync(path.join(root, 'advanced.txt'), 'utf8'), 'new main\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  testSourceAndPublic('rebases unpublished work when the published tip is already in main', (t, fixture) => {
    const result = runGate(requireBash(t), [], { STUB_PUBLISHED_BRANCH: '1', STUB_PUBLISHED_IN_MAIN: '1' }, fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.logLines.some((line) => line.startsWith('git rebase ')));
    assert.ok(!result.logLines.some((line) => line.startsWith('git merge ')));
  });

  testSourceAndPublic(
    'keeps the existing rebase policy when the tracked published tip is outside local history',
    (t, fixture) => {
      const result = runGate(requireBash(t), [], { STUB_PUBLISHED_BRANCH: '1', STUB_REMOTE_DIVERGED: '1' }, fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.logLines.some((line) => line.startsWith('git rebase ')));
      assert.ok(!result.logLines.some((line) => line.startsWith('git merge ')));
      assert.ok(!result.logLines.includes(`git merge-base --is-ancestor ${'3'.repeat(40)} ${'1'.repeat(40)}`));
    },
  );

  testSourceAndPublic('fails closed when published branch ancestry cannot be verified', (t, fixture) => {
    const result = runGate(
      requireBash(t),
      [],
      { STUB_PUBLISHED_BRANCH: '1', STUB_PUBLISHED_ANCESTRY_ERROR: '1' },
      fixture,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot verify published branch ancestry/i);
    assert.ok(!result.logLines.some((line) => /^git (merge|rebase) /.test(line)));
    assert.ok(!result.logLines.some((line) => line.includes('classify-gate-route.mjs')));
  });

  testSourceAndPublic(
    'does not fall back to history replay when a publication-preserving merge conflicts',
    (t, fixture) => {
      const result = runGate(
        requireBash(t),
        [],
        { STUB_PUBLISHED_BRANCH: '1', STUB_PUBLICATION_MERGE_FAIL: '1' },
        fixture,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /published branch merge failed/i);
      assert.ok(!result.logLines.some((line) => line.startsWith('git rebase ')));
      assert.ok(!result.logLines.some((line) => line.includes('classify-gate-route.mjs')));
    },
  );

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
        'check-sources',
        'check-installed',
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
      assert.match(settle, /--required-stages check-sources,check-installed,tsc,test-non-browser/);
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
      const timedStageGreen = result.logLines.find(
        (line) => line.includes('gate-terminal-receipt.mjs stage-green') && line.includes('--stage test-non-browser'),
      );
      const settle = result.logLines.find((line) => line.includes('gate-terminal-receipt.mjs settle'));
      assert.match(stageGreen, /--duration-ms \d+ --route full/);
      assert.match(timedStageGreen, /--test-file-timing-artifact .*test-non-browser\.json/);
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

  testSourceAndPublic('allows full test mode to be forced explicitly', (t, fixture) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { CAT_CAFE_GATE_TEST_MODE: 'full' }, fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.logLines.includes('pnpm -r --workspace-concurrency=1 --if-present --filter !@cat-cafe/web run test'),
      `expected non-browser workspace tests, got:\n${result.logLines.join('\n')}`,
    );
    const plannedBrowser = result.logLines.some(
      (line) => line.includes('run-browser-verification.mjs') && line.includes('--mode merge'),
    );
    const publicBrowser = result.logLines.includes('pnpm --filter @cat-cafe/web run test:browser');
    assert.equal(plannedBrowser, !fixture.publicSyncFixture, result.logLines.join('\n'));
    assert.equal(publicBrowser, Boolean(fixture.publicSyncFixture), result.logLines.join('\n'));
    for (const script of ['test:unit', 'test:guards']) {
      assert.ok(result.logLines.includes(`pnpm --filter @cat-cafe/web run ${script}`), result.logLines.join('\n'));
    }
    assert.ok(
      !result.logLines.includes('pnpm --filter @cat-cafe/api run test:public'),
      `full mode must not run public test suite, got:\n${result.logLines.join('\n')}`,
    );
  });

  it(
    'passes a frozen browser plan to its executor without a second outer permit',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(requireBash(t), [], {}, { sourceFixture: true });
      assert.equal(result.status, 0, result.stderr);
      const call = result.logLines.find(
        (line) => line.startsWith('node ') && line.includes('run-browser-verification.mjs'),
      );
      assert.ok(call, result.logLines.join('\n'));
      assert.match(call, /--head a{40} --base 1{40} --mode merge/);
      assert.ok(result.logLines.includes('browser-outer-permit <unset>'));
      assert.ok(!result.logLines.includes('pnpm --filter @cat-cafe/web run test:browser'));
    },
  );

  it(
    'unverified browser coverage cannot write a green stage or full sentinel',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(requireBash(t), [], { STUB_BROWSER_VERIFICATION_EXIT: '3' }, { sourceFixture: true });
      assert.notEqual(result.status, 0);
      assert.ok(!result.logLines.some((line) => /stage-green .*--stage test-web-browser/.test(line)));
      assert.ok(!result.logLines.some((line) => line.includes('write-gate-last-run.sh')));
    },
  );

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

describe('gate S1 determinism: environment matrix and targeted terminal state', () => {
  it(
    'rejects home membership admission before targeted exit or shared resource acquisition',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(
        requireBash(t),
        ['--no-rebase'],
        {
          STUB_GATE_ROUTE: 'targeted',
          STUB_BROWSER_MEMBERSHIP_EXIT: '2',
        },
        { sourceFixture: true },
      );
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /Browser journey has no admitted owner reference/);
      assert.ok(
        result.logLines.some((line) =>
          /cat-cafe-gate-control\.[^/]+\/scripts\/check-gate-browser-membership\.mjs/.test(line),
        ),
      );
      assert.ok(!result.logLines.some((line) => line.startsWith('pnpm ') || line.includes('write-gate-last-run.sh')));
    },
  );

  it('public exports run without loading the private browser catalog or owner documents', (t) => {
    const result = runGate(
      requireBash(t),
      ['--no-rebase'],
      {
        STUB_BROWSER_MEMBERSHIP_EXIT: '2',
      },
      { publicSyncFixture: true },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.logLines.some((line) => line.includes('check-gate-browser-membership.mjs')));
    assert.ok(result.logLines.some((line) => line.includes('run test:public')));
  });

  it('never lets a production NODE_ENV reach any gate stage', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], {
      NODE_ENV: 'production',
      npm_config_production: 'true',
      NPM_CONFIG_PRODUCTION: 'true',
    });

    assert.equal(result.status, 0, result.stderr);
    const stageEnv = result.logLines.filter((line) => line.startsWith('stage-env '));
    assert.ok(stageEnv.length > 0, `expected per-stage env evidence, got:\n${result.logLines.join('\n')}`);
    const leaked = stageEnv.filter((line) => !/NODE_ENV=<unset>/.test(line));
    assert.deepEqual(leaked, [], `production NODE_ENV reached these stages:\n${leaked.join('\n')}`);
    const productionFlags = stageEnv.filter(
      (line) => !/npm_config_production=<unset> NPM_CONFIG_PRODUCTION=<unset>/.test(line),
    );
    assert.deepEqual(
      productionFlags,
      [],
      `production install flags reached these stages:\n${productionFlags.join('\n')}`,
    );
  });

  it('keeps the install stage devDependency semantics intact', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { NODE_ENV: 'production' });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.logLines.some((line) =>
        /^env NODE_ENV=<unset> npm_config_production=<unset> NPM_CONFIG_PRODUCTION=<unset>$/.test(line),
      ),
      `install must still resolve devDependencies, got:\n${result.logLines.join('\n')}`,
    );
  });

  it(
    'reports a targeted route as unverified instead of exiting successfully',
    SOURCE_GATE_CONTROL_TEST_OPTIONS,
    (t) => {
      const result = runGate(requireBash(t), ['--no-rebase'], {
        CAT_CAFE_PROCESS_OWNER_ID: 'cat-owned-process',
        STUB_GATE_ROUTE: 'targeted',
      });

      assert.notEqual(result.status, 0, 'a classified-but-unverified gate must not report success');
      assert.equal(result.status, 3, `expected the dedicated unverified exit code, got ${result.status}`);
      assert.match(`${result.stdout}${result.stderr}`, /UNVERIFIED/);
      // `sentinelWritten` observes a gitignored file shared by every non-fixture
      // run in this file, so assert the action instead of the residue.
      assert.ok(
        !result.logLines.some((line) => line.includes('write-gate-last-run.sh')),
        `an unverified route must not publish freshness evidence, got:\n${result.logLines.join('\n')}`,
      );
    },
  );

  it('declares its unverified terminal for the managed wake renderer', SOURCE_GATE_CONTROL_TEST_OPTIONS, (t) => {
    const result = runGate(requireBash(t), ['--no-rebase'], {
      CAT_CAFE_PROCESS_OWNER_ID: 'cat-owned-process',
      STUB_GATE_ROUTE: 'targeted',
    });

    // The managed runner captures stdout+stderr and keeps only the tail, so the
    // declaration has to be the final line or the renderer never sees it.
    const lines = `${result.stdout}${result.stderr}`.trim().split('\n');
    assert.equal(lines.at(-1)?.trim(), 'CAT_CAFE_MANAGED_TERMINAL_STATE=unverified');
  });

  it('names the evidence a targeted route still owes', SOURCE_GATE_CONTROL_TEST_OPTIONS, (t) => {
    const result = runGate(requireBash(t), ['--no-rebase'], {
      CAT_CAFE_PROCESS_OWNER_ID: 'cat-owned-process',
      STUB_GATE_ROUTE: 'targeted',
    });

    const terminal = `${result.stdout}${result.stderr}`;
    assert.match(terminal, /risk-matched-targeted-evidence|targeted-checks|cross-package-typecheck/);
  });

  it('still reports reusable full-green evidence as success', SOURCE_GATE_CONTROL_TEST_OPTIONS, (t) => {
    const result = runGate(requireBash(t), ['--no-rebase'], { STUB_GATE_ROUTE: 'reuse' }, { sourceFixture: true });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /UNVERIFIED/);
  });
});
