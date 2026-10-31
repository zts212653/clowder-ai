import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  initializeDurableGateRecovery,
  readDurableGateRecovery,
  synchronizeDurableGateFrozenIdentity,
} from '../dist/domains/ball-custody/durable-managed-gate-recovery.js';
import { hasDurableGateRecoveryReadyReceipt } from '../dist/domains/ball-custody/durable-managed-gate-recovery-child-contract.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { createDurableManagedGateAttempt } from '../dist/infrastructure/managed-runner-durable-attempt.js';

const owner = { pid: 41, ppid: 1, pgid: 41, startedAt: 'fixture-birth' };
const principal = { userId: 'owner', threadId: 'alpha-thread', catId: 'codex-astra' };
const consumer = {
  kind: 'alpha_revision_v1',
  subscriptionId: 'alpha-schedule',
  s3JobId: `alpha-browser-${'a'.repeat(64)}`,
  headSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
};
const frozen = {
  ...consumer,
  treeSha: 'd'.repeat(40),
  route: 'full',
  risk: null,
  mode: 'full',
  fingerprint: '1'.repeat(64),
  runnerFingerprint: '2'.repeat(64),
  toolchainFingerprint: '3'.repeat(64),
};

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-recovery-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new ManagedJobService(root);
  const job = await service.submit(principal, {
    consumer,
    command: 'printf alpha',
    cwd: root,
    originTaskId: consumer.subscriptionId,
    originScheduleId: consumer.subscriptionId,
    idempotencyKey: 'revision',
    executionSlaMs: 5000,
    wakeTarget: principal,
  });
  initializeDurableGateRecovery(job, owner, 1000);
  const writeIdentity = (identity) =>
    writeFileSync(
      job.gateReceiptPath,
      JSON.stringify({ jobId: job.jobId, recovery: { protocolVersion: 2, frozenIdentity: identity } }),
    );
  return { job, writeIdentity };
}

test('Alpha recovery freezes its own consumer identity and refuses full-gate or another revision evidence', async (t) => {
  const { job, writeIdentity } = await fixture(t);
  const { kind, subscriptionId, s3JobId, ...fullGateIdentity } = frozen;
  writeIdentity(fullGateIdentity);
  assert.equal(synchronizeDurableGateFrozenIdentity(job, 1001), null);
  writeIdentity({ ...frozen, s3JobId: `alpha-browser-${'e'.repeat(64)}` });
  assert.equal(synchronizeDurableGateFrozenIdentity(job, 1002), null);
  writeIdentity({ ...frozen, headSha: 'f'.repeat(40) });
  assert.equal(synchronizeDurableGateFrozenIdentity(job, 1003), null);
  writeIdentity(frozen);
  assert.deepEqual(synchronizeDurableGateFrozenIdentity(job, 1004), frozen);
  assert.deepEqual(readDurableGateRecovery(job).frozenIdentity, frozen);
  writeIdentity({ ...frozen, fingerprint: '4'.repeat(64) });
  assert.throws(() => synchronizeDurableGateFrozenIdentity(job, 1005), /identity changed/);
});

test('Alpha ready binds the child token and sealed S3 generation, not just a matching generic fingerprint', async (t) => {
  const { job, writeIdentity } = await fixture(t);
  writeIdentity(frozen);
  const identity = synchronizeDurableGateFrozenIdentity(job, 1001);
  const attempt = createDurableManagedGateAttempt(job, 1, identity, 1000);
  assert.equal(JSON.parse(attempt.environment.CAT_CAFE_MANAGED_GATE_FROZEN_IDENTITY_JSON).kind, 'alpha_revision_v1');
  const ready = {
    version: 1,
    protocolVersion: 2,
    jobId: job.jobId,
    attemptToken: attempt.attemptToken,
    frozenFingerprint: identity.fingerprint,
  };
  const save = (value) =>
    writeFileSync(attempt.environment.CAT_CAFE_MANAGED_GATE_RECOVERY_READY_PATH, JSON.stringify(value));
  save(ready);
  assert.equal(hasDurableGateRecoveryReadyReceipt(job, attempt.attemptToken, identity), false);
  const bound = {
    ...ready,
    consumerKind: 'alpha_revision_v1',
    subscriptionId: consumer.subscriptionId,
    s3JobId: consumer.s3JobId,
    generation: 1,
    executionPlanFingerprint: identity.fingerprint,
  };
  save(bound);
  assert.equal(hasDurableGateRecoveryReadyReceipt(job, attempt.attemptToken, identity), true);
  for (const delta of [
    { generation: 0 },
    { s3JobId: 'wrong' },
    { executionPlanFingerprint: 'wrong' },
    { attemptToken: 'old-child' },
  ]) {
    save({ ...bound, ...delta });
    assert.equal(hasDurableGateRecoveryReadyReceipt(job, attempt.attemptToken, identity), false);
  }
});
