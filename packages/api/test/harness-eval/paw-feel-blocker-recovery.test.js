import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PawFeelBlockerReconciler } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/blocker-reconciler.js';
import {
  censusLegacyPawFeelBlockers,
  executeLegacyPawFeelBlockerRecovery,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/legacy-blocker-recovery.js';
import { PawFeelCanonicalResumeConditionResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/resume-condition-owner.js';
import { projectPawFeelDisposition } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/projector.js';
import { PawFeelDispositionService } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/service.js';
import {
  createPawFeelServiceHarness,
  MemoryPawFeelEventLog,
  pawFeelCandidate,
  pawFeelCommand,
} from './helpers/paw-feel-disposition-service-fixture.js';

const taskRef = { ownerFeatureId: 'F310', ownerStateRef: 'task:item:task-1' };

async function typedHarness() {
  const eventLog = new MemoryPawFeelEventLog();
  let resolverCalls = 0;
  let snapshot = {
    normalizedSelector: { kind: 'task', ref: taskRef },
    state: 'doing',
    version: 'task:4:doing',
    satisfied: false,
    evidenceRefs: [{ ...taskRef, version: '4' }],
  };
  const conditionResolver = {
    async resolve() {
      resolverCalls += 1;
      return snapshot;
    },
  };
  const service = new PawFeelDispositionService({
    eventLog,
    resumeConditionResolver: conditionResolver,
    now: () => '2026-09-07T00:00:00.000Z',
  });
  const source = pawFeelCandidate();
  await service.discover(source, { backfilled: false });
  return {
    eventLog,
    service,
    source,
    getResolverCalls() {
      return resolverCalls;
    },
    setSnapshot(value) {
      snapshot = value;
    },
  };
}

describe('F313 recoverable blocker conditions', () => {
  it('rejects a new unbounded blocker before append', async () => {
    const { eventLog, service, source } = await typedHarness();
    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'opus' },
        pawFeelCommand('mark_blocked', source.signalId, 1, {
          blockerCode: 'external_wait',
          blockerRef: 'case:123',
        }),
      ),
      (error) => error?.code === 'invalid_command',
    );
    assert.equal((await eventLog.read(source.signalId)).length, 1);
  });

  it('freezes server-derived condition identity and writes nothing while the condition is stable', async () => {
    const { eventLog, service, source, getResolverCalls } = await typedHarness();
    const blocked = await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_blocked', source.signalId, 1, {
        blockerCode: 'task_wait',
        blockerRef: 'task:item:task-1',
        resume: { kind: 'task', ref: taskRef },
      }),
    );
    const condition = blocked.projection.blocker.resumeCondition;
    assert.match(condition.conditionId, /^[a-f0-9]{64}$/);
    assert.match(condition.blockedVersion, /^[a-f0-9]{64}$/);
    assert.deepEqual(condition.selector, { kind: 'task', ref: taskRef });
    assert.equal(getResolverCalls(), 1, 'blocking freezes one service-owned resolver snapshot');

    const reconciler = new PawFeelBlockerReconciler({ service });
    const result = await reconciler.reconcile();

    assert.deepEqual(result.counts, { scanned: 1, stable: 1, reopened: 0, conflicted: 0, deferred: 0, failed: 0 });
    assert.equal(getResolverCalls(), 2, 'reconciliation rereads the resolver through the service boundary');
    assert.equal((await eventLog.read(source.signalId)).length, 2);
  });

  it('derives one CAS-safe reopen across change, race, restart, and task failure snapshots', async () => {
    const { eventLog, service, source, setSnapshot } = await typedHarness();
    await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_blocked', source.signalId, 1, {
        blockerCode: 'task_wait',
        blockerRef: 'task:item:task-1',
        resume: { kind: 'task', ref: taskRef },
      }),
    );
    setSnapshot({
      normalizedSelector: { kind: 'task', ref: taskRef },
      state: 'failed',
      version: 'task:5:blocked',
      satisfied: true,
      evidenceRefs: [{ ...taskRef, version: '5' }],
    });
    const first = new PawFeelBlockerReconciler({ service });
    const second = new PawFeelBlockerReconciler({ service });

    await Promise.all([first.reconcile(), second.reconcile()]);
    const events = await eventLog.read(source.signalId);
    const reopen = events.filter((event) => event.type === 'blocker_reopened');

    assert.equal(reopen.length, 1);
    assert.equal(reopen[0].reopen.kind, 'condition');
    assert.equal(reopen[0].reopen.reason, 'condition_changed');
    assert.match(reopen[0].eventId, /^paw-feel-blocker-reopened:v1:[a-f0-9]{64}$/);
    assert.equal((await first.reconcile()).counts.reopened, 0, 'restart replay must be a no-op');
  });

  it('rejects a pure time blocker with no named repair dependency', async () => {
    const eventLog = new MemoryPawFeelEventLog();
    const conditionResolver = {
      async resolve(selector) {
        return {
          normalizedSelector: selector,
          state: 'waiting',
          version: selector.recheckAt,
          satisfied: false,
          evidenceRefs: [],
        };
      },
    };
    const service = new PawFeelDispositionService({
      eventLog,
      resumeConditionResolver: conditionResolver,
      now: () => '2026-09-07T00:00:00.000Z',
    });
    const source = pawFeelCandidate();
    await service.discover(source, { backfilled: false });
    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'opus' },
        pawFeelCommand('mark_blocked', source.signalId, 1, {
          blockerCode: 'bounded_wait',
          blockerRef: 'clock:next-check',
          resume: { kind: 'bounded_time', recheckAt: '2026-09-07T02:00:00.000Z' },
        }),
      ),
      /active repair task/u,
    );
    assert.equal((await eventLog.read(source.signalId)).length, 1);
  });

  it('keeps a due repair blocked until its retained task completes, then resumes the same fix', async () => {
    const task = { id: 'task-1', ownerCatId: 'opus', threadId: 'thread-repair', status: 'doing', updatedAt: 1 };
    const resumeConditionResolver = new PawFeelCanonicalResumeConditionResolver({
      async get(taskId) {
        return taskId === task.id ? task : null;
      },
    });
    const { eventLog, service } = createPawFeelServiceHarness({ resumeConditionResolver });
    const source = pawFeelCandidate();
    await service.discover(source, { backfilled: false });
    const fixed = await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_fix', source.signalId, 1, {
        leaseId: 'lease-active',
        actionRef: 'fixture-action',
      }),
    );
    assert.equal(fixed.projection.state, 'fix');

    const blocked = await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_blocked', source.signalId, 2, {
        blockerCode: 'bounded_wait',
        blockerRef: 'clock:next-check',
        resume: { kind: 'bounded_time', recheckAt: '2026-07-26T00:00:03.000Z' },
      }),
    );
    assert.equal(blocked.projection.state, 'blocked');
    assert.equal(blocked.projection.taskId, 'task-1');
    assert.equal(blocked.projection.actionLeaseRef?.leaseId, 'lease-active');
    assert.ok(blocked.projection.directRepairBinding);
    assert.deepEqual(blocked.projection.blocker?.resumeCondition?.selector, {
      kind: 'bounded_time',
      recheckAt: '2026-07-26T00:00:03.000Z',
      dependencyRef: taskRef,
    });

    const due = await new PawFeelBlockerReconciler({ service }).reconcile();
    assert.equal(due.counts.deferred, 1);
    assert.equal(due.counts.reopened, 0);
    const stillBlocked = projectPawFeelDisposition(await eventLog.read(source.signalId));
    assert.equal(stillBlocked.state, 'blocked');
    assert.equal(stillBlocked.taskId, 'task-1');
    assert.equal(stillBlocked.actionLeaseRef?.leaseId, 'lease-active');
    assert.ok(stillBlocked.directRepairBinding);

    task.status = 'done';
    task.updatedAt = 2;
    const completed = await new PawFeelBlockerReconciler({ service }).reconcile();
    assert.equal(completed.counts.reopened, 1);
    const resumed = projectPawFeelDisposition(await eventLog.read(source.signalId));
    assert.equal(resumed.state, 'fix');
    assert.equal(resumed.taskId, 'task-1');
    assert.equal(resumed.actionLeaseRef?.leaseId, 'lease-active');
    assert.ok(resumed.directRepairBinding);
  });

  it('keeps repair provenance through blocker revisions and resumes it after evidence changes', async () => {
    let taskVersion = 'task:1:doing';
    const resumeConditionResolver = {
      async resolve(selector) {
        return {
          normalizedSelector: selector,
          state: 'doing',
          version: taskVersion,
          satisfied: false,
          evidenceRefs: [{ ...selector.ref, version: taskVersion }],
        };
      },
    };
    const { eventLog, service } = createPawFeelServiceHarness({ resumeConditionResolver });
    const source = pawFeelCandidate({ messageId: 'revised-blocker', digest: 'd'.repeat(64) });
    await service.discover(source, { backfilled: false });
    const fixed = await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_fix', source.signalId, 1, { leaseId: 'lease-active', actionRef: 'fixture-action' }),
    );
    const block = (sequence, blockerRef) =>
      service.execute(
        { kind: 'cat', id: 'opus' },
        pawFeelCommand('mark_blocked', source.signalId, sequence, {
          blockerCode: 'task_wait',
          blockerRef,
          resume: { kind: 'task', ref: taskRef },
        }),
      );
    await block(2, 'task:item:task-1');
    const revised = await block(3, 'task:item:task-1:updated-reason');
    assert.equal(revised.projection.taskId, fixed.projection.taskId);
    assert.equal(revised.projection.actionLeaseRef?.leaseId, 'lease-active');
    assert.deepEqual(revised.projection.directRepairBinding, fixed.projection.directRepairBinding);

    taskVersion = 'task:2:done';
    const changed = await new PawFeelBlockerReconciler({ service }).reconcile();
    assert.equal(changed.counts.reopened, 1);
    const resumed = projectPawFeelDisposition(await eventLog.read(source.signalId));
    assert.equal(resumed.state, 'fix');
    assert.equal(resumed.taskId, fixed.projection.taskId);
  });

  it('resumes the same repair only after its canonical task evidence changes', async () => {
    let taskVersion = 'task:1:doing';
    const resumeConditionResolver = {
      async resolve(selector) {
        return {
          normalizedSelector: selector,
          state: 'doing',
          version: taskVersion,
          satisfied: false,
          evidenceRefs: [{ ...selector.ref, version: taskVersion }],
        };
      },
    };
    const { eventLog, service } = createPawFeelServiceHarness({ resumeConditionResolver });
    const source = pawFeelCandidate({ messageId: 'task-backed-repair', digest: 'c'.repeat(64) });
    await service.discover(source, { backfilled: false });
    await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_fix', source.signalId, 1, {
        leaseId: 'lease-active',
        actionRef: 'fixture-action',
      }),
    );
    await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_blocked', source.signalId, 2, {
        blockerCode: 'task_wait',
        blockerRef: 'task:item:task-1',
        resume: { kind: 'task', ref: taskRef },
      }),
    );

    taskVersion = 'task:2:doing';
    const changed = await new PawFeelBlockerReconciler({ service }).reconcile();
    assert.equal(changed.counts.reopened, 1);
    const resumed = projectPawFeelDisposition(await eventLog.read(source.signalId));
    assert.equal(resumed.state, 'fix');
    assert.equal(resumed.taskId, 'task-1');
    assert.equal(resumed.actionLeaseRef?.leaseId, 'lease-active');
    assert.ok(resumed.directRepairBinding);
  });

  it('does not starve a changed blocker behind stable or non-blocked signals at the write limit', async () => {
    const eventLog = new MemoryPawFeelEventLog();
    const versions = new Map([
      ['task:item:stable', 'v1'],
      ['task:item:changed', 'v1'],
    ]);
    const conditionResolver = {
      async resolve(selector) {
        return {
          normalizedSelector: selector,
          state: 'doing',
          version: versions.get(selector.ref.ownerStateRef),
          satisfied: false,
          evidenceRefs: [{ ...selector.ref, version: versions.get(selector.ref.ownerStateRef) }],
        };
      },
    };
    const service = new PawFeelDispositionService({
      eventLog,
      resumeConditionResolver: conditionResolver,
      now: () => '2026-09-07T00:00:00.000Z',
    });
    const ignored = pawFeelCandidate({ messageId: '00-ignored', digest: '1'.repeat(64) });
    const stable = pawFeelCandidate({ messageId: '01-stable', digest: '2'.repeat(64) });
    const changed = pawFeelCandidate({ messageId: '99-changed', digest: '3'.repeat(64) });
    for (const source of [ignored, stable, changed]) await service.discover(source, { backfilled: false });
    for (const [source, taskId] of [
      [stable, 'stable'],
      [changed, 'changed'],
    ]) {
      await service.execute(
        { kind: 'cat', id: 'opus' },
        pawFeelCommand('mark_blocked', source.signalId, 1, {
          eventId: `block:${taskId}`,
          blockerCode: 'task_wait',
          blockerRef: `task:item:${taskId}`,
          resume: { kind: 'task', ref: { ownerFeatureId: 'F310', ownerStateRef: `task:item:${taskId}` } },
        }),
      );
    }
    versions.set('task:item:changed', 'v2');

    const reconciler = new PawFeelBlockerReconciler({
      service,
      limit: 1,
    });
    const pages = [await reconciler.reconcile(), await reconciler.reconcile(), await reconciler.reconcile()];
    const counts = pages.reduce(
      (total, page) => Object.fromEntries(Object.keys(total).map((key) => [key, total[key] + page.counts[key]])),
      { scanned: 0, stable: 0, reopened: 0, conflicted: 0, deferred: 0, failed: 0 },
    );

    assert.deepEqual(counts, {
      scanned: 2,
      stable: 1,
      reopened: 1,
      conflicted: 0,
      deferred: 0,
      failed: 0,
    });
  });

  it('rejects resolver selector drift without appending a reopen', async () => {
    const { eventLog, service, source, setSnapshot } = await typedHarness();
    await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_blocked', source.signalId, 1, {
        blockerCode: 'task_wait',
        blockerRef: 'task:item:task-1',
        resume: { kind: 'task', ref: taskRef },
      }),
    );
    setSnapshot({
      normalizedSelector: {
        kind: 'task',
        ref: { ownerFeatureId: 'F310', ownerStateRef: 'task:item:foreign' },
      },
      state: 'done',
      version: 'foreign:done',
      satisfied: true,
      evidenceRefs: [],
    });

    await assert.rejects(new PawFeelBlockerReconciler({ service }).reconcile(), /selector/i);
    assert.equal((await eventLog.read(source.signalId)).length, 2);
  });

  it('advances a process-local cursor through 500 signals with at most 50 reads per scheduler tick', async () => {
    const signalIds = Array.from({ length: 500 }, (_, index) => `signal-${String(index).padStart(3, '0')}`);
    const reconciled = [];
    const scanLimits = [];
    const service = {
      async scanSignalIds(cursor, limit) {
        scanLimits.push(limit);
        const offset = cursor ? Number(cursor.redisCursor) : 0;
        const page = signalIds.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
          signalIds: page,
          scanCalls: 1,
          ...(nextOffset < signalIds.length
            ? {
                nextCursor: {
                  redisCursor: String(nextOffset),
                  pendingSignalIds: [],
                  completeAfterPending: false,
                },
              }
            : {}),
        };
      },
      async reconcileBlocker(signalId) {
        reconciled.push(signalId);
        return 'stable';
      },
    };
    const reconciler = new PawFeelBlockerReconciler({ service, limit: 50 });

    for (let tick = 0; tick < 10; tick += 1) {
      const result = await reconciler.reconcile();
      assert.equal(result.counts.scanned, 50);
    }

    assert.deepEqual(scanLimits, Array(10).fill(50));
    assert.equal(reconciled.length, 500);
    assert.equal(new Set(reconciled).size, 500);
  });
});

describe('F313 bounded legacy blocker recovery', () => {
  it('freezes at most 50 rows and requires explicit production-data authority before mutation', async () => {
    const eventLog = new MemoryPawFeelEventLog();
    for (let index = 0; index < 51; index += 1) {
      const source = pawFeelCandidate({ messageId: `legacy-${index}`, digest: index.toString(16).padStart(64, '0') });
      await eventLog.append(
        {
          eventId: `discover:${index}`,
          signalId: source.signalId,
          type: 'discovered',
          actor: { kind: 'migration', id: 'legacy-fixture' },
          occurredAt: '2026-09-01T00:00:00.000Z',
          source: {
            sourceMessageId: source.sourceMessageId,
            sourceThreadId: source.sourceThreadId,
            sourceCatId: source.sourceCatId,
            markerDigest: source.markerDigest,
            sameDigestOrdinal: source.sameDigestOrdinal,
            markerIndex: source.markerIndex,
          },
          backfilled: true,
          captureMethod: 'legacy_parser',
          captureAssessment: 'ambiguous',
        },
        0,
      );
      await eventLog.append(
        {
          eventId: `blocked:${index}`,
          signalId: source.signalId,
          type: 'blocked',
          actor: { kind: 'cat', id: 'opus' },
          occurredAt: '2026-09-01T00:00:01.000Z',
          blockerCode: 'legacy_wait',
          blockerRef: `legacy:${index}`,
        },
        1,
      );
    }
    const service = new PawFeelDispositionService({ eventLog });
    const manifest = await censusLegacyPawFeelBlockers(service);
    assert.equal(manifest.entries.length, 50);
    assert.equal(manifest.truncated, true);
    assert.match(manifest.manifestDigest, /^[a-f0-9]{64}$/);
    await assert.rejects(executeLegacyPawFeelBlockerRecovery({ service, manifest }), /production-data authorization/i);

    const receipt = await executeLegacyPawFeelBlockerRecovery({
      service,
      manifest,
      productionDataAuthorizationRef: 'cvo-authorization:phase-d-legacy-reopen',
    });
    const replay = await executeLegacyPawFeelBlockerRecovery({
      service,
      manifest,
      productionDataAuthorizationRef: 'cvo-authorization:phase-d-legacy-reopen',
    });
    assert.deepEqual(receipt.counts, { applied: 50, stale: 0, idempotent: 0 });
    assert.deepEqual(replay.counts, { applied: 0, stale: 0, idempotent: 50 });
  });
});
