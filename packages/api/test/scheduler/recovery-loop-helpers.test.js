import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import pino from 'pino';
import { recoveryGuarded, withinRecoveryDeadline } from '../../dist/infrastructure/recovery/recovery-deadline.js';
import { startRecoveryLoop } from '../../dist/infrastructure/recovery/recovery-loop.js';
import { runDueBatch } from '../../dist/infrastructure/recovery/run-due-batch.js';
import {
  createRecoveryLoopObserver,
  createSchedulerLogger,
} from '../../dist/infrastructure/scheduler/logging/adapter.js';

test('selection and error handling have deadlines; unvisited records never become failures', async () => {
  let release,
    errors = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await assert.rejects(
    runDueBatch({
      limit: 2,
      budgetMs: 20,
      selectDue: () => pending,
      process: () => assert.fail(),
      onItemError: () => {
        errors++;
      },
    }),
    /recovery_deadline_exceeded/,
  );
  assert.equal(errors, 0);
  release([1, 2]);
  await setImmediate();
  const failed = await runDueBatch({
    limit: 2,
    budgetMs: 20,
    selectDue: () => [1, 2],
    process: () => {
      throw new Error('original-owner-failure');
    },
    onItemError: () => new Promise(() => {}),
  });
  assert.equal(failed.failed, 1);
  assert.equal(failed.deferred, 1);
  assert.equal(failed.firstError.message, 'recovery_deadline_exceeded');
});

test('a retained asynchronous continuation cannot use owner I/O after its scope expires', async () => {
  let release,
    writes = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const owner = recoveryGuarded({
    read: () => pending,
    write: () => {
      writes++;
    },
  });
  let continuation;
  await assert.rejects(
    withinRecoveryDeadline(
      performance.now() + 20,
      () => performance.now(),
      () => {
        continuation = (async () => {
          await owner.read();
          owner.write();
        })();
        return continuation;
      },
    ),
    /recovery_deadline_exceeded/,
  );
  release('late');
  await assert.rejects(continuation, /recovery_deadline_exceeded/);
  assert.equal(writes, 0);
});

test('scheduler logger preserves installed Pino message/type/stack while omitting attached payload and credentials', () => {
  const lines = [];
  const log = pino({ base: null }, { write: (line) => lines.push(JSON.parse(line)) });
  const scheduler = createSchedulerLogger(log);
  const error = new TypeError('synthetic scheduler read failed');
  error.payload = { token: 'synthetic-secret-never-logged' };
  scheduler.error('scheduler recovery failure', error);
  assert.equal(lines[0].msg, 'scheduler recovery failure');
  assert.equal(lines[0].err.type, 'TypeError');
  assert.equal(lines[0].err.message, error.message);
  assert.equal(lines[0].err.stack, error.stack);
  assert.ok(!JSON.stringify(lines).includes('synthetic-secret-never-logged'));
  createRecoveryLoopObserver(log)({ loopId: 'test-owner', elapsedMs: 7, stats: { processed: 2 } });
  createRecoveryLoopObserver(log)({ loopId: 'test-owner', elapsedMs: 9, error });
  assert.equal(lines.length, 3);
  assert.equal(lines[1].processed, 2);
  assert.equal(lines[2].err.type, 'TypeError');
  scheduler.error('scheduler rejected an unknown template');
  assert.equal(lines[3].err, undefined, 'a message-only failure must not invent an Error');
  assert.ok(!JSON.stringify(lines).includes('synthetic-secret-never-logged'));
});

test('batch limit reaches the actual selector; item failures isolate and budget truncation never calls the owner failure hook', async () => {
  let clock = 0;
  const visited = [],
    failures = [];
  const result = await runDueBatch({
    limit: 5,
    budgetMs: 5,
    clock: () => clock,
    selectDue: (limit) => {
      assert.equal(limit, 5);
      return [1, 2, 3, 4, 5];
    },
    process: (n) => {
      visited.push(n);
      clock += 2;
      if (n === 2) throw new Error('bad-owner');
      return n;
    },
    onItemError: (n, error) => failures.push([n, error.message]),
  });
  assert.deepEqual(visited, [1, 2, 3]);
  assert.deepEqual(failures, [[2, 'bad-owner']]);
  assert.equal(result.selected, 5);
  assert.equal(result.processed, 3);
  assert.equal(result.deferred, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.firstError.message, 'bad-owner');
  assert.deepEqual(result.results, [1, 3]);
  await assert.rejects(
    runDueBatch({
      limit: 1,
      budgetMs: 1,
      selectDue: () => [1, 2],
      process: () => assert.fail(),
      onItemError: () => {},
    }),
    /exceeded_limit/,
  );
});

test('cadence serializes an in-flight owner and emits exactly one observation per completed or failed round', async () => {
  const observed = [],
    observerFailures = [];
  let interval,
    release,
    calls = 0,
    clock = 1;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const error = new Error('owner query failed');
  const timer = startRecoveryLoop(
    {
      id: 'test-owner',
      intervalMs: 30_000,
      runOnce: async () => {
        calls++;
        if (calls === 1) await pending;
        else throw error;
        return { processed: 2 };
      },
      observe: (result) => observed.push(result),
    },
    {
      clock: () => clock,
      onObserverError: (e) => observerFailures.push(e),
      setIntervalFn: (callback, ms) => {
        assert.equal(ms, 30_000);
        interval = callback;
        return { unref() {} };
      },
    },
  );
  interval();
  interval();
  assert.equal(calls, 1);
  assert.equal(observed.length, 0);
  clock = 7;
  release();
  await setImmediate();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].elapsedMs, 6);
  interval();
  await setImmediate();
  assert.equal(observed.length, 2);
  assert.equal(observed[1].error, error);
  assert.deepEqual(observerFailures, []);
  assert.ok(timer);
});

test('real ActionSuccessor cycle AggregateError retains the underlying failure cause without its payload', async () => {
  const { createActionSuccessorRecoveryCycle } = await import(
    '../../dist/domains/ball-custody/ActionSuccessorRecoveryCycle.js'
  );
  const lines = [];
  const log = pino({ base: null }, { write: (line) => lines.push(JSON.parse(line)) });
  const scheduler = createSchedulerLogger(log);
  const cause = new TypeError('synthetic owner read failed', { cause: new Error('synthetic underlying I/O failure') });
  cause.payload = { marker: 'synthetic-private-body' };
  const cycle = createActionSuccessorRecoveryCycle({
    recoverReturns: async () => {
      throw cause;
    },
    recoverDispatches: async () => ({ scanned: 0, delivered: 0, pending: 0, failed: 0 }),
    reconcileDoneTasks: async () => undefined,
  });
  await assert.rejects(cycle(), (error) => {
    scheduler.error('owner cycle failed', error);
    return error instanceof AggregateError;
  });
  assert.equal(lines[0].err.aggregateErrors?.[0]?.type, 'TypeError');
  assert.ok(lines[0].err.aggregateErrors[0].stack.includes('synthetic underlying I/O failure'));
  assert.ok(!JSON.stringify(lines).includes('synthetic-private-body'));
});
