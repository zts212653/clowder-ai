import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePublicTestShardPlan } from './plan-public-test-shards.mjs';
import { normalizePublicTestCliArgv } from './public-test-cli-args.mjs';
import { currentPublicTestProvenance, samePublicTestProvenance } from './public-test-provenance.mjs';
import {
  atomicPublicTestJsonWrite,
  publicTestInvariant as invariant,
  parsePublicTestCliOptions,
} from './public-test-support.mjs';
import { buildPublicTestManifest, resolvePublicTestFiles } from './resolve-public-test-files.mjs';

const OUTPUT_TAIL_BYTES = 16 * 1024;

function tailAppend(previous, chunk) {
  const combined = `${previous}${chunk}`;
  return combined.length > OUTPUT_TAIL_BYTES ? combined.slice(-OUTPUT_TAIL_BYTES) : combined;
}

export function filesForPublicTestLane(plan, lane) {
  validatePublicTestShardPlan(plan, plan.selectedFiles);
  if (lane === 'serial') return [...plan.lanes.serial.files];
  const shard = plan.pureShards.find((candidate) => candidate.id === lane);
  invariant(shard, `unknown public-test shard lane: ${lane}`);
  return [...shard.files];
}

export function categorizePublicTestFailure({ exitCode, signal, output = '' }) {
  if (exitCode === 0 && !signal) return 'passed';
  if (signal) return 'process_signal';
  if (/EADDRINUSE|address already in use|ECONNREFUSED|Redis|ioredis|REDIS_URL/i.test(output))
    return 'state_or_port_failure';
  if (/ENOMEM|heap out of memory|EMFILE|ENFILE/i.test(output)) return 'resource_exhaustion';
  if (/ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND/i.test(output)) return 'dependency_or_build_failure';
  if (/Timed out|timeout/i.test(output)) return 'timeout';
  return 'test_failure';
}

export async function runNodePublicTestFile({ file, packageRoot, env = process.env }) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const outputHash = createHash('sha256');
  let outputTail = '';
  const child = spawn(
    process.execPath,
    ['--import', resolve(packageRoot, 'test/helpers/setup-cat-registry.js'), '--test', '--test-concurrency=1', file],
    {
      cwd: packageRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const observe = (chunk) => {
    const text = chunk.toString();
    outputHash.update(chunk);
    outputTail = tailAppend(outputTail, text);
    return text;
  };
  child.stdout.on('data', (chunk) => process.stdout.write(observe(chunk)));
  child.stderr.on('data', (chunk) => process.stderr.write(observe(chunk)));
  const outcome = await new Promise((resolveOutcome, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolveOutcome({ exitCode, signal }));
  });
  const finishedAt = new Date().toISOString();
  return {
    file,
    status: outcome.exitCode === 0 && !outcome.signal ? 'passed' : 'failed',
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    durationMs: Date.now() - startedMs,
    startedAt,
    finishedAt,
    outputHash: outputHash.digest('hex'),
    outputTail,
    failureCategory: categorizePublicTestFailure({ ...outcome, output: outputTail }),
  };
}

export async function runPublicTestLane({ plan, lane, packageRoot, manifest, executeFile = runNodePublicTestFile }) {
  validatePublicTestShardPlan(plan, manifest.selectedFiles);
  invariant(
    plan.selectionHash === manifest.selectionHash,
    'plan does not match the current selected public test manifest',
  );
  invariant(
    plan.exclusionRegistryHash === manifest.exclusionRegistryHash,
    'plan does not match the current exclusion registry',
  );
  const provenance = currentPublicTestProvenance(packageRoot);
  invariant(
    samePublicTestProvenance(plan.plannerProvenance, provenance),
    'plan provenance does not match the current workspace, lockfile, toolchain, or runner',
  );
  if (plan.timingSource.kind === 'public_test_shard_summary') {
    invariant(
      samePublicTestProvenance(plan.timingSource.provenance, provenance),
      'timing provenance does not match the current workspace, lockfile, toolchain, or runner',
    );
  }
  const files = filesForPublicTestLane(plan, lane);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const results = [];
  for (const file of files) {
    const result = await executeFile({ file, packageRoot });
    results.push(result);
    if (result.status !== 'passed') break;
  }
  const firstHardFailure = results.find((result) => result.status !== 'passed');
  const finishedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    kind: 'public_test_shard_run',
    planFingerprint: plan.planFingerprint,
    selectionHash: plan.selectionHash,
    exclusionRegistryHash: plan.exclusionRegistryHash,
    lane,
    plannedFileCount: files.length,
    files: results.map(({ outputTail, ...result }) => result),
    status: firstHardFailure ? 'failed' : 'succeeded',
    startedAt,
    finishedAt,
    elapsedMs: Date.now() - startedMs,
    provenance,
    ...(firstHardFailure
      ? {
          firstHardFailure: {
            code: firstHardFailure.failureCategory,
            stage: lane,
            message: `${firstHardFailure.file} failed`,
            nextAction: 'inspect_public_test_shard_artifact',
          },
        }
      : {}),
  };
}

async function main() {
  const options = parsePublicTestCliOptions(normalizePublicTestCliArgv(process.argv.slice(2)));
  if (options.help) {
    process.stdout.write(
      'Usage: node packages/api/scripts/run-public-test-shard.mjs --plan <path> --lane <serial|pure-N> --report <path>\n',
    );
    return;
  }
  for (const name of ['plan', 'lane', 'report']) invariant(options[name], `--${name} is required`);
  const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const plan = JSON.parse(await readFile(resolve(options.plan), 'utf8'));
  const manifest = buildPublicTestManifest(await resolvePublicTestFiles({ packageRoot }));
  const report = await runPublicTestLane({ plan, lane: options.lane, packageRoot, manifest });
  await atomicPublicTestJsonWrite(options.report, report);
  process.stdout.write(
    `public-test shard ${report.lane}: status=${report.status} files=${report.files.length} elapsed_ms=${report.elapsedMs} plan=${report.planFingerprint}\n`,
  );
  process.exitCode = report.status === 'succeeded' ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
