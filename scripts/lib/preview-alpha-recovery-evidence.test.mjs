import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { recoveryPathExists } from './preview-alpha-recovery-evidence.mjs';
import { failedAlphaFixture } from './preview-alpha-recovery-test-fixture.mjs';
import { stopManagedPreview } from './preview-process-stop.mjs';

const stop = (f) => stopManagedPreview(f.config, { record: f.record, status: 'stopped' }, { recovery: f.recovery });

for (const [name, change, error] of [
  [
    'forced completion',
    (f) => {
      f.completion.forced = true;
      f.write(f.record.completionPath, f.completion);
    },
    /cleanup incomplete/,
  ],
  ['missing owner result', (f) => unlinkSync(`${f.record.completionPath}.owner.json`), /ENOENT/],
  [
    'ambiguous producer leases',
    (f) => f.write(f.leaseFile.replace('-41021-', '-41022-'), f.lease),
    /one exact producer lease/,
  ],
  [
    'protected tuple',
    (f) => {
      f.lease.coordinates.ports.redis = 6399;
      f.write(f.leaseFile, f.lease);
    },
    /non-protected/,
  ],
  [
    'inconsistent recorded birth',
    (f) => {
      f.lease.owner.process.startedAt = 'foreign';
      f.write(f.leaseFile, f.lease);
    },
    /owner lifetime/,
  ],
]) {
  test(`recovery refuses ${name} without changing the failed evidence or sending protocol`, async (t) => {
    const f = failedAlphaFixture(t);
    change(f);
    const before = readFileSync(f.record.completionPath);
    await assert.rejects(stop(f), error);
    assert.deepEqual(readFileSync(f.record.completionPath), before);
    assert.equal(f.calls.length, 0);
  });
}

test('native macOS TMPDIR alias finds the same physical producer lease without relaxing file links', async (t) => {
  const f = failedAlphaFixture(t);
  f.recovery.registryDir = f.recovery.registryDir.replace(/^\/private\/var\//, '/var/');
  await stop(f);
  assert.equal(f.calls.filter((argv) => argv.includes('shutdown')).length, 1);
  assert.deepEqual(readFileSync(f.record.completionPath), f.originalCompletion);
});

test('a changed registration cannot be consumed by an older stop result', async (t) => {
  const f = failedAlphaFixture(t);
  const successor = { ...f.record, pid: 900000010 };
  f.write(f.config.recordPath, successor);
  await assert.rejects(stop(f), /record changed before/);
  assert.deepEqual(JSON.parse(readFileSync(f.config.recordPath)), successor);
  assert.equal(f.calls.length, 0);
});

test(
  'an unreadable recovery path is unknown rather than missing',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'requires POSIX non-root file permissions' : false,
  },
  (t) => {
    const f = failedAlphaFixture(t);
    const directory = join(f.directory, 'unreadable');
    mkdirSync(directory);
    const path = join(directory, 'shutdown-intent.json');
    writeFileSync(path, '{}');
    assert.equal(recoveryPathExists(path), true);
    chmodSync(directory, 0);
    try {
      assert.throws(() => recoveryPathExists(path), { code: 'EACCES' });
    } finally {
      chmodSync(directory, 0o700);
    }
    unlinkSync(path);
    assert.equal(recoveryPathExists(path), false);
  },
);
