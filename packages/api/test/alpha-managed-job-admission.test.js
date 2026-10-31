import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateDurableManagedGateJob } from '../dist/domains/managed-job/durable-managed-gate-job.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';

const principal = { userId: 'owner', threadId: 'alpha-thread', catId: 'codex-astra' };
const consumer = {
  kind: 'alpha_revision_v1',
  subscriptionId: 'approved-alpha-schedule',
  s3JobId: `alpha-browser-${'a'.repeat(64)}`,
  headSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-managed-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new ManagedJobService(root);
  const input = {
    command: 'printf alpha',
    cwd: root,
    originTaskId: consumer.subscriptionId,
    originScheduleId: consumer.subscriptionId,
    consumer,
    idempotencyKey: `alpha:${consumer.subscriptionId}:${consumer.s3JobId}`,
    executionSlaMs: 5000,
    wakeTarget: principal,
  };
  return { root, service, input };
}

test('approved Alpha schedule uses an explicit consumer and source, with no invented invocation or message', async (t) => {
  const { root, service, input } = fixture(t);
  const job = await service.submit(principal, input);
  assert.equal(job.kind, 'alpha_revision_v1');
  assert.deepEqual(job.consumer, consumer);
  assert.equal(job.definition.originInvocationId, undefined);
  assert.equal(job.definition.originScheduleId, consumer.subscriptionId);
  assert.equal(validateDurableManagedGateJob(job, input.originTaskId, root), true);
  assert.throws(() => service.admit(principal, job.jobId, 'pretend-message'), /schedule_admission/);
  assert.throws(() => service.admitSchedule(principal, job.jobId, 'other-schedule'), /schedule_admission/);
  const restored = new ManagedJobService(root);
  restored.admitSchedule(principal, job.jobId, consumer.subscriptionId);
  assert.equal(restored.get(principal, job.jobId).admissionMessageId, undefined);
  assert.deepEqual(restored.get(principal, job.jobId).scheduleAdmission, { scheduleId: consumer.subscriptionId });
  assert.equal(restored.get(principal, job.jobId).actionKind, 'alpha_revision');
  assert.equal(restored.activeExecutions().length, 1);
  let started = 0;
  restored.start(principal, job.jobId, {
    start(command, options) {
      assert.equal(command, input.command);
      assert.deepEqual(options.managedJob.consumer, consumer);
      started += 1;
      return { admission: Promise.resolve({ spawned: true }), completion: Promise.resolve({ exitCode: 0 }) };
    },
  });
  assert.equal(started, 1);
  assert.equal((await restored.submit(principal, input)).jobId, job.jobId);
  const reorderedConsumer = Object.fromEntries(Object.entries(consumer).reverse());
  assert.equal((await restored.submit(principal, { ...input, consumer: reorderedConsumer })).jobId, job.jobId);
  await assert.rejects(
    restored.submit(principal, { ...input, consumer: { ...consumer, headSha: 'd'.repeat(40) } }),
    /idempotency_conflict/,
  );
});

test('a schedule source cannot authorize an ordinary command or an unrelated Alpha subscription', async (t) => {
  const { service, input } = fixture(t);
  await assert.rejects(service.submit(principal, { ...input, consumer: undefined }), /invalid_managed_job_submission/);
  await assert.rejects(
    service.submit(principal, { ...input, originScheduleId: 'another-schedule' }),
    /invalid_managed_job_submission/,
  );
  await assert.rejects(
    service.submit(principal, { ...input, originInvocationId: 'invented-invocation' }),
    /invalid_managed_job_submission/,
  );
  assert.equal(service.list().length, 0);
});
