import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { createHostSleepEvidenceReader, findSleepInterruption, isInFullWakeSince } = await import(
  '../dist/domains/cats/services/agents/invocation/host-sleep/HostSleepEvidence.js'
);
const { HostSleepContinuationScheduler, recoverSleepContinuations } = await import(
  '../dist/domains/cats/services/agents/invocation/host-sleep/HostSleepContinuationScheduler.js'
);
const { parseMacSleepEvidence } = await import('../runtime/process-observation/mac-power-evidence.mjs');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { continueInterruptedCats, RESTART_CONTINUATION_CONNECTOR, SLEEP_CONTINUATION_CONTENT } = await import(
  '../dist/domains/cats/services/agents/invocation/restart-continuation/RestartContinuation.js'
);

// Real ASL power events from 2026-11-13 (PST): lid closed 04:40:12, dark wake 04:55:13,
// asleep again 04:56:43, lid opened 05:10:41. kimi31-pro's turn ran 04:40:06 → 04:55:26.
const SLEEP = '1794573612\t644645000\tSleep\tB05802D7-C5F6-4398-8E6D-887CE199B4E3';
const DARK_WAKE = '1794574513\t239442000\tDarkWake\tB05802D7-C5F6-4398-8E6D-887CE199B4E3';
const SLEEP_AGAIN = '1794574603\t726945000\tSleep\tB05802D7-C5F6-4398-8E6D-887CE199B4E3';
const FULL_WAKE = '1794575441\t673966000\tWake\tB05802D7-C5F6-4398-8E6D-887CE199B4E3';
const KIMI_STARTED_AT = 1794573606015;
const KIMI_FAILED_AT = 1794574526225;
const evidenceOf = (...lines) => parseMacSleepEvidence(lines.join('\n'));
const at = (seconds, nanos) => seconds * 1000 + nanos / 1_000_000;
const SLEPT_AT = at(1794573612, 644645000);
const DARK_WOKE_AT = at(1794574513, 239442000);

describe('F337 findSleepInterruption', () => {
  test('the 11-13 kimi turn was cut by the lid-close sleep', () => {
    const hit = findSleepInterruption(evidenceOf(SLEEP, DARK_WAKE), {
      turnStartedAt: KIMI_STARTED_AT,
      failedAt: KIMI_FAILED_AT,
    });
    assert.deepEqual(hit, { sleptAt: SLEPT_AT, wokeAt: DARK_WOKE_AT });
  });

  test('a sleep that began before the turn started is not this turn’s interruption', () => {
    assert.equal(
      findSleepInterruption(evidenceOf(SLEEP, DARK_WAKE), { turnStartedAt: 1794573700000, failedAt: KIMI_FAILED_AT }),
      null,
    );
  });

  test('a failure long after the wake is not attributed to the sleep', () => {
    const failedAt = 1794574513239 + 11 * 60_000;
    assert.equal(
      findSleepInterruption(evidenceOf(SLEEP, DARK_WAKE), { turnStartedAt: KIMI_STARTED_AT, failedAt }),
      null,
    );
  });

  test('a Sleep whose Wake is not yet published counts, ending at the failure', () => {
    assert.deepEqual(
      findSleepInterruption(evidenceOf(SLEEP), { turnStartedAt: KIMI_STARTED_AT, failedAt: KIMI_FAILED_AT }),
      { sleptAt: SLEPT_AT, wokeAt: KIMI_FAILED_AT },
    );
  });

  test('unreadable evidence never claims a sleep', () => {
    assert.equal(
      findSleepInterruption(
        { status: 'unavailable', reason: 'power log unavailable' },
        { turnStartedAt: KIMI_STARTED_AT, failedAt: KIMI_FAILED_AT },
      ),
      null,
    );
  });
});

describe('F337 isInFullWakeSince', () => {
  const since = 1794573612644;
  test('a dark wake is not the lid opening', () => {
    assert.equal(isInFullWakeSince(evidenceOf(SLEEP, DARK_WAKE), since), false);
  });
  test('asleep again after the dark wake is not awake', () => {
    assert.equal(isInFullWakeSince(evidenceOf(SLEEP, DARK_WAKE, SLEEP_AGAIN), since), false);
  });
  test('the lid opening after the sleep is a full wake', () => {
    assert.equal(isInFullWakeSince(evidenceOf(SLEEP, DARK_WAKE, SLEEP_AGAIN, FULL_WAKE), since), true);
  });
  test('a dark wake that turns into a full wake without sleeping again counts', () => {
    const wakeOnly = '1794574600\t000000000\tWake\tB05802D7-C5F6-4398-8E6D-887CE199B4E3';
    assert.equal(isInFullWakeSince(evidenceOf(SLEEP, DARK_WAKE, wakeOnly), since), true);
  });
  test('unreadable evidence is unknown, not awake', () => {
    assert.equal(isInFullWakeSince({ status: 'unavailable', reason: 'x' }, since), null);
  });
});

describe('F337 createHostSleepEvidenceReader', () => {
  test('only macOS has a power log', async () => {
    const read = createHostSleepEvidenceReader({ platform: 'linux' });
    assert.equal((await read({ from: 1, to: 2 })).status, 'unavailable');
  });

  test('reads the day files around the window asynchronously and parses them', async () => {
    const calls = [];
    const read = createHostSleepEvidenceReader({
      platform: 'darwin',
      exists: (file) => file.endsWith('2026.11.13.asl'),
      run: async (file, args) => {
        calls.push([file, args]);
        return `${SLEEP}\n${DARK_WAKE}\n`;
      },
    });
    const evidence = await read({ from: KIMI_STARTED_AT, to: KIMI_FAILED_AT });
    assert.equal(evidence.status, 'available');
    assert.equal(evidence.confirmedSleep.length, 1);
    assert.equal(calls[0][0], '/usr/bin/syslog');
    assert.deepEqual(calls[0][1].slice(0, 2), ['-f', '/var/log/powermanagement/2026.11.13.asl']);
  });

  test('a failed read is unavailable, never an empty available', async () => {
    const read = createHostSleepEvidenceReader({
      platform: 'darwin',
      exists: () => true,
      run: async () => {
        throw new Error('boom');
      },
    });
    const evidence = await read({ from: KIMI_STARTED_AT, to: KIMI_FAILED_AT });
    assert.equal(evidence.status, 'unavailable');
  });
});

/** A continuation receipt in the shape continueInterruptedCats returns. */
function receipt({ delivered = [], skipped = [], failed = [], unreadable = [] } = {}) {
  const ref = (id) => ({ threadId: 'thread-a', catId: 'kimi31-pro', interruptedInvocationId: id });
  return {
    delivered: delivered.map((id) => ({ ...ref(id), messageId: `msg-${id}` })),
    skipped: skipped.map((id) => ({ ...ref(id), reason: 'superseded' })),
    failed: failed.map((id) => ({ ...ref(id), error: 'busy' })),
    coalesced: [],
    missing: [],
    unreadable: unreadable.map((id) => ({ interruptedInvocationId: id, error: 'read failed' })),
  };
}

describe('F337 HostSleepContinuationScheduler', () => {
  function harness(evidenceSequence, continueCats) {
    let now = KIMI_FAILED_AT;
    const timers = [];
    const delivered = [];
    const scheduler = new HostSleepContinuationScheduler({
      readEvidence: async () => (evidenceSequence.length > 1 ? evidenceSequence.shift() : evidenceSequence[0]),
      continueCats:
        continueCats ??
        (async (ids) => {
          delivered.push([...ids]);
          return receipt({ delivered: ids });
        }),
      log: { info() {}, warn() {} },
      now: () => now,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return { unref() {} };
      },
      pollMs: 60_000,
    });
    return {
      scheduler,
      delivered,
      timers,
      advance: async (ms) => {
        now += ms;
        const timer = timers.shift();
        if (timer) await timer.fn();
      },
    };
  }

  test('waits through the dark wake and delivers once after the lid opens', async () => {
    const h = harness([
      evidenceOf(SLEEP, DARK_WAKE),
      evidenceOf(SLEEP, DARK_WAKE, SLEEP_AGAIN),
      evidenceOf(SLEEP, DARK_WAKE, SLEEP_AGAIN, FULL_WAKE),
    ]);
    h.scheduler.schedule({ invocationId: 'inv-kimi', sleptAt: 1794573612644 });
    h.scheduler.schedule({ invocationId: 'inv-kimi', sleptAt: 1794573612644 });
    await h.advance(60_000);
    await h.advance(60_000);
    assert.deepEqual(h.delivered, []);
    await h.advance(60_000);
    assert.deepEqual(h.delivered, [['inv-kimi']]);
    assert.equal(h.timers.length, 0, 'nothing left to wait for');
  });

  // Review R2 (codex61-sol, PR #7038): no owner opted into expiring the promise.
  test('an overnight sleep still continues in the morning', async () => {
    const h = harness([evidenceOf(SLEEP, DARK_WAKE)]);
    h.scheduler.schedule({ invocationId: 'inv-kimi', sleptAt: 1794573612644 });
    await h.advance(7 * 3_600_000);
    assert.deepEqual(h.delivered, []);
    assert.equal(h.timers.length, 1, 'still waiting for the lid');
    const wokeLate = evidenceOf(SLEEP, DARK_WAKE, SLEEP_AGAIN, FULL_WAKE);
    const late = harness([wokeLate]);
    late.scheduler.schedule({ invocationId: 'inv-kimi', sleptAt: 1794573612644 });
    await late.advance(7 * 3_600_000);
    assert.deepEqual(late.delivered, [['inv-kimi']]);
  });

  test('a delivery that failed is retried later instead of being dropped', async () => {
    const attempts = [];
    const h = harness([evidenceOf(SLEEP, DARK_WAKE, SLEEP_AGAIN, FULL_WAKE)], async (ids) => {
      attempts.push([...ids]);
      return attempts.length === 1 ? receipt({ failed: ['inv-kimi'] }) : receipt({ delivered: ['inv-kimi'] });
    });
    h.scheduler.schedule({ invocationId: 'inv-kimi', sleptAt: 1794573612644 });
    await h.advance(60_000);
    assert.equal(attempts.length, 1);
    await h.advance(60_000);
    assert.equal(attempts.length, 1, 'backs off before the retry');
    await h.advance(120_000);
    assert.equal(attempts.length, 2);
    assert.equal(h.timers.length, 0);
  });
});

function continuationHome(turns) {
  const sent = [];
  return {
    sent,
    deps: {
      turns,
      messages: { getById: async () => null },
      queue: { listPendingAcrossUsers: () => [], findProcessingByCat: () => null },
      deliver: async (opts) => {
        sent.push(opts);
        return `msg-${sent.length}`;
      },
      log: { warn() {} },
    },
  };
}

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
  await store.markResponseSettled(invocationId, {
    kind: 'no_response',
    reason: 'empty_turn',
    settledAt: startedAt + 1_000,
  });
}

describe('F337 continueInterruptedCats(host_sleep)', () => {
  test('delivers the sleep wording under the shared continuation connector', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-kimi', 'kimi31-pro', 'failed', KIMI_STARTED_AT, 'host_sleep');
    const home = continuationHome(turns);
    const result = await continueInterruptedCats(home.deps, ['inv-kimi'], 'host_sleep');
    assert.equal(result.delivered.length, 1);
    assert.equal(home.sent[0].content, SLEEP_CONTINUATION_CONTENT);
    assert.equal(home.sent[0].idempotencyKey, 'sleep-continuation:inv-kimi');
    assert.equal(home.sent[0].source.connector, RESTART_CONTINUATION_CONNECTOR);
    assert.equal(home.sent[0].source.label, '睡眠接续');
  });

  // Review R1 (codex61-sol, PR #7038): the owner's later stop wins over an older automatic wake.
  test('a newer stop, finished turn or running turn of that cat in the thread supersedes the wake', async () => {
    for (const [status, reason] of [
      ['canceled', 'user_cancel'],
      ['succeeded', undefined],
    ]) {
      const turns = new InMemoryTurnExecutionStore();
      await endTurn(turns, 'inv-kimi', 'kimi31-pro', 'failed', KIMI_STARTED_AT, 'host_sleep');
      await endTurn(turns, 'inv-newer', 'kimi31-pro', status, KIMI_STARTED_AT + 60_000, reason);
      const home = continuationHome(turns);
      const result = await continueInterruptedCats(home.deps, ['inv-kimi'], 'host_sleep');
      assert.deepEqual(home.sent, [], `${status} must win`);
      assert.equal(result.skipped[0].reason, 'superseded');
    }
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-kimi', 'kimi31-pro', 'failed', KIMI_STARTED_AT, 'host_sleep');
    await turns.createRunning({
      invocationId: 'inv-running',
      parentInvocationId: 'p-running',
      threadId: 'thread-a',
      userId: 'user-a',
      catId: 'kimi31-pro',
      executionKind: 'ordinary',
      startedAt: KIMI_STARTED_AT + 60_000,
    });
    const home = continuationHome(turns);
    assert.equal(
      (await continueInterruptedCats(home.deps, ['inv-kimi'], 'host_sleep')).skipped[0].reason,
      'superseded',
    );
  });

  // Review R1-round2 (codex61-sol, PR #7038): a later stop stays authoritative however busy the thread is.
  test('a later cancellation wins even behind 201 settlements of another cat in the same thread', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-kimi', 'kimi31-pro', 'failed', KIMI_STARTED_AT, 'host_sleep');
    await endTurn(turns, 'inv-cancel', 'kimi31-pro', 'canceled', KIMI_STARTED_AT + 60_000, 'user_cancel');
    for (let index = 0; index < 201; index += 1) {
      await endTurn(turns, `opus-${index}`, 'opus', 'succeeded', KIMI_STARTED_AT + 120_000 + index * 2_000);
    }
    const home = continuationHome(turns);
    const result = await continueInterruptedCats(home.deps, ['inv-kimi'], 'host_sleep');
    assert.deepEqual(home.sent, []);
    assert.equal(result.skipped[0].reason, 'superseded');
  });

  test('another cat working in the thread does not cancel this cat’s continuation', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-kimi', 'kimi31-pro', 'failed', KIMI_STARTED_AT, 'host_sleep');
    await endTurn(turns, 'inv-other', 'codex61-sol', 'canceled', KIMI_STARTED_AT + 60_000, 'user_cancel');
    const home = continuationHome(turns);
    assert.equal((await continueInterruptedCats(home.deps, ['inv-kimi'], 'host_sleep')).delivered.length, 1);
  });
});

describe('F337 recoverSleepContinuations', () => {
  test('re-registers the owed host_sleep failures after a restart', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-kimi', 'kimi31-pro', 'failed', KIMI_STARTED_AT, 'host_sleep');
    await endTurn(turns, 'inv-repeat', 'opus', 'failed', KIMI_STARTED_AT, 'host_sleep_repeat');
    await endTurn(turns, 'inv-plain', 'codex61-sol', 'failed', KIMI_STARTED_AT, 'provider_execution_failed');
    const scheduled = [];
    const summary = await recoverSleepContinuations({
      turns,
      scheduler: { schedule: (input) => scheduled.push(input) },
      log: { info() {} },
    });
    assert.deepEqual(scheduled, [{ invocationId: 'inv-kimi', sleptAt: KIMI_STARTED_AT }]);
    assert.deepEqual(summary, { owed: 1, scheduled: 1, cleared: 0 });
  });

  // Review R2-round2 (codex61-sol, PR #7038): history size cannot hide an owed continuation.
  test('an owed continuation behind 201 later settlements elsewhere is still recovered', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-kimi', 'kimi31-pro', 'failed', KIMI_STARTED_AT, 'host_sleep');
    for (let index = 0; index < 201; index += 1) {
      await turns.createRunning({
        invocationId: `b-${index}`,
        parentInvocationId: `pb-${index}`,
        threadId: 'thread-b',
        userId: 'user-a',
        catId: 'codex61-sol',
        executionKind: 'ordinary',
        startedAt: KIMI_STARTED_AT + 10_000 + index,
      });
      await turns.transitionTerminal(`b-${index}`, { status: 'succeeded', endedAt: KIMI_STARTED_AT + 20_000 + index });
      await turns.markResponseSettled(`b-${index}`, {
        kind: 'no_response',
        reason: 'empty_turn',
        settledAt: KIMI_STARTED_AT + 20_000 + index,
      });
    }
    const scheduled = [];
    await recoverSleepContinuations({
      turns,
      scheduler: { schedule: (input) => scheduled.push(input) },
      log: { info() {} },
    });
    assert.deepEqual(
      scheduled.map((entry) => entry.invocationId),
      ['inv-kimi'],
    );
  });

  test('an owed entry whose member already ran again is cleared instead of scheduled', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-kimi', 'kimi31-pro', 'failed', KIMI_STARTED_AT, 'host_sleep');
    await endTurn(turns, 'inv-newer', 'kimi31-pro', 'succeeded', KIMI_STARTED_AT + 60_000);
    const scheduled = [];
    const summary = await recoverSleepContinuations({
      turns,
      scheduler: { schedule: (input) => scheduled.push(input) },
      log: { info() {} },
    });
    assert.deepEqual(scheduled, []);
    assert.deepEqual(summary, { owed: 1, scheduled: 0, cleared: 1 });
    assert.deepEqual(await turns.listOwedSleepContinuations(), []);
  });
});

describe('F337 HostSleepContinuationScheduler owed ledger', () => {
  test('a delivered continuation is cleared from the owed record; a failed one stays owed', async () => {
    let now = KIMI_FAILED_AT;
    const timers = [];
    const settled = [];
    const scheduler = new HostSleepContinuationScheduler({
      readEvidence: async () => evidenceOf(SLEEP, DARK_WAKE, SLEEP_AGAIN, FULL_WAKE),
      continueCats: async () => receipt({ delivered: ['inv-ok'], failed: ['inv-failed'] }),
      settleOwed: (ids) => settled.push([...ids]),
      log: { info() {}, warn() {} },
      now: () => now,
      setTimer: (fn) => {
        timers.push(fn);
        return {};
      },
    });
    scheduler.schedule({ invocationId: 'inv-ok', sleptAt: 1794573612644 });
    scheduler.schedule({ invocationId: 'inv-failed', sleptAt: 1794573612644 });
    now += 60_000;
    await timers.shift()();
    assert.deepEqual(settled, [['inv-ok']]);
  });
});

// Review R2-round3 (codex61-sol, PR #7038): an undecided id is never settled as done.
describe('F337 sleep continuation stays owed until a definite outcome', () => {
  test('a record that cannot be read once stays owed, then is delivered exactly once', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-kimi', 'kimi31-pro', 'failed', KIMI_STARTED_AT, 'host_sleep');
    let reads = 0;
    const flaky = {
      get: async (id) => {
        reads += 1;
        if (reads === 1) throw new Error('redis read failed');
        return turns.get(id);
      },
      hasMemberTurnStartedAfter: (query) => turns.hasMemberTurnStartedAfter(query),
    };
    const home = continuationHome(flaky);
    let now = KIMI_FAILED_AT;
    const timers = [];
    const scheduler = new HostSleepContinuationScheduler({
      readEvidence: async () => evidenceOf(SLEEP, DARK_WAKE, SLEEP_AGAIN, FULL_WAKE),
      continueCats: (ids) => continueInterruptedCats(home.deps, ids, 'host_sleep'),
      settleOwed: (ids) => turns.settleOwedSleepContinuations(ids),
      log: { info() {}, warn() {} },
      now: () => now,
      setTimer: (fn) => {
        timers.push(fn);
        return {};
      },
      pollMs: 60_000,
    });
    scheduler.schedule({ invocationId: 'inv-kimi', sleptAt: KIMI_STARTED_AT });

    now += 60_000;
    await timers.shift()();
    assert.equal(home.sent.length, 0);
    assert.deepEqual(
      (await turns.listOwedSleepContinuations()).map((record) => record.invocationId),
      ['inv-kimi'],
      'still owed after the failed read',
    );
    assert.equal(timers.length, 1, 'a retry is armed');

    now += 3 * 60_000;
    await timers.shift()();
    await timers.shift()?.();
    assert.equal(home.sent.length, 1);
    assert.deepEqual(await turns.listOwedSleepContinuations(), []);
  });

  test('an unexpected receipt shape concludes nothing', async () => {
    let now = KIMI_FAILED_AT;
    const timers = [];
    const settled = [];
    const scheduler = new HostSleepContinuationScheduler({
      readEvidence: async () => evidenceOf(SLEEP, DARK_WAKE, SLEEP_AGAIN, FULL_WAKE),
      continueCats: async () => undefined,
      settleOwed: (ids) => settled.push([...ids]),
      log: { info() {}, warn() {} },
      now: () => now,
      setTimer: (fn) => {
        timers.push(fn);
        return {};
      },
    });
    scheduler.schedule({ invocationId: 'inv-kimi', sleptAt: 1794573612644 });
    now += 60_000;
    await timers.shift()();
    assert.deepEqual(settled, []);
    assert.equal(timers.length, 1);
  });
});

describe('F337 continuation receipt accounts for every id', () => {
  test('older cut-off turns of the same member, missing and unreadable records are each reported', async () => {
    const turns = new InMemoryTurnExecutionStore();
    await endTurn(turns, 'inv-old', 'kimi31-pro', 'failed', KIMI_STARTED_AT, 'host_sleep');
    await endTurn(turns, 'inv-new', 'kimi31-pro', 'failed', KIMI_STARTED_AT + 1, 'host_sleep');
    const home = continuationHome({
      get: async (id) => {
        if (id === 'inv-broken') throw new Error('redis read failed');
        return turns.get(id);
      },
      hasMemberTurnStartedAfter: (query) => turns.hasMemberTurnStartedAfter(query),
    });
    const result = await continueInterruptedCats(
      home.deps,
      ['inv-old', 'inv-new', 'inv-gone', 'inv-broken'],
      'host_sleep',
    );
    assert.deepEqual(
      result.delivered.map((entry) => entry.interruptedInvocationId),
      ['inv-new'],
    );
    assert.deepEqual(result.coalesced, ['inv-old']);
    assert.deepEqual(result.missing, ['inv-gone']);
    assert.deepEqual(
      result.unreadable.map((entry) => entry.interruptedInvocationId),
      ['inv-broken'],
    );
  });
});
