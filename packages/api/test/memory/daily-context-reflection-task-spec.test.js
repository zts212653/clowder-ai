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

  test('uses the scheduler cancellation signal instead of creating a second timeout controller', async () => {
    let active = 0;
    let receivedSignal;
    const spec = createDailyContextReflectionTaskSpec({
      runTimeoutMs: 20,
      producer: {
        run(options = {}) {
          receivedSignal = options.signal;
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
            }, 1_000);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('scheduler timeout after 20ms')), spec.run.timeoutMs);

    try {
      await assert.rejects(
        spec.run.execute(null, 'daily-context-reflection', {
          assignedCatId: null,
          signal: controller.signal,
        }),
        /scheduler timeout after 20ms/,
      );
    } finally {
      clearTimeout(timer);
    }

    assert.equal(spec.run.timeoutMs, 20);
    assert.equal(receivedSignal, controller.signal);
    assert.ok(
      Date.now() - startedAt < 500,
      'task timeout must beat the 1s backing producer even under full-suite load',
    );
    assert.equal(active, 0);
  });
});
