import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('a Windows desktop receipt completes its case and preserves the remote Mac result', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-nightly-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = path.join(root, 'desktop-evidence-windows-x64-attempt-2');
  const installer = path.join(evidence, 'installer');
  fs.mkdirSync(installer, { recursive: true });
  const source = 'a'.repeat(40);
  const catalogRevision = 'b'.repeat(40);
  const packageSha256 = 'c'.repeat(64);
  const env = {
    ...process.env,
    CANDIDATE_SOURCE_SHA: source,
    GITHUB_SHA: catalogRevision,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'zts212653/clowder-ai',
    NIGHTLY_SUITE: 'smoke',
    NIGHTLY_DATE: '2026-11-07',
    NIGHTLY_PLATFORMS: '["windows-x64","macos-arm64"]',
    NIGHTLY_PLATFORM: 'windows-x64',
    GITHUB_STEP_SUMMARY: '',
  };
  const script = fileURLToPath(new URL('./nightly-evidence.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  write(path.join(installer, 'distribution-sha256.json'), { Hash: packageSha256.toUpperCase() });
  write(path.join(installer, 'result.json'), { status: 'passed' });
  write(path.join(evidence, 'distribution-results.json'), { checks: [{ name: 'installer', status: 'passed' }] });

  const collect = run('collect', evidence);
  assert.equal(collect.status, 0, collect.stderr);
  const mac = path.join(root, 'desktop-evidence-macos-arm64-attempt-2');
  fs.mkdirSync(mac);
  write(path.join(mac, 'receipts.json'), {
    runId: '123',
    attempt: '2',
    source,
    catalogRevision,
    platform: 'macos-arm64',
    receipts: [{ id: 'MAC-CLEAN-INSTALL', platform: 'macos-arm64', status: 'passed', evidence: 'dmg-result.json' }],
  });
  const blocked = run('report', root);
  assert.equal(blocked.status, 1, blocked.stderr);
  const base = fs.readFileSync(path.join(root, 'report.json'), 'utf8');
  assert.equal(JSON.parse(base).status, 'incomplete');
  fs.unlinkSync(path.join(mac, 'receipts.json'));
  fs.writeFileSync(path.join(root, 'onboarding.png'), 'fixture');
  const receipt = path.join(root, 'desktop.json');
  const desktop = {
    runId: '123',
    attempt: '2',
    source,
    catalogRevision,
    receipts: [
      {
        id: 'DESKTOP-ONBOARDING',
        platform: 'windows-x64',
        status: 'passed',
        evidence: 'onboarding.png',
        packageSha256,
      },
    ],
  };
  write(path.join(root, 'report.json'), { ...JSON.parse(base), catalogDigest: 'd'.repeat(64) });
  assert.match(run('reconcile', root, receipt).stderr, /case catalog differs from the run/);
  fs.writeFileSync(path.join(root, 'report.json'), base);
  write(receipt, { ...desktop, attempt: '1' });
  assert.match(run('reconcile', root, receipt).stderr, /attempt does not match the run/);
  write(receipt, { ...desktop, receipts: [{ ...desktop.receipts[0], packageSha256: 'd'.repeat(64) }] });
  assert.match(run('reconcile', root, receipt).stderr, /different installation package/);
  write(receipt, desktop);
  const merged = run('reconcile', root, receipt);
  assert.equal(merged.status, 1, merged.stderr);
  const { cases } = JSON.parse(fs.readFileSync(path.join(root, 'report-with-desktop.json'), 'utf8'));
  assert.deepEqual(
    cases.map(({ platform, status }) => [platform, status]),
    [
      ['windows-x64', 'passed'],
      ['windows-x64', 'passed'],
      ['macos-arm64', 'passed'],
      ['macos-arm64', 'blocked'],
    ],
  );
  const macRoot = path.join(root, 'mac-desktop');
  const macNative = path.join(macRoot, 'desktop-evidence-macos-arm64-attempt-2');
  fs.mkdirSync(macNative, { recursive: true });
  fs.writeFileSync(path.join(macNative, 'distribution-sha256.txt'), `${packageSha256}  candidate.dmg\n`);
  const authoritativeMacHash = path.join(mac, 'distribution-sha256.txt');
  fs.writeFileSync(authoritativeMacHash, `${'d'.repeat(64)}  candidate.dmg\n`);
  fs.writeFileSync(path.join(macRoot, 'onboarding.png'), 'mac-fixture');
  const macReceipt = path.join(macRoot, 'desktop.json');
  write(macReceipt, { ...desktop, receipts: [{ ...desktop.receipts[0], platform: 'macos-arm64' }] });
  const wrongPackage = run('reconcile', root, receipt, macReceipt);
  assert.match(wrongPackage.stderr, /different installation package/);
  fs.copyFileSync(path.join(macNative, 'distribution-sha256.txt'), authoritativeMacHash);
  const all = run('reconcile', root, receipt, macReceipt);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'report-with-desktop.json'), 'utf8')).status, 'passed');
  assert.equal(fs.readFileSync(path.join(root, 'report.json'), 'utf8'), base);

  const inbox = path.join(root, 'desktop-receipts');
  const winInbox = path.join(inbox, 'windows-x64');
  const macInbox = path.join(inbox, 'macos-arm64');
  fs.mkdirSync(winInbox, { recursive: true });
  fs.mkdirSync(macInbox, { recursive: true });
  const discovered = () => JSON.parse(fs.readFileSync(path.join(root, 'report-with-desktop.json'), 'utf8'));
  write(path.join(macInbox, 'desktop.receipt.json.pending'), { ...desktop, attempt: 'wrong' });
  assert.equal(run('reconcile', root).status, 1);
  assert.equal(discovered().status, 'incomplete');
  const expired = run('reconcile', root, '--until', '2000-01-01T00:00:00Z');
  assert.equal(expired.status, 1);
  assert.equal(
    discovered().cases.find(({ id, platform }) => id === 'DESKTOP-ONBOARDING' && platform === 'macos-arm64').code,
    'desktop-receipt-deadline',
  );
  fs.copyFileSync(path.join(root, 'onboarding.png'), path.join(winInbox, 'onboarding.png'));
  write(path.join(winInbox, 'desktop.receipt.json'), desktop);
  assert.equal(run('reconcile', root).status, 1);
  assert.equal(discovered().status, 'incomplete');
  fs.copyFileSync(path.join(macRoot, 'onboarding.png'), path.join(macInbox, 'onboarding.png'));
  write(path.join(macInbox, 'desktop.receipt.json'), desktop);
  assert.match(run('reconcile', root).stderr, /wrong inbox/);
  write(path.join(macInbox, 'desktop.receipt.json'), {
    ...desktop,
    receipts: [{ ...desktop.receipts[0], platform: 'macos-arm64', packageSha256: 'd'.repeat(64) }],
  });
  assert.match(run('reconcile', root).stderr, /different installation package/);
  fs.unlinkSync(path.join(macInbox, 'desktop.receipt.json'));
  const child = spawn(
    process.execPath,
    [script, 'reconcile', root, '--until', new Date(Date.now() + 10_000).toISOString()],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill());
  const exited = once(child, 'close');
  const waiting = await Promise.race([once(child.stdout, 'data').then(([value]) => String(value)), exited]);
  assert.match(String(waiting), /Waiting for 1 desktop receipt/);
  assert.equal(discovered().status, 'incomplete');
  fs.copyFileSync(macReceipt, path.join(macInbox, 'desktop.receipt.json.pending'));
  fs.renameSync(path.join(macInbox, 'desktop.receipt.json.pending'), path.join(macInbox, 'desktop.receipt.json'));
  assert.deepEqual(await exited, [0, null]);
  assert.equal(discovered().status, 'passed');
  assert.deepEqual(
    discovered()
      .cases.filter(({ id }) => id === 'DESKTOP-ONBOARDING')
      .map(({ evidence }) => evidence),
    ['desktop-receipts/windows-x64/onboarding.png', 'desktop-receipts/macos-arm64/onboarding.png'],
  );
  assert.equal(fs.readFileSync(path.join(root, 'report.json'), 'utf8'), base);

  write(path.join(evidence, 'distribution-results.json'), { checks: [{ name: 'installer', status: 'failed' }] });
  fs.writeFileSync(path.join(installer, 'phase.txt'), 'restore');
  write(path.join(installer, 'restore-checks.json'), {
    checks: [
      { name: 'persisted-readback', status: 'passed' },
      { name: 'default-plugins', status: 'failed' },
    ],
  });
  assert.equal(run('collect', evidence).status, 0);
  assert.equal(run('report', root).status, 1);
  const failed = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8')).cases.find(
    ({ id }) => id === 'WIN-CLEAN-INSTALL',
  );
  assert.equal(failed.code, 'windows-restore-default-plugins');
  assert.equal(failed.evidence, 'desktop-evidence-windows-x64-attempt-2/installer/restore-checks.json');

  write(path.join(installer, 'port-conflicts.json'), { status: 'passed' });
  write(path.join(evidence, 'native-auth-checks.json'), { status: 'failed', code: 'installed-native-auth-assertion' });
  const collectFull = spawnSync(process.execPath, [script, 'collect', evidence], {
    env: { ...env, NIGHTLY_SUITE: 'full' },
    encoding: 'utf8',
  });
  assert.equal(collectFull.status, 0, collectFull.stderr);
  const { receipts } = JSON.parse(fs.readFileSync(path.join(evidence, 'receipts.json'), 'utf8'));
  assert.deepEqual(
    receipts.find(({ id }) => id === 'WIN-PORT-PREFLIGHT'),
    {
      id: 'WIN-PORT-PREFLIGHT',
      platform: 'windows-x64',
      status: 'passed',
      evidence: 'desktop-evidence-windows-x64-attempt-2/installer/port-conflicts.json',
    },
  );
  assert.deepEqual(
    receipts.find(({ id }) => id === 'DESKTOP-NATIVE-AUTH-DIAGNOSTIC'),
    {
      id: 'DESKTOP-NATIVE-AUTH-DIAGNOSTIC',
      platform: 'windows-x64',
      status: 'failed',
      code: 'installed-native-auth-assertion',
      evidence: 'desktop-evidence-windows-x64-attempt-2/native-auth-checks.json',
    },
  );
  fs.writeFileSync(path.join(installer, 'phase.txt'), 'port-preflight-blocked-startup');
  write(path.join(installer, 'port-conflicts.json'), { status: 'blocked', code: 'windows-port-preflight-interrupted' });
  assert.equal(run('collect', evidence).status, 0);
  const cleanupBlocked = JSON.parse(fs.readFileSync(path.join(evidence, 'receipts.json'), 'utf8')).receipts;
  const installerBlocked = cleanupBlocked.find(({ id }) => id === 'WIN-CLEAN-INSTALL');
  assert.equal(installerBlocked.code, 'windows-port-preflight-cleanup');
  assert.equal(installerBlocked.status, 'blocked');

  const buildOnly = path.join(root, 'build-only');
  const published = path.join(buildOnly, 'desktop-build-hash-windows-x64-attempt-2');
  fs.mkdirSync(published, { recursive: true });
  fs.writeFileSync(path.join(published, 'installer-sha256.txt'), packageSha256);
  assert.equal(run('report', buildOnly).status, 1);
  const buildReportPath = path.join(buildOnly, 'report.json');
  const builderReport = JSON.parse(fs.readFileSync(buildReportPath, 'utf8'));
  assert.deepEqual(builderReport.packageHashes, { 'windows-x64': packageSha256 });
  assert.ok(builderReport.cases.every(({ status }) => status === 'blocked'));
  assert.equal(run('reconcile', buildOnly, receipt).status, 1);
  const workerReport = JSON.parse(fs.readFileSync(path.join(buildOnly, 'report-with-desktop.json'), 'utf8'));
  assert.equal(
    workerReport.cases.find(({ id, platform }) => id === 'DESKTOP-ONBOARDING' && platform === 'windows-x64').status,
    'passed',
  );

  const differentNative = path.join(buildOnly, 'desktop-evidence-windows-x64-attempt-2', 'installer');
  fs.mkdirSync(differentNative, { recursive: true });
  write(path.join(differentNative, 'distribution-sha256.json'), { Hash: 'd'.repeat(64) });
  assert.equal(run('report', buildOnly).status, 1);
  const conflict = JSON.parse(fs.readFileSync(buildReportPath, 'utf8'));
  assert.equal(conflict.status, 'failed');
  assert.equal(conflict.cases.find(({ id }) => id === 'WIN-CLEAN-INSTALL').code, 'candidate-package-hash-conflict');
  assert.match(run('reconcile', buildOnly, receipt).stderr, /build and native verifier hashes disagree/);

  write(path.join(mac, 'mac-port-conflicts.json'), { status: 'passed' });
  const collectMacFull = spawnSync(process.execPath, [script, 'collect', mac], {
    env: { ...env, NIGHTLY_SUITE: 'full', NIGHTLY_PLATFORM: 'macos-arm64' },
    encoding: 'utf8',
  });
  assert.equal(collectMacFull.status, 0, collectMacFull.stderr);
  const macReceipts = JSON.parse(fs.readFileSync(path.join(mac, 'receipts.json'), 'utf8')).receipts;
  assert.deepEqual(
    macReceipts.find(({ id }) => id === 'MAC-PORT-PREFLIGHT'),
    {
      id: 'MAC-PORT-PREFLIGHT',
      platform: 'macos-arm64',
      status: 'passed',
      evidence: 'desktop-evidence-macos-arm64-attempt-2/mac-port-conflicts.json',
    },
  );
  const upgradeRoot = path.join(root, 'desktop-evidence-windows-upgrade-attempt-2');
  fs.mkdirSync(upgradeRoot);
  write(path.join(upgradeRoot, 'upgrade-result.json'), {
    runId: '123',
    attempt: '2',
    source,
    catalogRevision,
    status: 'passed',
  });
  const reportFull = spawnSync(process.execPath, [script, 'report', root], {
    env: { ...env, NIGHTLY_SUITE: 'full' },
    encoding: 'utf8',
  });
  assert.equal(reportFull.status, 1, reportFull.stderr);
  const upgraded = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8')).cases.find(
    ({ id }) => id === 'WIN-UPGRADE-STATE',
  );
  assert.equal(upgraded.status, 'passed');
  assert.equal(upgraded.evidence, 'desktop-evidence-windows-upgrade-attempt-2/upgrade-result.json');
  write(path.join(upgradeRoot, 'upgrade-result.json'), {
    runId: '123',
    attempt: '1',
    source,
    catalogRevision,
    status: 'passed',
  });
  const wrongUpgradeAttempt = spawnSync(process.execPath, [script, 'report', root], {
    env: { ...env, NIGHTLY_SUITE: 'full' },
    encoding: 'utf8',
  });
  assert.match(wrongUpgradeAttempt.stderr, /Upgrade receipt attempt differs from the run/);
});
