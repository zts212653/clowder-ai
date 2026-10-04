import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { executeTaskPipeline } from '../../dist/infrastructure/scheduler/execute-pipeline.js';

test('admission timeout cancels upstream and keeps the overlap lock until cleanup settles', async () => {
  const running = new Map();
  const records = [];
  let aborted = false;
  let executed = 0;
  let release;
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  const context = {
    task: {
      id: 'bounded-gate',
      profile: 'poller',
      trigger: { type: 'interval', ms: 100 },
      enabled: () => true,
      admission: {
        timeoutMs: 10,
        async gate(ctx) {
          if (!ctx.signal) return { run: true, workItems: [{ signal: 'unsafe', subjectKey: 'a' }] };
          await new Promise((resolve) =>
            ctx.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          );
          await cleanup;
          ctx.signal.throwIfAborted();
          return { run: false, reason: 'cancelled' };
        },
      },
      run: {
        overlap: 'skip',
        timeoutMs: 100,
        async execute() {
          executed++;
        },
      },
      outcome: { whenNoSignal: 'drop' },
    },
    ledger: { record: (row) => records.push(row) },
    logger: { info() {}, error() {} },
    running,
    tickCounts: new Map(),
    lastRunAt: new Map(),
  };
  const first = executeTaskPipeline(context).then(
    () => null,
    (error) => error,
  );
  await delay(30);
  assert.equal(aborted, true, 'admission receives a deadline-bound abort signal');
  assert.equal(running.get('bounded-gate'), true, 'cleanup still owns the overlap lock');
  await executeTaskPipeline(context);
  assert.equal(records.at(-1)?.outcome, 'SKIP_OVERLAP');
  release();
  assert.match(String(await first), /admission timed out/);
  assert.equal(executed, 0);
  assert.equal(running.get('bounded-gate'), false);
  assert.equal(records.at(-1)?.outcome, 'RUN_FAILED', 'admission timeout must be visible in durable run history');
});
