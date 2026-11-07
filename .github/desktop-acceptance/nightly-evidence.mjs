import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertInstallerIdentity, installerSha256, verifiedInstallerSha256 } from './nightly-desktop.mjs';
import { buildReport, renderReport, selectCases } from './nightly-report.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('./nightly-cases.json', import.meta.url), 'utf8'));
const { cases, expectedFailures } = catalog;
const catalogDigest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
const [command, directory, ...desktopFiles] = process.argv.slice(2);
const { CANDIDATE_SOURCE_SHA: source, NIGHTLY_SUITE: suite, GITHUB_SHA: catalogRevision } = process.env;
const blocker = process.env.NIGHTLY_RUN_BLOCKER || undefined;
const fromActions = {
  source: blocker && !source ? null : source,
  packageVersion: process.env.CANDIDATE_VERSION || undefined,
  branch: process.env.NIGHTLY_BRANCH,
  blocker,
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
if (command === 'reconcile') assert.ok(baseReport, 'The original report is required');
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
      if (executor === 'windows-port-preflight' || executor === 'installed-auth') {
        const evidence = executor === 'installed-auth' ? 'native-auth-checks.json' : 'installer/port-conflicts.json';
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
            : { id, platform, status: 'blocked', code: `${executor}-unavailable` },
        ];
      }
      if (executor.startsWith('windows-')) {
        const kind = executor.slice('windows-'.length);
        const check = results?.checks.find(({ name }) => name === kind);
        if (!check) return [{ id, platform, status: 'blocked', code: 'windows-verifier-unavailable' }];
        const phaseFile = path.join(directory, kind, 'phase.txt');
        const phase = fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, 'utf8').trim() : undefined;
        if (phase === 'port-preflight-blocked-startup') {
          return [
            {
              id,
              platform,
              status: 'blocked',
              code: 'windows-port-preflight-cleanup',
              evidence: `${artifact(platform)}/${kind}/cleanup-confirmed.json`,
            },
          ];
        }
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
              code:
                phase === 'installed-identity'
                  ? 'windows-installed-identity'
                  : (check.reason ?? `windows-${phase}${failures.length ? `-${failures.join('+')}` : ''}`),
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
  const packageHashes = { ...run.packageHashes };
  let receipts = run.blocker
    ? []
    : baseReport
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
  if (command === 'report' && !run.blocker) {
    for (const platform of run.platforms) {
      const hashFile = path.join(
        directory,
        `desktop-build-hash-${platform}-attempt-${run.attempt}`,
        'installer-sha256.txt',
      );
      if (!fs.existsSync(hashFile)) continue;
      const hash = fs.readFileSync(hashFile, 'utf8').trim();
      assert.match(hash, /^[a-f0-9]{64}$/, 'Invalid published build hash');
      packageHashes[platform] = hash;
      const native = installerSha256(path.join(directory, artifact(platform)), platform, { allowMissing: true });
      if (native && native !== hash) {
        const executor = platform === 'windows-x64' ? 'windows-installer' : 'macos-dmg';
        const { id } = selected.find((entry) => entry.platform === platform && entry.executor === executor);
        receipts = receipts.filter((receipt) => receipt.platform !== platform || receipt.id !== id);
        receipts.push({
          id,
          platform,
          status: 'failed',
          code: 'candidate-package-hash-conflict',
          evidence: `${artifact(platform)}/${platform === 'windows-x64' ? 'installer/distribution-sha256.json' : 'distribution-sha256.txt'}`,
        });
      }
    }
  }
  if (command === 'reconcile' && !run.blocker) {
    const until = desktopFiles[0] === '--until';
    const deadline = until ? Date.parse(desktopFiles[1]) : undefined;
    if (until) {
      assert.equal(desktopFiles.length, 2, 'Use --until with one timestamp and no explicit receipt files');
      assert.match(
        desktopFiles[1],
        /T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/,
        'Specify a timestamp with its timezone',
      );
      assert.ok(Number.isFinite(deadline), 'Invalid desktop receipt deadline');
    }
    const inboxMode = until || desktopFiles.length === 0;
    const interactive = selected.filter(({ executor }) => ['computer-use', 'manual'].includes(executor));
    const keyOf = ({ platform, id }) => `${platform}/${id}`;
    const original = new Map(receipts.map((receipt) => [keyOf(receipt), receipt]));
    assert.equal(original.size, receipts.length, 'Duplicate case in original report');
    let announced = false;
    for (;;) {
      const merged = new Map(original);
      const receiptFiles = inboxMode
        ? run.platforms.flatMap((platform) => {
            const inbox = path.join(directory, 'desktop-receipts', platform);
            if (!fs.existsSync(inbox)) return [];
            return fs
              .readdirSync(inbox, { withFileTypes: true })
              .filter((entry) => entry.isFile() && entry.name.endsWith('.receipt.json'))
              .map((entry) => path.join(inbox, entry.name))
              .sort();
          })
        : desktopFiles;
      const desktopReceipts = receiptFiles.flatMap((file) => {
        const desktop = readJson(file);
        assert.ok(desktop, `Missing desktop receipt file: ${file}`);
        for (const key of ['runId', 'attempt', 'source', 'catalogRevision']) {
          assert.equal(desktop[key], run[key], `Desktop receipt ${key} does not match the run`);
        }
        return desktop.receipts.map((receipt) => ({ receipt, root: path.dirname(file) }));
      });
      const received = new Set();
      for (const { receipt, root } of desktopReceipts) {
        if (inboxMode) assert.equal(receipt.platform, path.basename(root), 'Desktop receipt is in the wrong inbox');
        const key = keyOf(receipt);
        assert.ok(
          interactive.some((entry) => keyOf(entry) === key),
          'Desktop receipt has no selected interactive case',
        );
        assert.ok(!received.has(key), 'Duplicate desktop receipt');
        received.add(key);
        if (receipt.evidence || receipt.status !== 'blocked') {
          assert.match(receipt.evidence, /^[A-Za-z0-9][A-Za-z0-9_.-]+$/);
          assert.ok(fs.statSync(path.join(root, receipt.evidence)).isFile(), 'Missing desktop evidence file');
        }
        if (receipt.status !== 'blocked') {
          assertInstallerIdentity(baseReport.cases, receipt.platform);
          const native = path.join(directory, artifact(receipt.platform));
          assert.match(receipt.packageSha256, /^[a-f0-9]{64}$/);
          assert.equal(
            receipt.packageSha256,
            verifiedInstallerSha256(native, receipt.platform, packageHashes[receipt.platform]),
            'Desktop evidence is for a different installation package',
          );
        }
        const existing = merged.get(key);
        assert.ok(!existing || existing.status === 'blocked', 'Existing execution result cannot be replaced');
        const evidence = receipt.evidence
          ? path.relative(directory, path.join(root, receipt.evidence)).split(path.sep).join('/')
          : undefined;
        merged.set(key, { ...receipt, evidence });
      }
      const missing = interactive.filter((entry) => {
        const key = keyOf(entry);
        const status = merged.get(key)?.status;
        return !received.has(key) && (!status || status === 'blocked');
      });
      if (!until || missing.length === 0 || Date.now() >= deadline) {
        if (until) {
          for (const { id, platform } of missing) {
            merged.set(keyOf({ id, platform }), { id, platform, status: 'blocked', code: 'desktop-receipt-deadline' });
          }
        }
        receipts = [...merged.values()];
        break;
      }
      if (!announced) {
        process.stdout.write(`Waiting for ${missing.length} desktop receipt(s) until ${desktopFiles[1]}\n`);
        announced = true;
      }
      await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
  }
  const report = buildReport(
    cases,
    { ...run, packageHashes: Object.keys(packageHashes).length ? packageHashes : undefined },
    receipts,
    expectedFailures,
  );
  const markdown = renderReport(report);
  const reportName = command === 'reconcile' ? 'report-with-desktop' : 'report';
  fs.writeFileSync(path.join(directory, `${reportName}.json`), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, `${reportName}.md`), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (report.status !== 'passed') process.exitCode = 1;
} else {
  throw new Error('Expected collect, report or reconcile');
}
