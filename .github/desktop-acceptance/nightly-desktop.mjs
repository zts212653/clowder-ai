import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ghCli = (args) => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true });
const repositoryName = /^[\w.-]+\/[\w.-]+$/;

export function findScheduledRun(repository, now = new Date(), gh = ghCli) {
  assert.match(repository, repositoryName);
  const shanghai = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
  const date = shanghai.format(now);
  const { workflow_runs } = JSON.parse(
    gh(['api', `repos/${repository}/actions/workflows/desktop-nightly.yml/runs?event=schedule&per_page=10`]),
  );
  const run = workflow_runs.find(
    (entry) => entry.event === 'schedule' && shanghai.format(new Date(entry.created_at)) === date,
  );
  assert.ok(run, `No scheduled desktop run for ${date} (Asia/Shanghai)`);
  return String(run.id);
}

export function installerSha256(directory, platform, { allowMissing = false } = {}) {
  const windows = platform === 'windows-x64';
  const file = path.join(directory, windows ? 'installer/distribution-sha256.json' : 'distribution-sha256.txt');
  if (allowMissing && !fs.existsSync(file)) return undefined;
  const contents = fs.readFileSync(file, 'utf8');
  const hash = windows ? JSON.parse(contents).Hash : contents.split(/\s+/, 1)[0];
  assert.match(hash, /^[a-fA-F0-9]{64}$/, 'Missing or invalid installer hash');
  return hash.toLowerCase();
}

export function verifiedInstallerSha256(directory, platform, buildHash) {
  if (buildHash === undefined) return installerSha256(directory, platform);
  assert.match(buildHash, /^[a-f0-9]{64}$/, 'Invalid published build hash');
  const nativeHash = installerSha256(directory, platform, { allowMissing: true });
  if (nativeHash) assert.equal(buildHash, nativeHash, 'The build and native verifier hashes disagree');
  return buildHash;
}

export function assertInstallerIdentity(cases, platform) {
  const windows = platform === 'windows-x64';
  const executor = windows ? 'windows-installer' : 'macos-dmg';
  const code = cases.find((entry) => entry.platform === platform && entry.executor === executor)?.code;
  assert.notEqual(code, 'candidate-package-hash-conflict', 'The build and native verifier hashes disagree');
  assert.notEqual(
    code,
    windows ? 'windows-installed-identity' : 'macos-installed-identity',
    'The platform verifier rejected the installed candidate identity',
  );
}

export function stageNightlyReport(repository, runId, directory, gh = ghCli) {
  assert.match(repository, repositoryName);
  assert.match(runId, /^[1-9]\d*$/);
  const run = JSON.parse(gh(['api', `repos/${repository}/actions/runs/${runId}`]));
  assert.equal(run.path, '.github/workflows/desktop-nightly.yml');
  assert.equal(run.status, 'completed', 'The candidate workflow has not finished');
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'Invalid Actions attempt');
  const attempt = String(run.run_attempt);
  const suffix = `-attempt-${attempt}`;
  const root = path.resolve(directory);
  fs.mkdirSync(root);
  const download = (name, target) =>
    gh(['run', 'download', runId, '-R', repository, '-n', name + suffix, '-D', target]);
  download('desktop-nightly-report', root);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
  assert.equal(report.runId, runId);
  assert.equal(report.attempt, attempt);
  assert.equal(report.catalogRevision, run.head_sha);
  if (!report.blocker) {
    assert.match(report.source, /^[a-f0-9]{40}$/);
    assert.match(report.packageVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  }
  return { report, root, download };
}

export async function prepareDesktop(repository, runId, platform, directory, gh = ghCli) {
  assert.ok(['windows-x64', 'macos-arm64', 'macos-x64'].includes(platform), 'Unsupported desktop platform');
  const { report, root, download } = stageNightlyReport(repository, runId, directory, gh);
  assert.ok(!report.blocker, `The candidate is unavailable: ${report.blocker}`);
  const { attempt } = report;
  assert.ok(report.platforms.includes(platform), 'Platform was not requested by the candidate run');
  assertInstallerIdentity(report.cases, platform);
  const windows = platform === 'windows-x64';
  const cases = report.cases.filter(
    (entry) => entry.platform === platform && ['computer-use', 'manual'].includes(entry.executor),
  );
  assert.ok(cases.length, 'The selected suite has no interactive cases on this platform');

  const evidenceName = `desktop-evidence-${platform}`;
  const evidenceDirectory = path.join(root, `${evidenceName}-attempt-${attempt}`);
  const buildHash = report.packageHashes?.[platform];
  if (buildHash === undefined && !fs.existsSync(evidenceDirectory)) download(evidenceName, evidenceDirectory);
  const expected = verifiedInstallerSha256(evidenceDirectory, platform, buildHash);
  const packageDirectory = path.join(root, 'package');
  const label = windows ? 'windows-installer' : `macos-dmg-${platform.slice('macos-'.length)}`;
  download(`${label}-${report.packageVersion}`, packageDirectory);
  const files = fs.readdirSync(packageDirectory, { withFileTypes: true });
  const extension = windows ? '.exe' : '.dmg';
  assert.ok(files.length === 1 && files[0].isFile() && files[0].name.endsWith(extension), 'Invalid candidate package');
  const packagePath = path.join(packageDirectory, files[0].name);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(packagePath)) hash.update(chunk);
  const packageSha256 = hash.digest('hex');
  assert.equal(packageSha256, expected, 'Candidate package hash mismatch');

  const plan = {
    runId,
    attempt,
    source: report.source,
    catalogRevision: report.catalogRevision,
    platform,
    packagePath,
    packageSha256,
    cases,
  };
  fs.writeFileSync(path.join(root, 'desktop-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repository, run, platform, directory] = process.argv.slice(2);
  assert.ok(directory, 'Usage: node nightly-desktop.mjs <owner/repo> <run-id|today> <platform|report> <new-directory>');
  const runId = run === 'today' ? findScheduledRun(repository) : run;
  const result =
    platform === 'report'
      ? stageNightlyReport(repository, runId, directory).report
      : await prepareDesktop(repository, runId, platform, directory);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
