import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseRecoveryCliArgs } from '../dist/scripts/f254-withheld-message-recovery/cli.js';

describe('F254 withheld-message recovery CLI contract', () => {
  test('defaults to a read-only plan and requires an explicit manifest', () => {
    assert.throws(() => parseRecoveryCliArgs([]), /--manifest is required/);
    assert.deepEqual(parseRecoveryCliArgs(['--manifest', '/tmp/recovery.json']), {
      apply: false,
      help: false,
      manifestPath: '/tmp/recovery.json',
    });
  });

  test('requires a durable journal for every apply', () => {
    assert.throws(
      () => parseRecoveryCliArgs(['--manifest', '/tmp/recovery.json', '--apply']),
      /--journal is required with --apply/,
    );
    const parsed = parseRecoveryCliArgs([
      '--manifest',
      '/tmp/recovery.json',
      '--apply',
      '--journal',
      '/tmp/recovery-journal.json',
      '--redis-url',
      'redis://127.0.0.1:6398/13',
    ]);
    assert.equal(parsed.apply, true);
    assert.equal(parsed.journalPath, '/tmp/recovery-journal.json');
    assert.equal(parsed.redisUrl, 'redis://127.0.0.1:6398/13');
  });

  test('captures manifest-pinned production authorization without weakening defaults', () => {
    const parsed = parseRecoveryCliArgs([
      '--manifest',
      '/tmp/recovery.json',
      '--apply',
      '--journal',
      '/tmp/recovery-journal.json',
      '--approval-ref',
      'cvo-message-id',
      '--expected-manifest-sha256',
      'a'.repeat(64),
      '--confirm',
      'RESTORE F254 TO 6399',
    ]);
    assert.equal(parsed.approvalRef, 'cvo-message-id');
    assert.equal(parsed.expectedManifestSha256, 'a'.repeat(64));
    assert.equal(parsed.confirmation, 'RESTORE F254 TO 6399');
  });

  test('rejects unknown flags and missing values', () => {
    assert.throws(() => parseRecoveryCliArgs(['--manifest']), /--manifest requires a value/);
    assert.throws(
      () => parseRecoveryCliArgs(['--manifest', '/tmp/recovery.json', '--surprise']),
      /unknown argument: --surprise/,
    );
  });
});
