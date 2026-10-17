import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { executeTaskPipeline } = await import('../../dist/infrastructure/scheduler/execute-pipeline.js');
const { PipelineLanes } = await import('../../dist/infrastructure/scheduler/pipeline-lanes.js');
const { GITHUB_COLLECTION_LANE } = await import('../../dist/infrastructure/github/admission-budget.js');

/*
 * Every GitHub read for one credential goes through one serialized lane, and the GitHub collectors'
 * deadlines count time spent queued. The collectors are interval tasks registered together at boot,
 * so they ticked in the same second and interleaved their reads: each one's deadlines also paid for
 * the others' calls. After #1594, 43 of about 45 CI batch reads and every review-feedback collection
 * timed out, while the lane sat idle for half of each minute.
 */

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const idle = { run: false, reason: 'idle' };
const turn = () => new Promise((resolve) => setImmediate(resolve));

function spec(id, { lane, gate, timeoutMs = 30_000 }) {
  return {
    id,
    profile: 'poller',
    trigger: { type: 'interval', ms: 60_000 },
    ...(lane ? { lane } : {}),
    admission: { timeoutMs, gate },
    run: { overlap: 'skip', timeoutMs: 1_000, execute: async () => {} },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
  };
}

/** One scheduler's shared state, as TaskRunnerV2 keeps it. */
function scheduler() {
  const ledger = [];
  const shared = { running: new Map(), tickCounts: new Map(), lastRunAt: new Map(), lanes: new PipelineLanes() };
  return {
    ledger,
    tick: (task) =>
      executeTaskPipeline({
        task,
        ledger: { record: (row) => ledger.push(row) },
        logger: { info() {}, error() {} },
        ...shared,
      }),
  };
}

describe('collectors that share a lane take turns', () => {
  test('a second collector starts its gate only after the first one has finished', async () => {
    const s = scheduler();
    const events = [];
    const ciRead = deferred();
    const ci = spec('ci', {
      lane: 'github',
      gate: async () => {
        events.push('ci starts');
        await ciRead.promise;
        events.push('ci ends');
        return idle;
      },
    });
    const review = spec('review', {
      lane: 'github',
      gate: async () => {
        events.push('review starts');
        return idle;
      },
    });

    const ticks = [s.tick(ci), s.tick(review)];
    await turn();
    assert.deepEqual(events, ['ci starts'], 'review waits for its turn');
    ciRead.resolve();
    await Promise.all(ticks);

    assert.deepEqual(events, ['ci starts', 'ci ends', 'review starts']);
  });

  test("a waiting collector's deadline starts on its turn, not on its tick", async () => {
    const s = scheduler();
    const ciRead = deferred();
    let reviewBudgetMs;
    const ci = spec('ci', {
      lane: 'github',
      gate: async () => {
        await ciRead.promise;
        return idle;
      },
    });
    const review = spec('review', {
      lane: 'github',
      timeoutMs: 1_000,
      gate: async (ctx) => {
        reviewBudgetMs = ctx.deadlineMs - Date.now();
        return idle;
      },
    });

    const ticks = [s.tick(ci), s.tick(review)];
    // Longer than review's whole admission budget.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    ciRead.resolve();
    await Promise.all(ticks);

    assert.ok(reviewBudgetMs > 900, `review still has its full budget on its turn: ${reviewBudgetMs} ms`);
    assert.ok(!s.ledger.some((row) => row.task_id === 'review' && row.outcome === 'RUN_FAILED'));
  });

  test('a collector still waiting for its turn skips its next tick as overlap', async () => {
    const s = scheduler();
    const ciRead = deferred();
    let reviewGates = 0;
    const ci = spec('ci', {
      lane: 'github',
      gate: async () => {
        await ciRead.promise;
        return idle;
      },
    });
    const review = spec('review', {
      lane: 'github',
      gate: async () => {
        reviewGates++;
        return idle;
      },
    });

    const ticks = [s.tick(ci), s.tick(review)];
    await turn();
    await s.tick(review);
    ciRead.resolve();
    await Promise.all(ticks);

    assert.equal(reviewGates, 1, 'the waiting pipeline runs once, the next tick does not queue behind it');
    assert.equal(s.ledger.filter((row) => row.task_id === 'review' && row.outcome === 'SKIP_OVERLAP').length, 1);
  });

  test('a collector whose gate throws still hands the lane on', async () => {
    const s = scheduler();
    let reviewRan = false;
    const ci = spec('ci', {
      lane: 'github',
      gate: async () => {
        throw new Error('GitHub unavailable');
      },
    });
    const review = spec('review', {
      lane: 'github',
      gate: async () => {
        reviewRan = true;
        return idle;
      },
    });

    await Promise.all([s.tick(ci).catch(() => {}), s.tick(review)]);

    assert.equal(reviewRan, true);
  });

  test('a task without a lane does not wait for one', async () => {
    const s = scheduler();
    const ciRead = deferred();
    const events = [];
    const ci = spec('ci', {
      lane: 'github',
      gate: async () => {
        await ciRead.promise;
        return idle;
      },
    });
    const digest = spec('digest', {
      gate: async () => {
        events.push('digest');
        return idle;
      },
    });

    const ciTick = s.tick(ci);
    await turn();
    await s.tick(digest);
    assert.deepEqual(events, ['digest']);
    ciRead.resolve();
    await ciTick;
  });
});

describe('the GitHub collectors share one lane', () => {
  const log = { info() {}, warn() {}, error() {} };
  const deps = { log, taskStore: {}, cicdRouter: {}, reviewFeedbackRouter: {} };
  const factories = [
    ['../../dist/infrastructure/email/CiCdCheckTaskSpec.js', 'createCiCdCheckTaskSpec'],
    ['../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js', 'createReviewFeedbackTaskSpec'],
    ['../../dist/infrastructure/email/IssueCommentTaskSpec.js', 'createIssueCommentTaskSpec'],
    ['../../dist/infrastructure/email/ConflictCheckTaskSpec.js', 'createConflictCheckTaskSpec'],
  ];

  for (const [path, factory] of factories) {
    test(`${factory} runs on the GitHub collection lane`, async () => {
      const spec = (await import(path))[factory](deps);

      assert.equal(spec.lane, GITHUB_COLLECTION_LANE);
    });
  }
});
