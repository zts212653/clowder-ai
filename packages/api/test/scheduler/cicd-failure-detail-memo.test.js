import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
const { executeTaskPipeline } = await import('../../dist/infrastructure/scheduler/execute-pipeline.js');
const { createCiCollectionReaders } = await import('../../dist/infrastructure/email/ci-status-batch-fetcher.js');
const { READ_MEMO_LIFETIME_MS, READ_MEMO_STAGGER_MS, ReadMemo, readMemoStagger } = await import(
  '../../dist/infrastructure/github/read-memo.js'
);
const MINUTE = 60_000;

/*
 * A failing PR's details (its required checks and their typed execution failures) take several
 * serialized `gh` reads. They were read again on every tick for as long as the PR stayed red,
 * although a completed rollup cannot change: the same HEAD with the same check runs has the same
 * details, and a rerun creates new check runs with new links. Two PRs left red for hours kept the
 * shared per-credential GitHub lane so busy that every other collector starved on it.
 */

const JOB = 'https://github.com/owner/repo/actions/runs/1/job/';

function batchPoll({ headSha = 'head-a', job = 1, observedAt = 1_000, ...rest } = {}) {
  return {
    repoFullName: 'owner/repo',
    prNumber: 7,
    headSha,
    prState: 'open',
    aggregateBucket: 'fail',
    checkRollup: 'present',
    checks: [
      { name: 'Build', bucket: 'pass', link: `${JOB}10` },
      { name: 'Test', bucket: 'fail', link: `${JOB}${job}` },
    ],
    observedAt,
    failureDetailsPending: true,
    ...rest,
  };
}

/** What a complete single-PR read returns for that rollup: required failures, typed. */
function completeRead(poll, observedAt) {
  return {
    repoFullName: poll.repoFullName,
    prNumber: poll.prNumber,
    headSha: poll.headSha,
    prState: poll.prState,
    aggregateBucket: poll.aggregateBucket,
    checkRollup: 'present',
    checks: poll.checks.filter((check) => check.bucket === 'fail').map((check) => ({ ...check, required: true })),
    observedAt,
  };
}

/** One spec instance across ticks, as the scheduler keeps it; each tick reads the next batch at `times[tick]`. */
async function collector({ polls, enrich = async (poll) => completeRead(poll, poll.observedAt + 500), times = [] }) {
  const taskStore = new TaskStore();
  await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#7',
    threadId: 'thread_7',
    title: 'PR wait',
    ownerCatId: 'codex-sol',
    why: 'test',
    createdBy: 'codex-sol',
    userId: 'user_1',
  });
  const routed = [];
  const reads = [];
  const ledger = [];
  let tick = 0;
  const spec = createCiCdCheckTaskSpec({
    taskStore,
    now: () => times[tick] ?? 0,
    cicdRouter: {
      route: async (poll) => {
        routed.push(poll);
        return { kind: 'skipped', reason: 'state-only' };
      },
    },
    fetchPrStatuses: async () => new Map([['owner/repo#7', polls[tick]]]),
    enrichFailureDetails: async (poll) => {
      reads.push(poll);
      return enrich(poll, reads.length);
    },
    log: { info() {}, warn() {}, error() {} },
  });
  const scheduler = { running: new Map(), tickCounts: new Map(), lastRunAt: new Map() };
  return {
    routed,
    reads,
    ledger,
    async runTicks() {
      for (tick = 0; tick < polls.length; tick++) {
        await executeTaskPipeline({
          task: spec,
          ledger: { record: (row) => ledger.push(row) },
          logger: { info() {}, error() {} },
          ...scheduler,
        });
      }
    },
  };
}

describe('CI failure details are read once per completed rollup', () => {
  test('a PR that stays red is read once, and every tick still routes its details', async () => {
    const polls = [1_000, 2_000, 3_000].map((observedAt) => batchPoll({ observedAt }));
    const ci = await collector({ polls });

    await ci.runTicks();

    assert.equal(ci.reads.length, 1, 'an unchanged rollup is not read again');
    assert.equal(ci.routed.length, 3, 'collection still advances every tick');
    for (const poll of ci.routed) {
      assert.deepEqual(poll.checks, [{ name: 'Test', bucket: 'fail', link: `${JOB}1`, required: true }]);
    }
    assert.deepEqual(
      ci.routed.map((poll) => poll.observedAt),
      [1_500, 2_000, 3_000],
      "a remembered read carries this tick's observation time, not the time it was read",
    );
  });

  test('a rerun on the same HEAD is read again', async () => {
    const ci = await collector({ polls: [batchPoll({ job: 1 }), batchPoll({ job: 2, observedAt: 2_000 })] });

    await ci.runTicks();

    assert.equal(ci.reads.length, 2);
    assert.equal(ci.routed[1].checks[0].link, `${JOB}2`);
  });

  test('a new HEAD is read again', async () => {
    const ci = await collector({
      polls: [batchPoll(), batchPoll({ headSha: 'head-b', observedAt: 2_000 })],
    });

    await ci.runTicks();

    assert.equal(ci.reads.length, 2);
    assert.equal(ci.routed[1].headSha, 'head-b');
  });

  test('a failed read is not remembered: the next tick reads again', async () => {
    const ci = await collector({
      polls: [batchPoll(), batchPoll({ observedAt: 2_000 })],
      enrich: async (poll, attempt) => {
        if (attempt === 1) throw new Error('detail collection timeout');
        return completeRead(poll, poll.observedAt + 500);
      },
    });

    await ci.runTicks();

    assert.equal(ci.reads.length, 2);
    assert.deepEqual(
      ci.ledger.map((row) => row.outcome),
      ['RUN_FAILED', 'RUN_DELIVERED'],
    );
  });

  test('a complete read that no longer matches the batch is routed but not remembered', async () => {
    // A rerun started between admission and the detail read: the exact read is already pending.
    const ci = await collector({
      polls: [batchPoll(), batchPoll({ observedAt: 2_000 })],
      enrich: async (poll, attempt) =>
        attempt === 1
          ? { ...completeRead(poll, 1_500), aggregateBucket: 'pending', checks: [] }
          : completeRead(poll, poll.observedAt + 500),
    });

    await ci.runTicks();

    assert.equal(ci.reads.length, 2);
    assert.equal(ci.routed[0].aggregateBucket, 'pending', 'the newer truth is what gets routed');
    assert.equal(ci.routed[1].aggregateBucket, 'fail');
  });

  test('a PR with more contexts than one batch page is read exactly on every tick', async () => {
    const page = { aggregateBucket: 'pending', checks: [], failureDetailsPending: undefined, fullRollupPending: true };
    const ci = await collector({
      polls: [batchPoll(page), batchPoll({ ...page, observedAt: 2_000 })],
    });

    await ci.runTicks();

    assert.equal(ci.reads.length, 2, 'without its full rollup there is nothing to recognise');
  });
});

describe('a detail read that fell back is retried, not remembered', () => {
  const FAILING = {
    __typename: 'CheckRun',
    name: 'gate',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: `${JOB}1`,
  };

  /** The production readers over a fake `gh`; `broken` names the read that fails on the first tick. */
  async function productionCollector(broken) {
    const taskStore = new TaskStore();
    await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#7',
      threadId: 'thread_7',
      title: 'PR wait',
      ownerCatId: 'codex-sol',
      why: 'test',
      createdBy: 'codex-sol',
      userId: 'user_1',
    });
    const log = { info() {}, warn() {}, error() {} };
    let tick = 0;
    let detailReads = 0;
    const transientFailure = (read) => {
      if (tick === 0 && broken === read) throw new Error('HTTP 502: Bad Gateway');
    };
    const rollup = { contexts: { nodes: [FAILING], pageInfo: { hasNextPage: false } } };
    const pr = { headRefOid: 'head-7', state: 'OPEN', mergedAt: null, mergedBy: null };
    const commits = { nodes: [{ commit: { statusCheckRollup: rollup } }] };
    const responders = [
      [(args) => args[1] === 'graphql', () => ({ data: { r0: { p0: { ...pr, commits } } } })],
      [
        (args) => args[0] === 'pr' && args[1] === 'view',
        () => {
          detailReads++;
          return { ...pr, statusCheckRollup: [FAILING] };
        },
      ],
      [
        (args) => args[0] === 'pr' && args[1] === 'checks',
        () => {
          transientFailure('checks');
          return [{ name: 'gate', bucket: 'fail', link: `${JOB}1` }];
        },
      ],
      [
        (args) => args[1].includes('/check-runs?'),
        () => {
          transientFailure('execution evidence');
          return { check_runs: [] };
        },
      ],
      [(args) => args[1].includes('/actions/runs?'), () => ({ workflow_runs: [] })],
    ];
    const readers = createCiCollectionReaders(log, () => 'fixture-token', {
      async execFileAsync(_file, args) {
        const responder = responders.find(([matches]) => matches(args));
        if (!responder) throw new Error(`unexpected request: ${args.join(' ')}`);
        return { stdout: JSON.stringify(responder[1]()) };
      },
    });
    const routed = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      log,
      ...readers,
      cicdRouter: {
        route: async (poll) => {
          routed.push(poll);
          return { kind: 'skipped', reason: 'state-only' };
        },
      },
    });
    const scheduler = { running: new Map(), tickCounts: new Map(), lastRunAt: new Map() };
    return {
      routed,
      detailReads: () => detailReads,
      async runTicks(count) {
        for (tick = 0; tick < count; tick++) {
          await executeTaskPipeline({
            task: spec,
            ledger: { record() {} },
            logger: { info() {}, error() {} },
            ...scheduler,
          });
        }
      },
    };
  }

  for (const broken of ['checks', 'execution evidence']) {
    test(`a failed ${broken} read is routed once as incomplete, then read again when GitHub recovers`, async () => {
      const ci = await productionCollector(broken);

      await ci.runTicks(3);

      assert.equal(ci.routed.length, 3);
      assert.equal(ci.routed[0].failureDetailsIncomplete, true, 'the fallback is still routed, marked incomplete');
      assert.equal(ci.routed[1].failureDetailsIncomplete, undefined);
      assert.deepEqual(
        ci.routed[1].checks.map((check) => check.name),
        ['gate'],
      );
      assert.equal(ci.detailReads(), 2, 'read again after the incomplete read; the complete read is then reused');
    });
  }
});

describe('a remembered detail read expires within a bounded, staggered window', () => {
  test('details are read again once the window has passed, even though the rollup is unchanged', async () => {
    // What a detail read depends on is not all in the rollup: branch protection, a check run's later output.
    const times = [0, 9 * MINUTE, READ_MEMO_LIFETIME_MS + READ_MEMO_STAGGER_MS];
    const ci = await collector({ polls: times.map((_, index) => batchPoll({ observedAt: 1_000 + index })), times });

    await ci.runTicks();

    assert.equal(ci.reads.length, 2, 'reused inside the window, read again after it');
  });

  test('reads remembered on the same tick expire at different times', () => {
    let now = 0;
    const memo = new ReadMemo(() => now);
    const [early, late] = ['owner/repo#7', 'owner/repo#8'].sort((a, b) => readMemoStagger(a) - readMemoStagger(b));
    for (const key of [early, late]) memo.remember(key, 'rollup', key);
    assert.ok(readMemoStagger(early) < readMemoStagger(late), 'the two keys are staggered apart');
    assert.ok(readMemoStagger(late) < READ_MEMO_STAGGER_MS);

    now = READ_MEMO_LIFETIME_MS + readMemoStagger(early);

    assert.equal(memo.recall(early, 'rollup'), undefined);
    assert.equal(memo.recall(late, 'rollup'), late);
  });
});
