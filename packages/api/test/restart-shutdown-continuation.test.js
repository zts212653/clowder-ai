import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { HostSleepContinuationScheduler, recoverOwedContinuations } = await import(
  '../dist/domains/cats/services/agents/invocation/host-sleep/HostSleepContinuationScheduler.js'
);
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { continueInterruptedCats, RESTART_CONTINUATION_CONTENT } = await import(
  '../dist/domains/cats/services/agents/invocation/restart-continuation/RestartContinuation.js'
);
const { describeStopReason } = await import('../dist/domains/cats/services/agents/invocation/stop-reason-wording.js');
const { parseMacSleepEvidence } = await import('../runtime/process-observation/mac-power-evidence.mjs');

// F337: a turn the runtime's own stop cut off is owed like a sleep and continued after the next boot.
const STARTED_AT = 1794733400000;
const SLEEP = '1794573612\t644645000\tSleep\tB05802D7-C5F6-4398-8E6D-887CE199B4E3';
const DARK_WAKE = '1794574513\t239442000\tDarkWake\tB05802D7-C5F6-4398-8E6D-887CE199B4E3';
const FULL_WAKE = '1794575441\t673966000\tWake\tB05802D7-C5F6-4398-8E6D-887CE199B4E3';

async function endTurn(store, invocationId, catId, status, startedAt, terminalReason) {
  await store.createRunning({
    invocationId,
    parentInvocationId: `p-${invocationId}`,
    threadId: 'thread-a',
    userId: 'user-a',
    catId,
    executionKind: 'ordinary',
    startedAt,
  });
  await store.transitionTerminal(invocationId, {
    status,
    endedAt: startedAt + 1_000,
    ...(terminalReason ? { terminalReason } : {}),
  });
}

function schedulerHarness({ readEvidence, continueCats, settleOwed }) {
  let now = STARTED_AT + 60_000;
  const timers = [];
  const scheduler = new HostSleepContinuationScheduler({
    readEvidence,
    continueCats,
    ...(settleOwed ? { settleOwed } : {}),
    log: { info() {}, warn() {} },
    now: () => now,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return {};
    },
    pollMs: 60_000,
  });
  return {
    scheduler,
    timers,
    advance: async (ms) => {
      now += ms;
      const timer = timers.shift();
      if (timer) await timer.fn();
    },
  };
}

const receipt = (ids) => ({
  delivered: ids.map((id) => ({
    threadId: 'thread-a',
    catId: 'kimi31-pro',
    interruptedInvocationId: id,
    messageId: `m-${id}`,
  })),
  skipped: [],
  failed: [],
  coalesced: [],
  missing: [],
  unreadable: [],
});

describe('F337 owed ledger records restart cuts', () => {
  test('a restart cut is owed; a repeated one and a plain failure are not', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-cut', 'kimi31-pro', 'failed', STARTED_AT, 'restart_shutdown');
    await endTurn(turns, 'inv-repeat', 'opus', 'failed', STARTED_AT, 'restart_shutdown_repeat');
    await endTurn(turns, 'inv-plain', 'codex61-sol', 'failed', STARTED_AT, 'provider_execution_failed');
    assert.deepEqual(
      (await turns.listOwedContinuations()).map((record) => record.invocationId),
      ['inv-cut'],
    );
  });
});

describe('F337 recoverOwedContinuations restart cuts', () => {
  test('a restart cut is recovered as a restart continuation, a sleep as a sleep one', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-cut', 'kimi31-pro', 'failed', STARTED_AT, 'restart_shutdown');
    await endTurn(turns, 'inv-slept', 'opus', 'failed', STARTED_AT, 'host_sleep');
    const scheduled = [];
    const summary = await recoverOwedContinuations({
      turns,
      scheduler: { schedule: (input) => scheduled.push(input) },
      log: { info() {} },
    });
    assert.deepEqual(
      scheduled.sort((a, b) => a.invocationId.localeCompare(b.invocationId)),
      [
        { invocationId: 'inv-cut', kind: 'process_restart' },
        { invocationId: 'inv-slept', sleptAt: STARTED_AT },
      ],
    );
    assert.deepEqual(summary, { owed: 2, scheduled: 2, cleared: 0 });
  });

  test('with a sleep one also owed, the restart one is still checked right away', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-slept', 'opus', 'failed', STARTED_AT, 'host_sleep');
    await endTurn(turns, 'inv-cut', 'kimi31-pro', 'failed', STARTED_AT + 1, 'restart_shutdown');
    const delays = [];
    const scheduler = new HostSleepContinuationScheduler({
      readEvidence: async () => ({ status: 'unavailable', reason: 'unused' }),
      continueCats: async (ids) => receipt(ids),
      log: { info() {}, warn() {} },
      setTimer: (_fn, ms) => {
        delays.push(ms);
        return {};
      },
      pollMs: 60_000,
    });
    await recoverOwedContinuations({ turns, scheduler, log: { info() {} } });
    assert.deepEqual(delays, [0]);
  });
});

describe('F337 scheduler restart continuations', () => {
  test('checked right away, delivered as a restart continuation, without reading the power log', async () => {
    let reads = 0;
    const calls = [];
    const h = schedulerHarness({
      readEvidence: async () => {
        reads += 1;
        return { status: 'unavailable', reason: 'unused' };
      },
      continueCats: async (ids, kind) => {
        calls.push([[...ids], kind]);
        return receipt(ids);
      },
    });
    h.scheduler.schedule({ invocationId: 'inv-cut', kind: 'process_restart' });
    assert.equal(h.timers[0].ms, 0, 'no poll interval to wait out after the restart');
    await h.advance(0);
    assert.deepEqual(calls, [[['inv-cut'], 'process_restart']]);
    assert.equal(reads, 0);
    assert.equal(h.timers.length, 0, 'nothing left to wait for');
  });

  test('a sleep still waiting for the lid, or an unreadable power log, does not hold a restart one back', async () => {
    const calls = [];
    let reads = 0;
    const h = schedulerHarness({
      readEvidence: async () => {
        reads += 1;
        if (reads === 1) return parseMacSleepEvidence([SLEEP, DARK_WAKE].join('\n'));
        throw new Error('syslog failed');
      },
      continueCats: async (ids, kind) => {
        calls.push([[...ids], kind]);
        return receipt(ids);
      },
    });
    h.scheduler.schedule({ invocationId: 'inv-slept', sleptAt: 1794573612644 });
    h.scheduler.schedule({ invocationId: 'inv-cut', kind: 'process_restart' });
    await h.advance(60_000);
    assert.deepEqual(calls, [[['inv-cut'], 'process_restart']], 'dark wake: only the restart one goes');
    h.scheduler.schedule({ invocationId: 'inv-cut-2', kind: 'process_restart' });
    await h.advance(60_000);
    assert.deepEqual(calls[1], [['inv-cut-2'], 'process_restart'], 'unreadable power log: the restart one still goes');
    assert.equal(h.timers.length, 1, 'the sleep one keeps waiting');
  });

  // Review R1 P2 (codex61-sol, PR #7102): the power log can take seconds; restart ones must not wait on it.
  test('a restart continuation goes out while the power log is still being read for a sleep one', async () => {
    let releasePower;
    const power = new Promise((resolve) => {
      releasePower = resolve;
    });
    const calls = [];
    const h = schedulerHarness({
      readEvidence: () => power,
      continueCats: async (ids, kind) => {
        calls.push([[...ids], kind]);
        return receipt(ids);
      },
    });
    h.scheduler.schedule({ invocationId: 'inv-cut', kind: 'process_restart' });
    h.scheduler.schedule({ invocationId: 'inv-slept', sleptAt: 1794573612644 });
    const tick = h.advance(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [[['inv-cut'], 'process_restart']], 'delivered before the power log answered');
    releasePower({ status: 'unavailable', reason: 'power log timed out' });
    await tick;
    assert.equal(calls.length, 1, 'the sleep one keeps waiting');
  });

  test('a restart registered while a check is reading the power log does not make a sleep one go twice', async () => {
    let releasePower;
    const power = new Promise((resolve) => {
      releasePower = resolve;
    });
    const calls = [];
    const h = schedulerHarness({
      readEvidence: () => power,
      continueCats: async (ids, kind) => {
        calls.push([[...ids], kind]);
        return receipt(ids);
      },
    });
    h.scheduler.schedule({ invocationId: 'inv-slept', sleptAt: 1794573612644 });
    const first = h.advance(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    h.scheduler.schedule({ invocationId: 'inv-cut', kind: 'process_restart' });
    const second = h.advance(0);
    await new Promise((resolve) => setImmediate(resolve));
    releasePower(parseMacSleepEvidence([SLEEP, DARK_WAKE, FULL_WAKE].join('\n')));
    await Promise.all([first, second]);
    assert.deepEqual(calls.map(([ids, kind]) => `${kind}:${ids.join(',')}`).sort(), [
      'host_sleep:inv-slept',
      'process_restart:inv-cut',
    ]);
  });

  test('end to end: the next boot recovers the cut turn, recalls the cat once, and clears what it owed', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-cut', 'kimi31-pro', 'failed', STARTED_AT, 'restart_shutdown');
    const sent = [];
    const home = {
      turns,
      messages: { getById: async () => null },
      queue: { listPendingAcrossUsers: () => [], findProcessingByCat: () => null },
      deliver: async (opts) => {
        sent.push(opts);
        return `msg-${sent.length}`;
      },
      log: { warn() {} },
    };
    const h = schedulerHarness({
      readEvidence: async () => ({ status: 'unavailable', reason: 'unused' }),
      continueCats: (ids, kind) => continueInterruptedCats(home, ids, kind),
      settleOwed: (ids) => turns.settleOwedContinuations(ids),
    });
    await recoverOwedContinuations({ turns, scheduler: h.scheduler, log: { info() {} } });
    await h.advance(60_000);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].targetCatId, 'kimi31-pro');
    assert.equal(sent[0].content, RESTART_CONTINUATION_CONTENT);
    assert.equal(sent[0].idempotencyKey, 'restart-continuation:inv-cut');
    assert.equal(sent[0].source.label, '重启接续');
    assert.deepEqual(await turns.listOwedContinuations(), []);
  });
});

describe('F337 restart cut wording', () => {
  test('the terminal reason and the response reason read the same, and the repeat promises nothing', () => {
    assert.equal(describeStopReason('failed', 'restart_shutdown'), 'runtime 重启打断，重启后会自动接着做');
    assert.equal(describeStopReason('failed', 'RESTART_SHUTDOWN'), 'runtime 重启打断，重启后会自动接着做');
    assert.match(describeStopReason('failed', 'restart_shutdown_repeat'), /这次不再自动叫回/);
    assert.match(describeStopReason('failed', 'RESTART_SHUTDOWN_REPEAT'), /这次不再自动叫回/);
  });
});
