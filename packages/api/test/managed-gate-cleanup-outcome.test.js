import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  rawDurableGateRecord,
  writeDurableGateRecord,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { finalOutcomeAfterCleanup } from '../dist/infrastructure/managed-runner-durable-recovery-outcome.js';

for (const [storage, rawCode, expected] of [
  ['sqlite_v1', 1, 1],
  ['sqlite_v1', 0, 0],
  [undefined, 1, 70],
]) {
  test(`unproven pipe cleanup preserves the observed result only in durable pending storage (${storage}/${rawCode})`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'managed-cleanup-outcome-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const service = new ManagedJobService(root);
    const principal = { userId: 'owner', threadId: 'thread', catId: 'codex61-sol' };
    const consumer = {
      kind: 'alpha_revision_v1',
      subscriptionId: 'schedule',
      s3JobId: `alpha-browser-${'a'.repeat(64)}`,
      headSha: 'b'.repeat(40),
      baseSha: 'c'.repeat(40),
    };
    const saved = await service.submit(principal, {
      command: 'printf unused',
      cwd: root,
      originTaskId: consumer.subscriptionId,
      originScheduleId: consumer.subscriptionId,
      consumer,
      idempotencyKey: 'fixture',
      executionSlaMs: 1000,
      wakeTarget: principal,
    });
    const attemptToken = randomUUID();
    assert.equal(writeDurableGateRecord(saved, { ...rawDurableGateRecord(saved), attemptToken }), true);
    const job = { ...saved, recordStorage: storage };
    const raw = { code: rawCode, signal: null };
    const attempt = {
      attemptToken,
      child: new ChildProcess(),
      currentExit: () => ({ result: raw, observedAt: Date.now() }),
      closed: new Promise(() => {}),
    };
    const chunks = [];
    const result = await finalOutcomeAfterCleanup(
      { job, capture: (b) => chunks.push(String(b)), readFence: () => null, terminationSignal: () => null },
      attempt,
      raw,
      30,
      5,
    );
    assert.equal(result.kind, 'final');
    assert.equal(result.result.code, expected);
    assert.match(chunks.join(''), /cleanup could not be proven/);
    if (storage === 'sqlite_v1') {
      assert.equal(rawDurableGateRecord(saved).cleanupProven, false);
      assert.equal(rawDurableGateRecord(saved).state, 'queued', 'no unproven terminal result is published');
    }
  });
}
