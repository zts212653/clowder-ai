import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureReleaseIntegrity, isReleaseBlocking, readMandatoryLabel } from './scripts/installer-integrity.mjs';

const windowsOnly = { skip: process.platform !== 'win32' ? 'Requires Windows icacls' : false };
const integrityTool = join(import.meta.dirname, 'scripts', 'installer-integrity.mjs');

function withTempFile(run) {
  const root = mkdtempSync(join(tmpdir(), 'installer-integrity-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function makeLabelledFile(root, level, name = 'setup.exe') {
  const file = join(root, name);
  writeFileSync(file, 'stub installer');
  execFileSync('icacls.exe', [file, '/setintegritylevel', level], { windowsHide: true });
  return file;
}

test('readMandatoryLabel throws for a missing file', windowsOnly, () => {
  withTempFile((root) => {
    assert.throws(() => readMandatoryLabel(join(root, 'missing.exe')), /missing file/);
  });
});

test('a label-less file is launchable, Low and explicit Medium are not', windowsOnly, () => {
  withTempFile((root) => {
    const plain = join(root, 'plain.exe');
    writeFileSync(plain, 'stub installer');
    assert.equal(readMandatoryLabel(plain).raw, '');
    assert.equal(isReleaseBlocking(readMandatoryLabel(plain)), false);
    assert.equal(isReleaseBlocking(readMandatoryLabel(makeLabelledFile(root, 'Low', 'low.exe'))), true);
    assert.equal(isReleaseBlocking(readMandatoryLabel(makeLabelledFile(root, 'Medium', 'medium.exe'))), true);
  });
});

test('ensureReleaseIntegrity raises Low to High', windowsOnly, () => {
  withTempFile((root) => {
    const file = makeLabelledFile(root, 'Low');
    assert.equal(readMandatoryLabel(file).level, 'Low');
    const first = ensureReleaseIntegrity(file);
    assert.equal(first.before, 'Low');
    assert.equal(first.changed, true);
    assert.equal(first.after, 'High');
    assert.equal(readMandatoryLabel(file).level, 'High');
    const second = ensureReleaseIntegrity(file);
    assert.equal(second.changed, false);
  });
});

test('ensureReleaseIntegrity raises an explicit Medium label to High', windowsOnly, () => {
  withTempFile((root) => {
    const file = makeLabelledFile(root, 'Medium');
    assert.equal(readMandatoryLabel(file).level, 'Medium');
    const result = ensureReleaseIntegrity(file);
    assert.equal(result.changed, true);
    assert.equal(result.after, 'High');
    assert.equal(isReleaseBlocking(readMandatoryLabel(file)), false);
  });
});

test('cli --check fails closed for a Low-labelled installer', windowsOnly, () => {
  withTempFile((root) => {
    const file = makeLabelledFile(root, 'Low');
    const checked = spawnSync(process.execPath, [integrityTool, file, '--check', '--json'], { encoding: 'utf8' });
    assert.equal(checked.status, 1);
    const report = JSON.parse(checked.stdout.trim());
    assert.equal(report.ok, false);
    assert.equal(report.level, 'Low');

    const normalized = spawnSync(process.execPath, [integrityTool, file, '--json'], { encoding: 'utf8' });
    assert.equal(normalized.status, 0);
    const normalizedReport = JSON.parse(normalized.stdout.trim());
    assert.equal(normalizedReport.ok, true);
    assert.equal(normalizedReport.changed, true);
    assert.equal(normalizedReport.after, 'High');

    const rechecked = spawnSync(process.execPath, [integrityTool, file, '--check', '--json'], { encoding: 'utf8' });
    assert.equal(rechecked.status, 0);
    assert.equal(JSON.parse(rechecked.stdout.trim()).ok, true);
  });
});

test('cli --check rejects an explicitly Medium-labelled installer', windowsOnly, () => {
  withTempFile((root) => {
    const file = makeLabelledFile(root, 'Medium');
    const checked = spawnSync(process.execPath, [integrityTool, file, '--check', '--json'], { encoding: 'utf8' });
    assert.equal(checked.status, 1);
    assert.equal(JSON.parse(checked.stdout.trim()).ok, false);
  });
});

test('cli --copy-to delivers a launchable copy without a restrictive label', windowsOnly, () => {
  withTempFile((root) => {
    const file = makeLabelledFile(root, 'Low');
    const deliveryDir = join(root, 'delivery');
    const copied = spawnSync(process.execPath, [integrityTool, file, '--copy-to', deliveryDir, '--json'], {
      encoding: 'utf8',
    });
    assert.equal(copied.status, 0, copied.stderr);
    const report = JSON.parse(copied.stdout.trim());
    assert.equal(report.ok, true);
    assert.equal(isReleaseBlocking(readMandatoryLabel(report.path)), false);
  });
});
