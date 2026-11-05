import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAlphaRecoveryObservation } from '../dist/domains/ball-custody/durable-managed-alpha-observation.js';
import { alphaRecoveryJournalPath } from '../dist/domains/ball-custody/durable-managed-gate-recovery-child-contract.js';

test('Alpha recovery requires positive interruption provenance and a complete observer stream', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'alpha-observation-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const job = { jobId: 'private-job', recordPath: join(root, 'job.json') };
  const token = 'private-attempt';
  const base = [
    { type: 'command-start', observerProtocol: 'node-test-v1' },
    { type: 'command-spawn', pid: 42, startedAt: 'birth' },
    { type: 'observer-start', observerProtocol: 'node-test-v1' },
  ];
  const read = (events) => {
    writeFileSync(
      alphaRecoveryJournalPath(job, token),
      [...base, ...events]
        .map((event) =>
          JSON.stringify({
            version: 1,
            jobId: job.jobId,
            attemptToken: token,
            unitKey: 'one',
            observedAt: 100,
            ...event,
          }),
        )
        .join('\n') + '\n',
    );
    return readAlphaRecoveryObservation(job, token);
  };
  assert.equal(read([]).kind, 'clean');
  assert.equal(read([{ type: 'test-interruption', failureType: 'cancelledByParent' }]).kind, 'unknown');
  assert.equal(read([{ type: 'test-interruption', failureType: 'subtestsFailed' }]).kind, 'unknown');
  assert.equal(
    read([
      { type: 'test-interruption', failureType: 'testTimeoutFailure' },
      { type: 'observer-end' },
      { type: 'command-exit', exitCode: 1 },
    ]).kind,
    'failed',
  );
  assert.equal(read([{ type: 'command-exit', exitCode: 0 }]).kind, 'unknown');
  assert.equal(read([{ type: 'observer-end' }, { type: 'command-exit', exitCode: 0 }]).kind, 'clean');
  assert.equal(
    read([{ type: 'test-failure' }, { type: 'command-exit', exitCode: null, timedOut: true }]).kind,
    'failed',
  );
  assert.equal(
    read([
      { type: 'test-interruption', failureType: 'testTimeoutFailure' },
      { type: 'command-exit', exitCode: null, timedOut: true },
    ]).kind,
    'clock_interruption',
  );
  assert.equal(read([{ type: 'observer-end', attemptToken: 'foreign' }]).kind, 'unknown');
  assert.equal(
    read([
      { type: 'observer-start', observerProtocol: 'foreign' },
      { type: 'observer-end' },
      { type: 'command-exit', exitCode: 0 },
    ]).kind,
    'unknown',
  );
});
