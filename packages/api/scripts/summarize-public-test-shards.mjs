import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePublicTestShardPlan } from './plan-public-test-shards.mjs';
import { normalizePublicTestCliArgv } from './public-test-cli-args.mjs';
import {
  samePublicTestProvenance,
  stablePublicTestValue,
  validatePublicTestProvenance,
} from './public-test-provenance.mjs';
import {
  atomicPublicTestJsonWrite,
  comparePublicTestStrings,
  publicTestInvariant as invariant,
  parsePublicTestCliOptions,
} from './public-test-support.mjs';

function expectedLaneFiles(plan, lane) {
  const shard = [plan.sharedSerialLane, ...plan.distributableShards].find((candidate) => candidate.id === lane);
  invariant(shard, `plan has no lane ${lane}`);
  return [...shard.files];
}

function assertExactFiles(actual, expected, lane) {
  invariant(Array.isArray(actual), `${lane} report files must be an array`);
  const names = actual.map((file) => file.file).sort();
  const wanted = [...expected].sort();
  invariant(
    names.length === wanted.length && names.every((file, index) => file === wanted[index]),
    `${lane} report does not cover its exact planned files`,
  );
  invariant(new Set(names).size === names.length, `${lane} report contains duplicate file timing`);
  for (const file of actual) {
    invariant(file && typeof file === 'object', `${lane} report file is invalid`);
    invariant(file.status === 'passed', `${lane} report has non-green file ${file.file}`);
    invariant(
      Number.isFinite(file.durationMs) && file.durationMs >= 0,
      `${lane} report has invalid duration for ${file.file}`,
    );
    invariant(
      typeof file.failureCategory === 'string' && file.failureCategory.length > 0,
      `${lane} report has no failure category for ${file.file}`,
    );
  }
}

export function summarizePublicTestShardReports({ plan, reports, maxCriticalPathMs }) {
  validatePublicTestShardPlan(plan, plan.selectedFiles);
  invariant(Array.isArray(reports), 'reports must be an array');
  if (maxCriticalPathMs !== undefined) {
    invariant(
      Number.isFinite(maxCriticalPathMs) && maxCriticalPathMs > 0,
      'critical-path budget must be a positive finite number',
    );
  }
  const distributableLanes = plan.distributableShards.map((shard) => shard.id);
  const expectedLanes = [plan.sharedSerialLane.id, ...distributableLanes];
  const byLane = new Map();
  for (const report of reports) {
    invariant(
      report && report.schemaVersion === 2 && report.kind === 'public_test_shard_run',
      'invalid public-test shard report',
    );
    invariant(report.planFingerprint === plan.planFingerprint, 'report plan fingerprint does not match');
    invariant(report.selectionHash === plan.selectionHash, 'report selection hash does not match');
    invariant(
      report.exclusionRegistryHash === plan.exclusionRegistryHash,
      'report exclusion registry hash does not match',
    );
    invariant(expectedLanes.includes(report.lane), `report has unknown lane ${report.lane}`);
    invariant(!byLane.has(report.lane), `duplicate report for lane ${report.lane}`);
    invariant(report.status === 'succeeded', `${report.lane} report is not green`);
    invariant(report.provenance && typeof report.provenance === 'object', `${report.lane} report lacks provenance`);
    byLane.set(report.lane, report);
  }
  invariant(byLane.size === expectedLanes.length, 'missing public-test shard report');
  const referenceProvenance = validatePublicTestProvenance(byLane.get(expectedLanes[0]).provenance);
  invariant(
    samePublicTestProvenance(plan.plannerProvenance, referenceProvenance),
    'report provenance does not match the frozen plan',
  );
  const timings = {};
  const lanes = [];
  for (const lane of expectedLanes) {
    const report = byLane.get(lane);
    invariant(samePublicTestProvenance(report.provenance, referenceProvenance), `${lane} runner provenance differs`);
    const expectedFiles = expectedLaneFiles(plan, lane);
    assertExactFiles(report.files, expectedFiles, lane);
    for (const file of report.files) timings[file.file] = file.durationMs;
    lanes.push({
      lane,
      fileCount: report.files.length,
      elapsedMs: report.elapsedMs,
      runnerMinutes: report.elapsedMs / 60_000,
    });
  }
  const selected = Object.keys(timings).sort();
  invariant(
    selected.length === plan.selectedFiles.length &&
      selected.every((file, index) => file === plan.selectedFiles[index]),
    'shard reports do not cover every selected test exactly once',
  );
  const elapsedValues = lanes.map((lane) => lane.elapsedMs);
  const summary = {
    schemaVersion: 2,
    kind: 'public_test_shard_summary',
    status: 'succeeded',
    planFingerprint: plan.planFingerprint,
    selectionHash: plan.selectionHash,
    exclusionRegistryHash: plan.exclusionRegistryHash,
    selectedFileCount: selected.length,
    lanes,
    sharedSerialLaneMs: byLane.get(plan.sharedSerialLane.id).elapsedMs,
    distributableCriticalPathMs: Math.max(...distributableLanes.map((lane) => byLane.get(lane).elapsedMs)),
    distributableAggregateMs: distributableLanes.reduce((total, lane) => total + byLane.get(lane).elapsedMs, 0),
    criticalPathMs: Math.max(...elapsedValues),
    runnerMinutes: lanes.reduce((total, lane) => total + lane.runnerMinutes, 0),
    perFileTimings: Object.fromEntries(
      Object.entries(timings).sort(([left], [right]) => comparePublicTestStrings(left, right)),
    ),
    provenance: stablePublicTestValue(referenceProvenance),
  };
  if (maxCriticalPathMs !== undefined) {
    invariant(
      summary.criticalPathMs <= maxCriticalPathMs,
      `public-test critical path ${summary.criticalPathMs}ms exceeds budget ${maxCriticalPathMs}ms`,
    );
  }
  return summary;
}

function percentile(values, fraction) {
  invariant(values.length > 0, 'percentile requires at least one value');
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

export function summarizePublicTestMeasurementHistory(summaries) {
  invariant(Array.isArray(summaries) && summaries.length >= 3, 'at least three same-selection summaries are required');
  const first = summaries[0];
  for (const summary of summaries) {
    invariant(
      summary?.kind === 'public_test_shard_summary' && summary.status === 'succeeded',
      'history must contain green shard summaries',
    );
    invariant(summary.selectionHash === first.selectionHash, 'measurement selection changed between runs');
    invariant(
      summary.exclusionRegistryHash === first.exclusionRegistryHash,
      'measurement exclusion registry changed between runs',
    );
    invariant(
      summary.selectedFileCount === first.selectedFileCount,
      'measurement selected-file count changed between runs',
    );
    invariant(
      samePublicTestProvenance(summary.provenance, first.provenance),
      'measurement provenance changed between runs',
    );
    invariant(
      Number.isFinite(summary.criticalPathMs) && summary.criticalPathMs >= 0,
      'measurement critical path is invalid',
    );
  }
  const paths = summaries.map((summary) => summary.criticalPathMs);
  return {
    schemaVersion: 1,
    kind: 'public_test_measurement_history',
    selectionHash: first.selectionHash,
    exclusionRegistryHash: first.exclusionRegistryHash,
    selectedFileCount: first.selectedFileCount,
    sampleCount: summaries.length,
    p50CriticalPathMs: percentile(paths, 0.5),
    p95CriticalPathMs: percentile(paths, 0.95),
    targetP50Ms: 10 * 60_000,
    targetP95Ms: 12 * 60_000,
    targetMet: percentile(paths, 0.5) <= 10 * 60_000 && percentile(paths, 0.95) <= 12 * 60_000,
  };
}

async function findJsonFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await findJsonFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  }
  return files.sort();
}

async function main() {
  const options = parsePublicTestCliOptions(normalizePublicTestCliArgv(process.argv.slice(2)));
  if (options.help) {
    process.stdout.write(
      'Usage: node packages/api/scripts/summarize-public-test-shards.mjs --plan <path> --reports-dir <path> --output <path> [--max-critical-path-ms <milliseconds>]\n',
    );
    return;
  }
  for (const name of ['plan', 'reports-dir', 'output']) invariant(options[name], `--${name} is required`);
  const maxCriticalPathMs =
    options['max-critical-path-ms'] === undefined ? undefined : Number(options['max-critical-path-ms']);
  if (maxCriticalPathMs !== undefined) {
    invariant(
      Number.isFinite(maxCriticalPathMs) && maxCriticalPathMs > 0,
      '--max-critical-path-ms must be a positive finite number',
    );
  }
  const plan = JSON.parse(await readFile(resolve(options.plan), 'utf8'));
  const reports = [];
  for (const path of await findJsonFiles(resolve(options['reports-dir']))) {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value.kind === 'public_test_shard_run') reports.push(value);
  }
  const summary = summarizePublicTestShardReports({ plan, reports, maxCriticalPathMs });
  await atomicPublicTestJsonWrite(options.output, summary);
  process.stdout.write(
    `public-test summary: selected=${summary.selectedFileCount} critical_path_ms=${summary.criticalPathMs} runner_minutes=${summary.runnerMinutes.toFixed(2)}\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
