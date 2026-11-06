import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, renderReport } from './nightly-report.mjs';

const windows = 'windows-x64';
const mac = 'macos-arm64';
const catalog = [
  { id: 'WIN-INSTALL', level: 'L0', platforms: [windows], title: '安装' },
  { id: 'DESKTOP-FIRST-OPEN', level: 'L0', platforms: [windows, mac], title: '首次打开' },
  { id: 'WIN-UPGRADE', level: 'L1', platforms: [windows], title: '覆盖升级' },
];
const run = {
  source: 'b'.repeat(40),
  catalogRevision: 'a'.repeat(40),
  date: '2026-11-07',
  suite: 'smoke',
  platforms: [windows],
};
const install = { id: 'WIN-INSTALL', platform: windows, status: 'passed', evidence: 'installer/result.json' };
const desktop = {
  id: 'DESKTOP-FIRST-OPEN',
  platform: windows,
  status: 'failed',
  code: 'dialog-missing',
  evidence: 'desktop.png',
};

test('smoke runs L0 only and missing desktop proof leaves L0 incomplete', () => {
  const report = buildReport(catalog, run, [install]);
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(
    report.cases.map(({ id, status }) => [id, status]),
    [
      ['WIN-INSTALL', 'passed'],
      ['DESKTOP-FIRST-OPEN', 'blocked'],
    ],
  );
  assert.match(renderReport(report), /L0 未完成[\s\S]*DESKTOP-FIRST-OPEN/);
});

test('full includes every selected OS and level and keeps the exact predeclared failure', () => {
  const exceptions = [{ id: desktop.id, platform: windows, code: desktop.code, issue: 123, expires: '2026-11-07' }];
  const full = { ...run, suite: 'full', platforms: [windows, mac] };
  const report = buildReport(catalog, full, [install, desktop], exceptions);
  assert.deepEqual(
    report.cases.map(({ platform, id, status }) => [platform, id, status]),
    [
      [windows, 'WIN-INSTALL', 'passed'],
      [windows, 'DESKTOP-FIRST-OPEN', 'expected_failure'],
      [windows, 'WIN-UPGRADE', 'blocked'],
      [mac, 'DESKTOP-FIRST-OPEN', 'blocked'],
    ],
  );
  assert.equal(report.cases[1].rawStatus, 'failed');
  assert.equal(report.cases[1].knownIssue, 123);
  assert.equal(buildReport(catalog, { ...run, date: '2026-11-08' }, [install, desktop], exceptions).status, 'failed');
  assert.equal(buildReport(catalog, run, [install, { ...desktop, code: 'different' }], exceptions).status, 'failed');
  assert.equal(buildReport(catalog, run, [install, desktop], exceptions).status, 'known_failures');
});

test('contradictory receipts cannot turn a failure into a pass', () => {
  assert.throws(
    () => buildReport(catalog, run, [install, { ...install, status: 'failed', code: 'setup' }]),
    /Duplicate receipt/,
  );
  assert.throws(() => buildReport(catalog, run, [{ ...install, evidence: '' }]), /Missing evidence/);
});
