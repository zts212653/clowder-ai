import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('a Windows desktop receipt completes its case and preserves the remote Mac result', (t) => {
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
  fs.writeFileSync(path.join(macRoot, 'onboarding.png'), 'mac-fixture');
  const macReceipt = path.join(macRoot, 'desktop.json');
  write(macReceipt, { ...desktop, receipts: [{ ...desktop.receipts[0], platform: 'macos-arm64' }] });
  const all = run('reconcile', root, receipt, macReceipt);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'report-with-desktop.json'), 'utf8')).status, 'passed');
  assert.equal(fs.readFileSync(path.join(root, 'report.json'), 'utf8'), base);

  const inbox = path.join(root, 'desktop-receipts');
  const winInbox = path.join(inbox, 'windows-x64');
  const macInbox = path.join(inbox, 'macos-arm64');
  fs.mkdirSync(winInbox, { recursive: true });
  fs.mkdirSync(macInbox, { recursive: true });
  fs.mkdirSync(mac, { recursive: true });
  fs.copyFileSync(path.join(macNative, 'distribution-sha256.txt'), path.join(mac, 'distribution-sha256.txt'));
  const discovered = () => JSON.parse(fs.readFileSync(path.join(root, 'report-with-desktop.json'), 'utf8'));
  write(path.join(macInbox, 'desktop.receipt.json.pending'), { ...desktop, attempt: 'wrong' });
  assert.equal(run('reconcile', root).status, 1);
  assert.equal(discovered().status, 'incomplete');
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
  fs.copyFileSync(macReceipt, path.join(macInbox, 'desktop.receipt.json'));
  const combined = run('reconcile', root);
  assert.equal(combined.status, 0, combined.stderr);
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
});
