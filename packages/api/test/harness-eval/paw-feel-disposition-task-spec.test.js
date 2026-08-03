import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPawFeelReconciliationTaskSpec } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/reconciliation-task-spec.js';

describe('F278 reconciliation task spec', () => {
  it('runs every fifteen minutes and reports aggregate-only health', async () => {
    const calls = [];
    const logs = [];
    const metrics = [];
    const task = createPawFeelReconciliationTaskSpec({
      reconciler: {
        async run() {
          calls.push('run');
          return {
            mode: 'overlap',
            startedAt: '2026-07-26T12:00:00.000Z',
            completedAt: '2026-07-26T12:00:01.000Z',
            durationMs: 1_000,
            scannedMessages: 12,
            canonicalSignals: 3,
            discoveredSignals: 2,
            duplicateSignals: 1,
            lagMs: 0,
          };
        },
      },
      log: {
        info(...args) {
          logs.push(args);
        },
        warn(...args) {
          logs.push(args);
        },
      },
      metrics: {
        record(result) {
          metrics.push(result);
        },
        recordUnavailable() {
          assert.fail('healthy run must not record unavailable');
        },
      },
    });

    assert.deepEqual(task.trigger, { type: 'interval', ms: 15 * 60_000 });
    const gate = await task.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gate.run, true);
    assert.equal(gate.workItems.length, 1);
    await task.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {
      assignedCatId: null,
    });

    assert.deepEqual(calls, ['run']);
    assert.equal(metrics.length, 1);
    assert.equal(logs.length, 1);
    const encoded = JSON.stringify(logs);
    assert.doesNotMatch(encoded, /爪感差|marker|symptom/i);
    assert.match(encoded, /scannedMessages/);
    assert.equal(task.run.overlap, 'skip');
    assert.equal(task.state.runLedger, 'sqlite');
  });

  it('records unavailable and rethrows so scheduler truth is RUN_FAILED', async () => {
    const unavailable = [];
    const task = createPawFeelReconciliationTaskSpec({
      reconciler: {
        async run() {
          throw new Error('redis unavailable');
        },
      },
      log: { info() {}, warn() {} },
      metrics: {
        record() {
          assert.fail('failed run must not record success');
        },
        recordUnavailable(reason) {
          unavailable.push(reason);
        },
      },
    });
    const gate = await task.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 });

    await assert.rejects(
      task.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, { assignedCatId: null }),
      /redis unavailable/,
    );
    assert.deepEqual(unavailable, ['redis unavailable']);
  });
});
