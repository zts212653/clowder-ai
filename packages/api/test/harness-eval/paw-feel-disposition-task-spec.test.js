import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PawFeelBlockerReconciler } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/blocker-reconciler.js';
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
      blockerReconciler: {
        async reconcile() {
          calls.push('blockers');
          return {
            scanCalls: 1,
            cycleComplete: false,
            counts: { scanned: 2, stable: 1, reopened: 1, conflicted: 0, deferred: 0, failed: 0 },
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

    assert.deepEqual(calls, ['blockers', 'run']);
    assert.equal(metrics.length, 1);
    assert.equal(logs.length, 2);
    const encoded = JSON.stringify(logs);
    assert.doesNotMatch(encoded, /爪感差|marker|symptom/i);
    assert.match(encoded, /scannedMessages/);
    assert.match(encoded, /reopened/);
    assert.equal(task.run.overlap, 'skip');
    assert.equal(task.state.runLedger, 'sqlite');
  });

  it('records unavailable and rethrows so scheduler truth is RUN_FAILED', async () => {
    const unavailable = [];
    let blockerRuns = 0;
    const task = createPawFeelReconciliationTaskSpec({
      reconciler: {
        async run() {
          throw new Error('redis unavailable');
        },
      },
      blockerReconciler: {
        async reconcile() {
          blockerRuns += 1;
          return {
            scanCalls: 1,
            cycleComplete: true,
            counts: { scanned: 0, stable: 0, reopened: 0, conflicted: 0, deferred: 0, failed: 0 },
          };
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
    assert.equal(blockerRuns, 1, 'bounded blocker polling must not be skipped by coverage failure');
  });

  it('fails the scheduler run and retries the same bounded blocker page after one signal throws', async () => {
    const scanCursors = [];
    const attempts = new Map();
    const unavailable = [];
    let coverageRuns = 0;
    let reopenEffects = 0;
    let reopened = false;
    const blockerReconciler = new PawFeelBlockerReconciler({
      service: {
        async scanSignalIds(cursor) {
          scanCursors.push(cursor);
          return {
            signalIds: ['signal-transient-failure', 'signal-reopens-once'],
            scanCalls: 1,
            nextCursor: { redisCursor: '1', pendingSignalIds: [], completeAfterPending: false },
          };
        },
        async reconcileBlocker(signalId) {
          const attempt = (attempts.get(signalId) ?? 0) + 1;
          attempts.set(signalId, attempt);
          if (signalId === 'signal-transient-failure' && attempt === 1) {
            throw new Error('transient blocker failure');
          }
          if (signalId === 'signal-reopens-once') {
            if (reopened) return 'stable';
            reopened = true;
            reopenEffects += 1;
            return 'reopened';
          }
          return 'stable';
        },
      },
    });
    const task = createPawFeelReconciliationTaskSpec({
      reconciler: {
        async run() {
          coverageRuns += 1;
          return {
            mode: 'overlap',
            startedAt: '2026-09-09T00:00:00.000Z',
            completedAt: '2026-09-09T00:00:01.000Z',
            durationMs: 1_000,
            scannedMessages: 0,
            canonicalSignals: 0,
            discoveredSignals: 0,
            duplicateSignals: 0,
            lagMs: 0,
          };
        },
      },
      blockerReconciler,
      log: { info() {}, warn() {} },
      metrics: {
        record() {},
        recordUnavailable(reason) {
          unavailable.push(reason);
        },
      },
    });
    const gate = await task.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 });
    const work = gate.workItems[0];

    await assert.rejects(
      task.run.execute(work.signal, work.subjectKey, { assignedCatId: null }),
      /transient blocker failure/,
    );
    await task.run.execute(work.signal, work.subjectKey, { assignedCatId: null });

    assert.deepEqual(scanCursors, [undefined, undefined], 'a failed page must not advance the process cursor');
    assert.equal(attempts.get('signal-transient-failure'), 2);
    assert.equal(attempts.get('signal-reopens-once'), 2, 'the whole bounded page is replayed');
    assert.equal(reopenEffects, 1, 'page replay must not duplicate an already-applied reopen');
    assert.equal(coverageRuns, 2, 'coverage reconciliation still runs on the failed blocker tick');
    assert.deepEqual(unavailable, ['transient blocker failure']);
  });
});
