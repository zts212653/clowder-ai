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

describe('AutoDreamStore diary lifecycle and metrics', () => {
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

  test('archives without mutating published diary content', async () => {
    const awakened = await begin();
    const result = await store.settleRun(principal(), {
      runId: awakened.run.runId,
      outcome: 'diary',
      diary: diary(),
    });
    const archived = await store.archiveDiary(OWNER, result.diary.diaryId);
    assert.equal(archived.status, 'archived');
    assert.equal(archived.bodyMarkdown, result.diary.bodyMarkdown);
    assert.equal((await store.listDiaries(OWNER)).length, 0);
    assert.equal((await store.listDiaries(OWNER, { includeArchived: true })).length, 1);
    assert.equal(await store.archiveDiary('owner-b', result.diary.diaryId), null);
  });

  test('calculates low-sample work share without warning until five diary outcomes exist', async () => {
    async function writeWorkDiary(index) {
      clock += 1;
      const awakened = await begin({ taskId: `low-sample-${index}` });
      return store.settleRun(principal({ invocationId: `low-sample-inv-${index}` }), {
        runId: awakened.run.runId,
        outcome: 'diary',
        diary: diary({ traceKind: 'work', headline: `low-sample-entry-${index}` }),
      });
    }

    for (let index = 0; index < 4; index += 1) await writeWorkDiary(index);
    const lowSample = await store.getMetrics(OWNER, CAT, 20);
    assert.equal(lowSample.diaryCount, 4);
    assert.equal(lowSample.workShare, 1);
    assert.equal(lowSample.minimumDiarySamples, 5);
    assert.equal(lowSample.lowSample, true);
    assert.equal(lowSample.reportificationWarning, false);

    await writeWorkDiary(4);
    const eligible = await store.getMetrics(OWNER, CAT, 20);
    assert.equal(eligible.diaryCount, 5);
    assert.equal(eligible.workShare, 1);
    assert.equal(eligible.lowSample, false);
    assert.equal(eligible.reportificationWarning, true);
  });

  test('warns only above an 80 percent work share and never mutates run or diary state', async () => {
    async function writeEntry(traceKind, index) {
      clock += 1;
      const awakened = await begin({ taskId: `metric-${index}` });
      return store.settleRun(principal({ invocationId: `metric-inv-${index}` }), {
        runId: awakened.run.runId,
        outcome: 'diary',
        diary: diary({ traceKind, headline: `entry-${index}` }),
      });
    }

    for (let index = 0; index < 4; index++) await writeEntry('non_work', index);
    for (let index = 4; index < 20; index++) await writeEntry('work', index);

    const boundary = await store.getMetrics(OWNER, CAT, 20);
    assert.equal(boundary.workShare, 0.8);
    assert.equal(boundary.reportificationWarning, false);

    const final = await writeEntry('work', 20);
    const above = await store.getMetrics(OWNER, CAT, 20);
    assert.equal(above.workShare, 0.85);
    assert.equal(above.reportificationWarning, true);
    assert.equal(above.silentOutcomeShare, 0);
    assert.equal((await store.getRun(OWNER, final.run.runId))?.state, 'settled');
    assert.equal((await store.getDiary(OWNER, final.diary.diaryId))?.status, 'published');
  });
});
