import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePublicTestShardPlan } from './plan-public-test-shards.mjs';
import { normalizePublicTestCliArgv } from './public-test-cli-args.mjs';
import {
  publicTestInvariant as invariant,
  parsePublicTestCliOptions,
  readPublicTestJson,
} from './public-test-support.mjs';

/** GitHub artifact IDs are not an attempt order. Producer names carry the
 * workflow attempt; never use report status to choose admissible evidence. */
export function selectPublicTestReportArtifacts({ plan, artifactDirectories, sha, attempt }) {
  validatePublicTestShardPlan(plan, plan.selectedFiles);
  invariant(/^[a-f0-9]{40}$/.test(sha), 'report selection requires the exact 40-character workflow SHA');
  invariant(Number.isSafeInteger(attempt) && attempt > 0, 'current workflow attempt must be a positive safe integer');
  invariant(Array.isArray(artifactDirectories), 'artifact directories must be an array');
  const lanes = [plan.sharedSerialLane.id, ...plan.distributableShards.map(({ id }) => id)];
  const selected = new Map();
  const seen = new Set();
  for (const directory of artifactDirectories) {
    invariant(typeof directory === 'string' && !seen.has(directory), 'invalid or duplicate artifact directory');
    seen.add(directory);
    const match = /^public-test-report-([a-f0-9]{40})-(.+)-attempt-([1-9]\d*)$/.exec(directory);
    invariant(match, `invalid attempt-qualified report artifact directory: ${directory}`);
    const [, commit, lane, rawAttempt] = match;
    invariant(commit === sha, `report artifact belongs to another workflow SHA: ${directory}`);
    invariant(lanes.includes(lane), `report artifact has unknown lane ${lane}`);
    const artifactAttempt = Number(rawAttempt);
    invariant(
      Number.isSafeInteger(artifactAttempt) && artifactAttempt <= attempt,
      `invalid or future artifact attempt: ${directory}`,
    );
    if (!selected.has(lane) || selected.get(lane).attempt < artifactAttempt) {
      selected.set(lane, { lane, attempt: artifactAttempt, artifact: directory });
    }
  }
  return lanes.map((lane) => {
    invariant(selected.has(lane), `missing public-test report artifact for ${lane}`);
    return selected.get(lane);
  });
}

function assertSelectedPayload(value, selected, plan) {
  invariant(
    value?.schemaVersion === 2 && value.kind === 'public_test_shard_run',
    `invalid selected shard report: ${selected.artifact}`,
  );
  invariant(value.lane === selected.lane, `selected report lane does not match artifact ${selected.artifact}`);
  invariant(
    value.planFingerprint === plan.planFingerprint,
    `selected report plan fingerprint does not match: ${selected.artifact}`,
  );
  // Status, provenance, isolation, selection and complete coverage are checked
  // by the unchanged summarizer. A failed latest attempt must reach that gate.
}

/** Preserve every downloaded artifact; only create a new selection directory. */
export async function writeSelectedPublicTestReports({ plan, artifactsDir, reportsDir, sha, attempt, log = () => {} }) {
  const rawRoot = resolve(artifactsDir);
  const output = resolve(reportsDir);
  const fromRaw = relative(rawRoot, output);
  invariant(
    fromRaw === '..' || fromRaw.startsWith(`..${sep}`) || isAbsolute(fromRaw),
    'selected reports must be outside original artifacts',
  );
  const entries = await readdir(rawRoot, { withFileTypes: true });
  invariant(
    entries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink()),
    'report artifacts must be separate real directories',
  );
  const selected = selectPublicTestReportArtifacts({
    plan,
    artifactDirectories: entries.map(({ name }) => name),
    sha,
    attempt,
  });
  const reports = [];
  for (const entry of selected) {
    const source = join(rawRoot, entry.artifact, `${entry.lane}.json`);
    const stat = await lstat(source);
    invariant(stat.isFile() && !stat.isSymbolicLink(), `selected report is not a regular file: ${source}`);
    const contents = await readFile(source, 'utf8');
    let report;
    try {
      report = JSON.parse(contents);
    } catch (error) {
      throw new Error(`invalid selected report JSON ${source}: ${error.message}`);
    }
    assertSelectedPayload(report, entry, plan);
    reports.push({ entry, contents });
  }
  await mkdir(output, { mode: 0o700 });
  for (const { entry, contents } of reports) {
    await writeFile(join(output, `${entry.lane}.json`), contents, { flag: 'wx', mode: 0o600 });
    log(`Public-test report ${entry.lane}: attempt=${entry.attempt}, artifact=${entry.artifact}`);
  }
  await writeFile(
    join(output, 'selection.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'public_test_report_selection',
        sha,
        attempt,
        selections: selected,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return selected;
}

async function main() {
  const options = parsePublicTestCliOptions(normalizePublicTestCliArgv(process.argv.slice(2)));
  if (options.help) {
    console.log(
      'Usage: select-public-test-reports.mjs --plan <path> --artifacts-dir <path> --reports-dir <new-path> --sha <workflow-sha> --attempt <current-attempt>',
    );
    return;
  }
  for (const name of ['plan', 'artifacts-dir', 'reports-dir', 'sha', 'attempt'])
    invariant(options[name], `--${name} is required`);
  invariant(/^[1-9]\d*$/.test(options.attempt), '--attempt must be a positive integer');
  await writeSelectedPublicTestReports({
    plan: await readPublicTestJson(options.plan, 'public-test plan'),
    artifactsDir: options['artifacts-dir'],
    reportsDir: options['reports-dir'],
    sha: options.sha,
    attempt: Number(options.attempt),
    log: console.log,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
