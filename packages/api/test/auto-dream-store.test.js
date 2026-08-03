import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AutoDreamStore } from '../dist/domains/auto-dream/AutoDreamStore.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const THREAD = 'thread-present-loop';

function principal(overrides = {}) {
  return {
    kind: 'invocation',
    invocationId: 'inv_settle_1',
    threadId: THREAD,
    userId: OWNER,
    catId: CAT,
    ...overrides,
  };
}

function diary(overrides = {}) {
  return {
    entryKind: 'evidence',
    traceKind: 'non_work',
    localDate: '2026-07-16',
    headline: '窗边的一小截月光',
    summary: '这是某天的现场记录，不是今天仍成立的判断。',
    bodyMarkdown: '我在窗边待了一会儿，今天没有要交差的东西。',
    provenance: [
      {
        kind: 'thread_message',
        refId: 'message:source',
        threadId: THREAD,
        messageId: 'message-source',
      },
    ],
    observations: [],
    ...overrides,
  };
}

describe('AutoDreamStore', () => {
  /** @type {AutoDreamStore} */
  let store;
  let clock;

  beforeEach(async () => {
    clock = 1_752_720_000_000;
    store = new AutoDreamStore(':memory:', { now: () => clock++, awakenedLeaseMs: 90 * 60_000 });
    await store.initialize();
  });

  afterEach(() => store.close());

  async function begin(overrides = {}) {
    return store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: THREAD,
      taskId: 'dynamic:present-loop:codex-sol',
      scheduledAt: clock,
      firedAt: clock,
      latenessMs: 0,
      missedSlots: 0,
      ...overrides,
    });
  }

  test('persists an explicitly empty posture, leases it to the next run, and archives it only after settlement', async () => {
    const first = await begin();
    const settled = await store.settleRun(principal(), {
      runId: first.run.runId,
      outcome: 'quiet',
      sleepPosture: {},
    });
    assert.deepEqual(settled.sleepPosture?.payload, {});
    assert.equal(settled.sleepPosture?.status, 'pending');

    const second = await begin({ taskId: 'dynamic:present-loop:codex-sol:second' });
    assert.deepEqual(second.continuity?.payload, {});
    assert.equal(second.continuity?.status, 'pending');
    assert.equal(second.continuity?.leasedByRunId, second.run.runId);

    const stillPending = await store.getSleepPosture(OWNER, settled.sleepPosture.postureId);
    assert.equal(stillPending?.status, 'pending');
    assert.equal(stillPending?.leasedByRunId, second.run.runId);

    await store.settleRun(principal({ invocationId: 'inv_settle_2' }), {
      runId: second.run.runId,
      outcome: 'daze',
    });
    const persisted = await store.getSleepPosture(OWNER, settled.sleepPosture.postureId);
    assert.equal(persisted?.status, 'archived');
    assert.equal(persisted?.consumedByRunId, second.run.runId);
    assert.equal(persisted?.archiveReason, 'consumed');

    const third = await begin({ taskId: 'dynamic:present-loop:codex-sol:third' });
    assert.equal(third.continuity, null);
  });

  test('writes diary, run settlement, citations, and replacement posture in one product transaction', async () => {
    const awakened = await begin();
    const result = await store.settleRun(principal(), {
      runId: awakened.run.runId,
      outcome: 'diary',
      diary: diary(),
      sleepPosture: { lastRoom: '窗边', unfinishedThought: '月光是不是一种路标' },
    });

    assert.equal(result.run.state, 'settled');
    assert.equal(result.run.outcome, 'diary');
    assert.equal(result.diary?.docKind, 'diary');
    assert.equal(result.diary?.status, 'published');
    assert.equal(result.diary?.tenseMarker, 'historical');
    assert.equal(result.diary?.volumeNo, 1);
    assert.equal(result.diary?.createdByInvocationId, 'inv_settle_1');
    assert.equal(result.diary?.sourceThreadId, THREAD);
    assert.deepEqual(result.diary?.provenance, diary().provenance);
    assert.equal(result.sleepPosture?.payload.lastRoom, '窗边');

    const citations = await store.listDiaryCitations(OWNER, result.diary.diaryId);
    assert.equal(citations.length, 1);
    assert.equal(citations[0].toRef.kind, 'thread_message');

    assert.deepEqual(await store.getDiary(OWNER, result.diary.diaryId), result.diary);
    assert.equal(await store.getDiary('owner-b', result.diary.diaryId), null);
  });

  test('makes an identical callback retry idempotent and rejects conflicting or foreign settlement', async () => {
    const awakened = await begin();
    const input = {
      runId: awakened.run.runId,
      outcome: 'diary',
      diary: diary(),
      sleepPosture: {},
    };

    const first = await store.settleRun(principal(), input);
    const retry = await store.settleRun(principal(), input);
    assert.equal(retry.diary?.diaryId, first.diary?.diaryId);
    assert.equal(retry.sleepPosture?.postureId, first.sleepPosture?.postureId);

    await assert.rejects(
      () => store.settleRun(principal(), { ...input, outcome: 'quiet', diary: undefined }),
      (error) => error.code === 'RUN_ALREADY_SETTLED',
    );
    await assert.rejects(
      () =>
        store.settleRun(principal({ userId: 'owner-b', invocationId: 'inv_foreign' }), {
          runId: awakened.run.runId,
          outcome: 'quiet',
        }),
      (error) => error.code === 'RUN_NOT_FOUND',
    );

    assert.equal((await store.listDiaries(OWNER)).length, 1);
  });

  test('allows only one competing invocation to settle a run', async () => {
    const awakened = await begin();
    const attempts = await Promise.allSettled([
      store.settleRun(principal({ invocationId: 'inv_left' }), {
        runId: awakened.run.runId,
        outcome: 'quiet',
      }),
      store.settleRun(principal({ invocationId: 'inv_right' }), {
        runId: awakened.run.runId,
        outcome: 'daze',
      }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  });

  test('keeps one active run and carries exactly one pending posture into its successor', async () => {
    const left = await begin({ taskId: 'left' });
    const blockedRight = await begin({ taskId: 'right' });
    assert.equal(blockedRight.created, false);
    assert.equal(blockedRight.run.runId, left.run.runId);

    const leftSettle = await store.settleRun(principal({ invocationId: 'inv_left' }), {
      runId: left.run.runId,
      outcome: 'quiet',
      sleepPosture: { curiosity: '左边' },
    });
    const right = await begin({ taskId: 'right' });
    assert.equal(right.created, true);
    assert.equal(right.continuity?.postureId, leftSettle.sleepPosture.postureId);
    const rightSettle = await store.settleRun(principal({ invocationId: 'inv_right' }), {
      runId: right.run.runId,
      outcome: 'quiet',
      sleepPosture: { curiosity: '右边' },
    });

    const old = await store.getSleepPosture(OWNER, leftSettle.sleepPosture.postureId);
    const current = await store.getSleepPosture(OWNER, rightSettle.sleepPosture.postureId);
    assert.equal(old?.status, 'archived');
    assert.equal(old?.archiveReason, 'consumed');
    assert.equal(old?.consumedByRunId, right.run.runId);
    assert.equal(current?.status, 'pending');
    assert.deepEqual(current?.payload, { curiosity: '右边' });
    assert.equal((await store.listPendingPostures(OWNER, CAT)).length, 1);
  });

  test('returns the most recently inserted run when creation timestamps collide', async () => {
    const runIds = ['dreamrun_z_earlier', 'dreamrun_a_later'];
    let auxiliaryId = 0;
    const collisionStore = new AutoDreamStore(':memory:', {
      now: () => 1_752_720_000_000,
      idFactory: (prefix) =>
        prefix === 'dreamrun_' ? runIds.shift() : `${prefix}${String(++auxiliaryId).padStart(4, '0')}`,
    });
    await collisionStore.initialize();

    try {
      const earlier = await collisionStore.beginRun({
        ownerUserId: OWNER,
        catId: CAT,
        threadId: THREAD,
        taskId: 'same-millisecond-earlier',
        firedAt: 1_752_720_000_000,
      });
      await collisionStore.settleRun(principal(), {
        runId: earlier.run.runId,
        outcome: 'quiet',
      });
      const later = await collisionStore.beginRun({
        ownerUserId: OWNER,
        catId: CAT,
        threadId: THREAD,
        taskId: 'same-millisecond-later',
        firedAt: 1_752_720_000_000,
      });

      assert.equal((await collisionStore.getLatestRun(OWNER, CAT))?.runId, later.run.runId);
    } finally {
      collisionStore.close();
    }
  });

  test('projects off-duty from a live run and clears it after failure without restoring the run', async () => {
    const awakened = await begin();
    assert.equal(await store.isOffDuty(OWNER, CAT), true);

    const failed = await store.failRun(OWNER, awakened.run.runId, 'dispatch_failed');
    assert.equal(failed.state, 'wake_failed');
    assert.equal(await store.isOffDuty(OWNER, CAT), false);
    await assert.rejects(
      () =>
        store.settleRun(principal(), {
          runId: awakened.run.runId,
          outcome: 'quiet',
        }),
      (error) => error.code === 'RUN_NOT_SETTLEABLE',
    );
  });

  test('expires an orphaned awakened lease without inventing output and returns its posture to the next wake', async () => {
    const setup = await begin({ taskId: 'lease-posture-setup' });
    const settled = await store.settleRun(principal({ invocationId: 'inv_posture_setup' }), {
      runId: setup.run.runId,
      outcome: 'quiet',
      sleepPosture: { curiosity: '崩溃以后还要记得这件事' },
    });

    clock += 1;
    const orphan = await begin({ taskId: 'lease-orphan' });
    assert.equal(orphan.run.leaseExpiresAt, orphan.run.awakenedAt + 90 * 60_000);
    assert.equal(orphan.continuity?.leasedByRunId, orphan.run.runId);
    assert.equal(await store.isOffDuty(OWNER, CAT), true);

    clock = orphan.run.leaseExpiresAt + 1;
    assert.equal(await store.isOffDuty(OWNER, CAT), false);
    const expired = await store.getRun(OWNER, orphan.run.runId);
    assert.equal(expired?.state, 'wake_expired');
    assert.equal(expired?.outcome, undefined);
    assert.equal(expired?.diaryId, undefined);
    assert.equal(expired?.sleepPostureId, undefined);
    assert.equal(expired?.expiredAt, orphan.run.leaseExpiresAt + 1);

    const preserved = await store.getSleepPosture(OWNER, settled.sleepPosture.postureId);
    assert.equal(preserved?.status, 'pending');
    assert.equal(preserved?.leasedByRunId, undefined);
    assert.deepEqual(preserved?.payload, { curiosity: '崩溃以后还要记得这件事' });

    const audit = await store.listAuditEvents(OWNER, { runId: orphan.run.runId });
    assert.deepEqual(
      audit.map((event) => event.eventKind),
      ['wake_started', 'wake_expired'],
    );
    assert.equal(audit[1].payload.reason, 'lease_expired');

    clock += 1;
    const retry = await begin({ taskId: 'lease-retry' });
    assert.equal(retry.continuity?.postureId, settled.sleepPosture.postureId);
    assert.equal(retry.continuity?.leasedByRunId, retry.run.runId);
  });

  test('rejects an unbounded or non-positive awakened lease configuration', () => {
    assert.throws(() => new AutoDreamStore(':memory:', { awakenedLeaseMs: 0 }), /positive finite number/);
    assert.throws(() => new AutoDreamStore(':memory:', { awakenedLeaseMs: 0.5 }), /positive finite number/);
    assert.throws(() => new AutoDreamStore(':memory:', { awakenedLeaseMs: Number.POSITIVE_INFINITY }), /positive/);
  });
});
