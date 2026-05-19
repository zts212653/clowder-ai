/**
 * F194 Phase Z3 — Producer state-machine hardening (defensive try/finally).
 *
 * Helper `ensureTerminalStatus(parentId, deps)` is called from the background async
 * finally block in routes/messages.ts. It:
 *   - Reads current record status via CAS-safe path
 *   - Skips if already terminal (succeeded/failed/canceled)
 *   - Reads chainDone signal from RouteChainCompletionTracker (in-memory map)
 *   - chainDone=succeeded → CAS update status=succeeded
 *   - chainDone=failed → CAS update status=failed(error='producer_chain_failed')
 *   - chainDone missing/pending (no signal) → fallback failed(error='producer_left_running_no_terminal')
 *     + warn log（砚砚 R1 P1-3: read-side 不擅自 succeeded，必须 chainDone 证据）
 *   - CAS expectedStatus=running 守护避免覆盖任何已 terminal 的 record
 *   - 加 trace log 每个 transition: from→to/source
 *
 * Tests cover the 5 paths AC-Z3 specifies.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ensureTerminalStatus,
  RouteChainCompletionTracker,
} from '../dist/domains/cats/services/agents/invocation/ensureTerminalStatus.js';

function makeRecordStore({ initialStatus = 'running', allowTransition = true } = {}) {
  let current = { id: 'parent-1', status: initialStatus, threadId: 't1', userId: 'u1' };
  const updates = [];
  return {
    updates,
    get: async () => ({ ...current }),
    update: async (id, input) => {
      if (id !== 'parent-1') return null;
      // Simulate CAS expectedStatus
      if (input.expectedStatus && current.status !== input.expectedStatus) return null;
      if (!allowTransition) return null;
      const before = current.status;
      const after = { ...current, ...input };
      delete after.expectedStatus;
      current = after;
      updates.push({ id, input, from: before, to: current.status });
      return { ...current };
    },
  };
}

function makeRecordingLog() {
  const records = { info: [], warn: [] };
  return {
    records,
    info: (...args) => records.info.push(args),
    warn: (...args) => records.warn.push(args),
  };
}

describe('F194 Phase Z3 — ensureTerminalStatus producer try/finally helper', () => {
  it('chainDone=succeeded + record running → CAS update status=succeeded, source=chainDone_succeeded', async () => {
    const store = makeRecordStore();
    const tracker = new RouteChainCompletionTracker();
    tracker.succeed('parent-1');
    const log = makeRecordingLog();

    const result = await ensureTerminalStatus(
      'parent-1',
      { invocationRecordStore: store, chainCompletion: tracker, log },
      { reqId: 'req-1' },
    );

    assert.equal(result.written, true);
    assert.equal(result.finalStatus, 'succeeded');
    assert.equal(result.source, 'chainDone_succeeded');
    assert.equal(store.updates.length, 1);
    assert.equal(store.updates[0].input.status, 'succeeded');
    assert.equal(store.updates[0].input.expectedStatus, 'running', 'must use CAS expectedStatus guard');
    // Trace log
    const traceLog = log.records.info.find((args) => args[1]?.includes?.('terminal write'));
    assert.ok(traceLog, 'must emit trace log on terminal write');
  });

  it('chainDone=failed + record running → CAS update status=failed(error=producer_chain_failed)', async () => {
    const store = makeRecordStore();
    const tracker = new RouteChainCompletionTracker();
    tracker.fail('parent-1');
    const log = makeRecordingLog();

    const result = await ensureTerminalStatus(
      'parent-1',
      { invocationRecordStore: store, chainCompletion: tracker, log },
      {},
    );

    assert.equal(result.written, true);
    assert.equal(result.finalStatus, 'failed');
    assert.equal(result.source, 'chainDone_failed');
    assert.equal(store.updates[0].input.error, 'producer_chain_failed');
  });

  it('chainDone missing (no signal) + record running → fallback failed(error=producer_left_running_no_terminal) + warn log', async () => {
    const store = makeRecordStore();
    const tracker = new RouteChainCompletionTracker(); // no start/succeed/fail call
    const log = makeRecordingLog();

    const result = await ensureTerminalStatus(
      'parent-1',
      { invocationRecordStore: store, chainCompletion: tracker, log },
      { reqId: 'req-fallback' },
    );

    assert.equal(result.written, true);
    assert.equal(result.finalStatus, 'failed');
    assert.equal(result.source, 'fallback_no_signal');
    assert.equal(store.updates[0].input.error, 'producer_left_running_no_terminal');
    // Warn log
    const warnLog = log.records.warn.find((args) => args[1]?.includes?.('fallback'));
    assert.ok(warnLog, 'must emit warn log on fallback path so monitors can flag');
  });

  it('chainDone=pending (start but not done/fail) + record running → fallback failed(producer_left_running_no_terminal)', async () => {
    // 'pending' means routeExecution started but never reached done/error — same as missing for terminal decision.
    const store = makeRecordStore();
    const tracker = new RouteChainCompletionTracker();
    tracker.start('parent-1');
    const log = makeRecordingLog();

    const result = await ensureTerminalStatus(
      'parent-1',
      { invocationRecordStore: store, chainCompletion: tracker, log },
      {},
    );

    assert.equal(result.source, 'fallback_no_signal');
    assert.equal(store.updates[0].input.status, 'failed');
    assert.equal(store.updates[0].input.error, 'producer_left_running_no_terminal');
  });

  it('record already terminal (succeeded) → no write, source=already_terminal', async () => {
    const store = makeRecordStore({ initialStatus: 'succeeded' });
    const tracker = new RouteChainCompletionTracker();
    tracker.succeed('parent-1');
    const log = makeRecordingLog();

    const result = await ensureTerminalStatus(
      'parent-1',
      { invocationRecordStore: store, chainCompletion: tracker, log },
      {},
    );

    assert.equal(result.written, false, 'must not double-write');
    assert.equal(result.finalStatus, 'succeeded');
    assert.equal(result.source, 'already_terminal');
    assert.equal(store.updates.length, 0);
  });

  it('record already terminal (failed) → no write, no overwrite even if chainDone says succeeded', async () => {
    // CAS expectedStatus=running guards against overwriting a real failure with succeeded.
    const store = makeRecordStore({ initialStatus: 'failed' });
    const tracker = new RouteChainCompletionTracker();
    tracker.succeed('parent-1');
    const log = makeRecordingLog();

    const result = await ensureTerminalStatus(
      'parent-1',
      { invocationRecordStore: store, chainCompletion: tracker, log },
      {},
    );

    assert.equal(result.written, false);
    assert.equal(result.finalStatus, 'failed', 'pre-existing failed must not be overwritten by succeeded');
    assert.equal(store.updates.length, 0);
  });

  it('record missing (e.g., deleted) → no write, source=already_terminal (treated as "nothing to terminalize")', async () => {
    const store = {
      get: async () => null,
      update: async () => null,
    };
    const tracker = new RouteChainCompletionTracker();
    tracker.succeed('parent-gone');
    const log = makeRecordingLog();

    const result = await ensureTerminalStatus(
      'parent-gone',
      { invocationRecordStore: store, chainCompletion: tracker, log },
      {},
    );

    assert.equal(result.written, false);
    assert.equal(result.finalStatus, 'missing');
  });

  it('CAS race: status flipped to terminal between get() and update() → reports final state, no error', async () => {
    // Simulates concurrent terminal write (e.g., abort path wrote canceled).
    const store = makeRecordStore({ initialStatus: 'running', allowTransition: false }); // update returns null (CAS rejected)
    const tracker = new RouteChainCompletionTracker();
    tracker.succeed('parent-1');
    const log = makeRecordingLog();

    const result = await ensureTerminalStatus(
      'parent-1',
      { invocationRecordStore: store, chainCompletion: tracker, log },
      {},
    );

    assert.equal(result.written, false, 'CAS rejected → no write reported');
    assert.equal(store.updates.length, 0);
  });
});

describe('F194 Phase Z3 — RouteChainCompletionTracker in-memory map', () => {
  it('start → has()=pending', () => {
    const t = new RouteChainCompletionTracker();
    t.start('p1');
    assert.equal(t.has('p1'), 'pending');
  });

  it('succeed → has()=succeeded', () => {
    const t = new RouteChainCompletionTracker();
    t.start('p1');
    t.succeed('p1');
    assert.equal(t.has('p1'), 'succeeded');
  });

  it('fail → has()=failed', () => {
    const t = new RouteChainCompletionTracker();
    t.start('p1');
    t.fail('p1');
    assert.equal(t.has('p1'), 'failed');
  });

  it('release → has()=undefined (memory cleanup)', () => {
    const t = new RouteChainCompletionTracker();
    t.succeed('p1');
    t.release('p1');
    assert.equal(t.has('p1'), undefined);
  });
});
