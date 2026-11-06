import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { installerSha256 } from './nightly-desktop.mjs';
import { buildReport, renderReport, selectCases } from './nightly-report.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('./nightly-cases.json', import.meta.url), 'utf8'));
const { cases, expectedFailures } = catalog;
const catalogDigest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
const [command, directory, ...desktopFiles] = process.argv.slice(2);
const { CANDIDATE_SOURCE_SHA: source, NIGHTLY_SUITE: suite, GITHUB_SHA: catalogRevision } = process.env;
const fromActions = {
  source,
  packageVersion: process.env.CANDIDATE_VERSION,
  catalogRevision,
  catalogDigest,
  date: process.env.NIGHTLY_DATE,
  suite,
  platforms: JSON.parse(process.env.NIGHTLY_PLATFORMS ?? '[]'),
  runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
};
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined);
const baseReport = command === 'reconcile' ? readJson(path.join(directory, 'report.json')) : undefined;
const run = baseReport ?? fromActions;
assert.match(run.runId, /^[1-9]\d*$/);
assert.match(run.attempt, /^[1-9]\d*$/);
if (baseReport) {
  assert.equal(catalogRevision, run.catalogRevision, 'Use the original catalog revision');
  assert.equal(catalogDigest, run.catalogDigest, 'The checked-out case catalog differs from the run');
}
const selected = selectCases(cases, run.suite, run.platforms);
const artifact = (platform) => `desktop-evidence-${platform}-attempt-${run.attempt}`;

if (command === 'collect') {
  const { NIGHTLY_PLATFORM: platform } = process.env;
  assert.ok(run.platforms.includes(platform), 'Invalid evidence platform');
  const results = readJson(path.join(directory, 'distribution-results.json'));
  const mac = readJson(path.join(directory, 'dmg-result.json'));
  const receipts = selected
    .filter((entry) => entry.platform === platform)
    .flatMap(({ id, executor }) => {
      if (executor === 'windows-port-preflight') {
        const evidence = 'installer/port-conflicts.json';
        const receipt = readJson(path.join(directory, evidence));
        return [
          receipt
            ? {
                id,
                platform,
                status: receipt.status,
                code: receipt.code,
                evidence: `${artifact(platform)}/${evidence}`,
              }
            : { id, platform, status: 'blocked', code: 'windows-port-preflight-unavailable' },
        ];
      }
      if (executor.startsWith('windows-')) {
        const kind = executor.slice('windows-'.length);
        const check = results?.checks.find(({ name }) => name === kind);
        if (!check) return [{ id, platform, status: 'blocked', code: 'windows-verifier-unavailable' }];
        const phaseFile = path.join(directory, kind, 'phase.txt');
        const phase = fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, 'utf8').trim() : undefined;
        if (check.status === 'passed') {
          return [{ id, platform, status: 'passed', evidence: `${artifact(platform)}/${kind}/result.json` }];
        }
        if (check.status === 'failed' && phase) {
          const phaseEvidence = `${kind}/${phase}-checks.json`;
          const phaseChecks =
            !check.reason && ['create', 'restore'].includes(phase)
              ? readJson(path.join(directory, phaseEvidence))
              : undefined;
          const failures =
            phaseChecks?.checks.filter(({ status }) => status === 'failed').map(({ name }) => name) ?? [];
          return [
            {
              id,
              platform,
              status: 'failed',
              code: check.reason ?? `windows-${phase}${failures.length ? `-${failures.join('+')}` : ''}`,
              evidence: `${artifact(platform)}/${failures.length ? phaseEvidence : 'distribution-results.json'}`,
            },
          ];
        }
        return [
          {
            id,
            platform,
            status: 'blocked',
            code: check.reason ?? 'windows-preflight',
            evidence: `${artifact(platform)}/distribution-results.json`,
          },
        ];
      }
      if (executor === 'macos-dmg') {
        return [
          mac
            ? { ...mac, id, platform, evidence: `${artifact(platform)}/dmg-result.json` }
            : { id, platform, status: 'blocked', code: 'macos-verifier-unavailable' },
        ];
      }
      return [
        {
          id,
          platform,
          status: 'blocked',
          code: executor === 'computer-use' ? 'desktop-receipt-unavailable' : 'manual-evidence-required',
        },
      ];
    });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'receipts.json'),
    JSON.stringify({ source, catalogRevision, runId: run.runId, attempt: run.attempt, platform, receipts }, null, 2),
  );
} else if (command === 'report' || command === 'reconcile') {
  const receipts = baseReport
    ? baseReport.cases.map(({ id, platform, rawStatus, code, evidence }) => ({
        id,
        platform,
        status: rawStatus,
        code,
        evidence,
      }))
    : run.platforms.flatMap((platform) => {
        const bundle = readJson(path.join(directory, artifact(platform), 'receipts.json'));
        if (!bundle) return [];
        assert.equal(bundle.runId, run.runId);
        assert.equal(bundle.attempt, run.attempt);
        assert.equal(bundle.source, run.source);
        assert.equal(bundle.catalogRevision, run.catalogRevision);
        assert.equal(bundle.platform, platform);
        assert.ok(bundle.receipts.every((receipt) => receipt.platform === platform));
        return bundle.receipts;
      });
  if (command === 'reconcile') {
    assert.ok(
      baseReport && desktopFiles.length,
      'The original report and at least one desktop receipt file are required',
    );
    const desktopReceipts = desktopFiles.flatMap((file) => {
      const desktop = readJson(file);
      assert.ok(desktop, `Missing desktop receipt file: ${file}`);
      for (const key of ['runId', 'attempt', 'source', 'catalogRevision']) {
        assert.equal(desktop[key], run[key], `Desktop receipt ${key} does not match the run`);
      }
      return desktop.receipts.map((receipt) => ({ receipt, root: path.dirname(file) }));
    });
    const received = new Set();
    for (const { receipt, root } of desktopReceipts) {
      const entry = selected.find(({ id, platform }) => receipt.id === id && receipt.platform === platform);
      assert.ok(
        entry && ['computer-use', 'manual'].includes(entry.executor),
        'Desktop receipt has no selected interactive case',
      );
      const key = `${receipt.platform}/${receipt.id}`;
      assert.ok(!received.has(key), 'Duplicate desktop receipt');
      received.add(key);
      if (receipt.status !== 'blocked') {
        assert.match(receipt.evidence, /^[A-Za-z0-9][A-Za-z0-9_.-]+$/);
        assert.ok(fs.statSync(path.join(root, receipt.evidence)).isFile(), 'Missing desktop evidence file');
        const native = path.join(root, artifact(receipt.platform));
        assert.match(receipt.packageSha256, /^[a-f0-9]{64}$/);
        assert.equal(
          receipt.packageSha256,
          installerSha256(native, receipt.platform),
          'Desktop evidence is for a different installation package',
        );
      }
      const index = receipts.findIndex(({ id, platform }) => receipt.id === id && receipt.platform === platform);
      assert.ok(index === -1 || receipts[index].status === 'blocked', 'Existing execution result cannot be replaced');
      if (index !== -1) receipts.splice(index, 1);
      receipts.push(receipt);
    }
  }
  const report = buildReport(cases, run, receipts, expectedFailures);
  const markdown = renderReport(report);
  const reportName = command === 'reconcile' ? 'report-with-desktop' : 'report';
  fs.writeFileSync(path.join(directory, `${reportName}.json`), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, `${reportName}.md`), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (report.status !== 'passed') process.exitCode = 1;
} else {
  throw new Error('Expected collect, report or reconcile');
}
