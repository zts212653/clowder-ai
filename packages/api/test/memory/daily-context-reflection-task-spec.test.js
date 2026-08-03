import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createDailyContextReflectionTaskSpec,
  DAILY_CONTEXT_REFLECTION_TASK_ID,
} from '../../dist/domains/memory/DailyContextReflectionTaskSpec.js';

describe('F271 daily context reflection F139 task', () => {
  test('registers one low-frequency household-local cron and records quiet as success', async () => {
    let runs = 0;
    const logs = [];
    const spec = createDailyContextReflectionTaskSpec({
      producer: {
        async run() {
          runs += 1;
          return {
            sourceLocalDate: '2026-07-25',
            sessionsConsidered: 0,
            catBatches: 0,
            extracted: 0,
            accepted: 0,
            duplicates: 0,
            rejected: 0,
            cuesDelivered: 0,
            quiet: true,
          };
        },
      },
      householdTimeZone: 'America/Los_Angeles',
      log: {
        info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
        warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
      },
    });

    assert.equal(spec.id, DAILY_CONTEXT_REFLECTION_TASK_ID);
    assert.equal(spec.profile, 'poller');
    assert.match(spec.display.description, /前一日 session/);
    assert.deepEqual(spec.trigger, {
      type: 'cron',
      expression: '15 4 * * *',
      timezone: 'America/Los_Angeles',
    });
    assert.equal(spec.run.overlap, 'skip');
    assert.deepEqual(await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 }), {
      run: true,
      workItems: [{ signal: null, subjectKey: 'daily-context-reflection' }],
    });

    await spec.run.execute(null, 'daily-context-reflection', {});

    assert.equal(runs, 1);
    assert.ok(logs.some((entry) => entry.level === 'info' && entry.msg.includes('quiet day')));
    assert.equal(
      logs.some((entry) => entry.level === 'warn'),
      false,
    );
  });

  test('passes a bounded signal to the producer and returns only after timed-out work is stopped', async () => {
    let active = 0;
    const spec = createDailyContextReflectionTaskSpec({
      runTimeoutMs: 20,
      producer: {
        run(options = {}) {
          active += 1;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              active -= 1;
              resolve({
                sourceLocalDate: '2026-07-25',
                sessionsConsidered: 0,
                catBatches: 0,
                extracted: 0,
                accepted: 0,
                duplicates: 0,
                rejected: 0,
                cuesDelivered: 0,
                quiet: true,
              });
            }, 100);
            options.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                active -= 1;
                reject(options.signal.reason);
              },
              { once: true },
            );
          });
        },
      },
    });
    const startedAt = Date.now();

    await assert.rejects(
      spec.run.execute(null, 'daily-context-reflection', {}),
      /daily context reflection timed out after 20ms/,
    );

    assert.equal(spec.run.timeoutMs, 20);
    assert.ok(Date.now() - startedAt < 80);
    assert.equal(active, 0);
  });
});
