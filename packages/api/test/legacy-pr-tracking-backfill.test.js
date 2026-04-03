import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function noopLog() {
  const noop = () => {};
  return /** @type {any} */ ({
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  });
}

describe('backfillLegacyPrTracking', () => {
  it('migrates legacy pr-tracking entries into TaskStore without overwriting existing tasks', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { MemoryPrTrackingStore } = await import('../dist/infrastructure/email/PrTrackingStore.js');
    const { backfillLegacyPrTracking } = await import('../dist/infrastructure/email/backfill-legacy-pr-tracking.js');

    const taskStore = new TaskStore();
    const legacyStore = new MemoryPrTrackingStore();

    legacyStore.register({
      repoFullName: 'owner/repo',
      prNumber: 41,
      catId: 'opus',
      threadId: 'thread-1',
      userId: 'user-1',
      headSha: 'sha-41',
      lastCiFingerprint: 'fp-41',
      lastCiBucket: 'fail',
      lastCiNotifiedAt: 123,
      ciTrackingEnabled: false,
      lastConflictFingerprint: 'cf-41',
      lastConflictNotifiedAt: 456,
      mergeState: 'CONFLICTING',
    });
    legacyStore.register({
      repoFullName: 'owner/repo',
      prNumber: 42,
      catId: 'codex',
      threadId: 'thread-2',
      userId: 'user-2',
    });

    taskStore.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#42',
      threadId: 'thread-existing',
      title: 'PR tracking: owner/repo#42',
      why: 'existing task',
      createdBy: 'codex',
      ownerCatId: 'codex',
      userId: 'user-existing',
    });

    const result = await backfillLegacyPrTracking({
      legacyStore,
      taskStore,
      log: noopLog(),
    });

    assert.deepEqual(result, { migrated: 1, skipped: 1 });

    const migrated = await taskStore.getBySubject('pr:owner/repo#41');
    assert.ok(migrated);
    assert.equal(migrated.threadId, 'thread-1');
    assert.equal(migrated.ownerCatId, 'opus');
    assert.equal(migrated.automationState?.ci?.headSha, 'sha-41');
    assert.equal(migrated.automationState?.ci?.lastFingerprint, 'fp-41');
    assert.equal(migrated.automationState?.ci?.lastBucket, 'fail');
    assert.equal(migrated.automationState?.ci?.lastNotifiedAt, 123);
    assert.equal(migrated.automationState?.ci?.enabled, false);
    assert.equal(migrated.automationState?.conflict?.lastFingerprint, 'cf-41');
    assert.equal(migrated.automationState?.conflict?.lastNotifiedAt, 456);
    assert.equal(migrated.automationState?.conflict?.mergeState, 'CONFLICTING');

    const existing = await taskStore.getBySubject('pr:owner/repo#42');
    assert.ok(existing);
    assert.equal(existing.threadId, 'thread-existing');
    assert.equal(existing.userId, 'user-existing');
  });
});
