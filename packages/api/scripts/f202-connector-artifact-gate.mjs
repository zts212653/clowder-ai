/**
 * F202 C1 cross-repository artifact gate - the mandatory lane (review P1, PR #1487 comment 5830747045).
 *
 * The ordinary test lane skips when the connector archives are absent, so its exit code cannot
 * close the gate. This runner can pass only by executing every case against the pinned bytes:
 * - the platform matches the self-contained archives (darwin-arm64);
 * - the worktree is clean, so executedSha names the code that ran, and the Host runtime is rebuilt
 *   from it;
 * - every archive's SHA-256 equals its pin, from --archives <dir> or downloaded from the release;
 * - the gate runs with F202_ARTIFACT_GATE_REQUIRED=1, where a missing archive fails instead of
 *   skipping;
 * - it passes only when all expected cases pass and none fails, is skipped, cancelled or todo.
 * The receipt (JSON on stdout) binds all of that; the exit code is 1 otherwise.
 *
 * Usage (from packages/api):
 *   node scripts/f202-connector-artifact-gate.mjs --release          download the pinned release assets
 *   node scripts/f202-connector-artifact-gate.mjs --archives <dir>   use an existing download
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ARTIFACT_PLATFORM,
  ARTIFACT_RELEASE,
  archiveFileName,
  EXPECTED_CASES,
  PLUGIN_SOURCE,
  RELEASES,
} from '../test/helpers/f202-connector-artifact-pins.js';
import { gitOutput, rebuildHostRuntime } from './m0d-acceptance-provenance.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const apiRoot = resolve(import.meta.dirname, '..');

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

/** The summary node:test prints at the end of a TAP run. */
function tapCounts(output) {
  const count = (name) => {
    const match = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(output);
    return match ? Number(match[1]) : null;
  };
  return {
    tests: count('tests'),
    pass: count('pass'),
    fail: count('fail'),
    cancelled: count('cancelled'),
    skipped: count('skipped'),
    todo: count('todo'),
  };
}

async function archiveSource() {
  if (process.argv.includes('--release')) {
    const dir = await mkdtemp(join(tmpdir(), 'f202-artifact-gate-'));
    const { repository, tag } = ARTIFACT_RELEASE;
    const download = await run('gh', ['release', 'download', tag, '--repo', repository, '--dir', dir]);
    if (download.code !== 0) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(`cannot download ${repository}@${tag}: ${download.stderr.trim()}`);
    }
    return { dir, source: `github-release:${repository}@${tag}`, temporary: true };
  }
  const index = process.argv.indexOf('--archives');
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('pass --release, or --archives <dir>');
  return { dir: resolve(value), source: `directory:${resolve(value)}`, temporary: false };
}

async function digestAll(dir) {
  const artifacts = [];
  for (const release of RELEASES) {
    const file = archiveFileName(release);
    let sha256 = null;
    try {
      sha256 = createHash('sha256')
        .update(await readFile(join(dir, file)))
        .digest('hex');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    artifacts.push({ name: release.name, file, pinnedSha256: release.sha, sha256, matches: sha256 === release.sha });
  }
  return artifacts;
}

if (process.platform !== ARTIFACT_PLATFORM.platform || process.arch !== ARTIFACT_PLATFORM.arch) {
  throw new Error(
    `the pinned archives are ${ARTIFACT_PLATFORM.platform}-${ARTIFACT_PLATFORM.arch} builds; this host is ${process.platform}-${process.arch}`,
  );
}
const [executedSha, worktreeStatus] = await Promise.all([
  gitOutput(['rev-parse', 'HEAD'], repositoryRoot),
  gitOutput(['status', '--porcelain'], repositoryRoot),
]);
if (worktreeStatus !== '') {
  throw new Error('the artifact gate requires a clean worktree so executedSha identifies the executed code');
}

const startedAt = new Date().toISOString();
const archives = await archiveSource();
try {
  const artifacts = await digestAll(archives.dir);
  const digestsMatch = artifacts.every(({ matches }) => matches);
  let runtime = null;
  let counts = null;
  let testExitCode = null;
  let outputTail;
  if (digestsMatch) {
    runtime = await rebuildHostRuntime(repositoryRoot);
    const [rebuiltSha, rebuiltStatus] = await Promise.all([
      gitOutput(['rev-parse', 'HEAD'], repositoryRoot),
      gitOutput(['status', '--porcelain'], repositoryRoot),
    ]);
    if (rebuiltSha !== executedSha || rebuiltStatus !== '') {
      throw new Error('Host runtime rebuild changed the executed commit or worktree');
    }
    const gate = await run(
      'bash',
      [
        './scripts/with-test-home.sh',
        process.execPath,
        '--import',
        join(apiRoot, 'test/helpers/setup-cat-registry.js'),
        '--test',
        '--test-reporter=tap',
        '--test-timeout=180000',
        'test/f202-c1-connector-artifact-gate.test.js',
      ],
      {
        cwd: apiRoot,
        env: {
          ...process.env,
          F202_W25PH_ARCHIVE_DIR: archives.dir,
          F202_ARTIFACT_GATE_REQUIRED: '1',
          CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
        },
      },
    );
    counts = tapCounts(gate.stdout);
    testExitCode = gate.code;
    outputTail = `${gate.stdout}\n${gate.stderr}`.slice(-6000);
  }
  const passed =
    digestsMatch &&
    testExitCode === 0 &&
    counts?.tests === EXPECTED_CASES &&
    counts?.pass === EXPECTED_CASES &&
    counts?.fail === 0 &&
    counts?.cancelled === 0 &&
    counts?.skipped === 0 &&
    counts?.todo === 0;
  const report = {
    schemaVersion: 1,
    gate: 'f202-c1-connector-artifact-gate',
    startedAt,
    finishedAt: new Date().toISOString(),
    integrity: {
      host: { repository: 'zts212653/clowder-ai', executedSha, runtime },
      plugins: PLUGIN_SOURCE,
      artifactSource: archives.source,
      artifactPlatform: ARTIFACT_PLATFORM,
      artifacts,
    },
    execution: { node: process.version, platform: process.platform, arch: process.arch },
    acceptance: { passed, expectedCases: EXPECTED_CASES, counts, testExitCode, digestsMatch },
    scope:
      'Service-level cross-repository exercise: each admitted package runs in-process through its SDK module factory against a Host object composed from Host services (installer admission, publishing seam, W2-5b media job, SubscriptionDelivery, caller-bound subscription session, media read service).',
    nonClaims: [
      'Not a production carrier or plugin-process smoke: the packages are imported in-process, not supervised by the Host runtime.',
      'The IM platform adapter is a probe; no real IM credential or external delivery was exercised.',
      "The cat display name comes from a fixture standing in for the Host's cat registry.",
      'No live Clowder AI runtime, persistent data store or reserved port was used; each case ran in a temporary directory.',
    ],
    ...(passed ? {} : { outputTail }),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  if (archives.temporary) await rm(archives.dir, { recursive: true, force: true });
}
