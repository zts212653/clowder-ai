/**
 * F167 — the completion terminal for a matched event-wait wake.
 *
 * #4987 made `matched` a continuation the woken holder still owes, but gave it no way to say "I did what this
 * wake asked and nothing is left": hold wakes have `complete_managed_hold`, A2A dispatches have
 * `complete_a2a_dispatch`, and an event-wait wake had only re-hold / hand off / re-arm. A holder who had really
 * finished could not satisfy the stop gate legitimately (codex-astra, thread_murp5dprs67x8fu6#...-000066).
 *
 * The producer is invocation-bound like its siblings: the caller picks only `handled | completed`; the wake, the
 * carrier and the holder are derived server-side from the persisted wake message and the custody ledger.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { buildHandedEvent, buildHeldEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  EventWaitDispositionError,
  EventWaitDispositionService,
} from '../dist/domains/ball-custody/EventWaitDispositionService.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { realWaitWake } from './helpers/event-wait-terminal-fixture.js';
import { MemoryEventLog, MemoryProjectionStore } from './helpers/memory-ball-custody.js';

const THREAD = 'thread-wait';
const SUBJECT = `ball:thread:${THREAD}`;
const HOLDER = 'codex-astra';
const WAKE_MESSAGE = 'wake-message-1';

const carrierFor = (reason = 'matched', subjectRef) =>
  realWaitWake(reason, { holderCatId: HOLDER, subjectKey: SUBJECT, ...(subjectRef ? { subjectRef } : {}) })
    .waitContinuationCarrier;

function wakeMessage(carrier, overrides = {}) {
  return {
    id: WAKE_MESSAGE,
    threadId: THREAD,
    source: { connector: 'deployment-wait', meta: { waitContinuationCarrier: carrier } },
    ...overrides,
  };
}

async function world({ carrier = carrierFor(), message, handed = true, latest = true } = {}) {
  const eventLog = new MemoryEventLog();
  const projectionStore = new MemoryProjectionStore();
  const ingest = new BallCustodyIngest(eventLog, new BallCustodyProjector(eventLog, projectionStore));
  if (handed) {
    await ingest.record(buildHandedEvent({ threadId: THREAD, toCatId: HOLDER, messageId: WAKE_MESSAGE, at: 1_000 }));
  }
  const messages = new Map([[WAKE_MESSAGE, message ?? wakeMessage(carrier)]]);
  const warnings = [];
  const service = new EventWaitDispositionService({
    registry: { isLatest: async () => latest },
    messageStore: { getById: async (id) => messages.get(id) ?? null },
    ballCustodyEventLog: eventLog,
    ballCustodyProjectionStore: projectionStore,
    ballCustody: ingest,
    repairProjection: (subjectKey) => ingest.rebuild(subjectKey),
    now: () => 5_000,
    log: { warn: (fields, text) => warnings.push({ fields, text }) },
  });
  return { eventLog, projectionStore, ingest, service, messages, warnings, carrier };
}

const auth = (overrides = {}) => ({
  invocationId: 'inv-1',
  userId: 'user-1',
  catId: HOLDER,
  threadId: THREAD,
  originTriggerMessageId: WAKE_MESSAGE,
  ...overrides,
});

const rejects = async (promise, code) =>
  assert.rejects(promise, (error) => error instanceof EventWaitDispositionError && error.code === code, code);

describe('F167 event-wait completion terminal', () => {
  test('the woken holder completes the wake: one exact terminal, the thread ball resolves', async () => {
    const w = await world();

    const result = await w.service.complete(auth(), 'completed');

    assert.deepEqual(result, {
      outcome: 'applied',
      disposition: 'completed',
      invocationId: 'inv-1',
      sourceMessageId: WAKE_MESSAGE,
      waitId: w.carrier.waitId,
      outcomeId: w.carrier.outcomeId,
      retired: false,
    });
    const terminal = w.eventLog.events.filter((event) => event.kind === 'ball.wait_dispositioned');
    assert.equal(terminal.length, 1);
    assert.equal(
      terminal[0].sourceEventId,
      `wait-disposition:${HOLDER}:${w.carrier.waitId}:${w.carrier.outcomeId}`,
      'the identity is (cat, wait, outcome)',
    );
    assert.deepEqual(terminal[0].payload, {
      catId: HOLDER,
      invocationId: 'inv-1',
      sourceMessageId: WAKE_MESSAGE,
      waitId: w.carrier.waitId,
      outcomeId: w.carrier.outcomeId,
      disposition: 'completed',
    });
    assert.equal((await w.projectionStore.get(SUBJECT)).state, 'resolved');
  });

  test('event-wait completion settles its lifecycle without a separate Stop gate', async () => {
    const w = await world();
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: w.projectionStore,
      ballCustodyEventLog: w.eventLog,
    });
    const wake = {
      kind: 'structured',
      protocol: 'event_wait',
      subjectKey: SUBJECT,
      holderCatId: HOLDER,
      waitContinuationCarrier: w.carrier,
    };
    const opened = await gate.open(wake);
    assert.equal(opened.state, 'covered_empty');
    assert.equal((await gate.close(opened)).shouldBlock, false);

    await w.service.complete(auth(), 'handled');

    const decision = await gate.close(opened);
    assert.equal(decision.shouldBlock, false);
    assert.equal(decision.structuredTransitionKind, undefined);
    assert.equal(w.eventLog.events.filter((event) => event.kind === 'ball.wait_dispositioned').length, 1);
  });

  test('replaying the same completion is idempotent: no second terminal', async () => {
    const w = await world();
    await w.service.complete(auth(), 'completed');

    const again = await w.service.complete(auth(), 'completed');

    assert.equal(again.outcome, 'replayed');
    assert.equal(again.disposition, 'completed');
    assert.equal(w.eventLog.events.filter((event) => event.kind === 'ball.wait_dispositioned').length, 1);
  });

  test('a conflicting value inside one invocation fails closed; a successor invocation gets the recorded terminal', async () => {
    const w = await world();
    await w.service.complete(auth(), 'completed');

    await rejects(w.service.complete(auth(), 'handled'), 'event_wait_disposition_replay_mismatch');

    const successor = await w.service.complete(auth({ invocationId: 'inv-2' }), 'handled');
    assert.equal(successor.outcome, 'replayed');
    assert.equal(successor.disposition, 'completed', 'the recorded terminal stays authoritative');
    assert.equal(w.eventLog.events.filter((event) => event.kind === 'ball.wait_dispositioned').length, 1);
  });

  test("refuses what is not this invocation's own matched event-wait wake", async () => {
    const stale = await world({ latest: false });
    await rejects(stale.service.complete(auth(), 'completed'), 'event_wait_disposition_stale_invocation');

    const w = await world();
    await rejects(
      w.service.complete(auth({ originTriggerMessageId: undefined }), 'completed'),
      'event_wait_disposition_no_wake',
    );
    await rejects(
      w.service.complete(auth({ originTriggerMessageId: 'unknown-message' }), 'completed'),
      'event_wait_disposition_wake_missing',
    );
    w.messages.set(WAKE_MESSAGE, wakeMessage(w.carrier, { source: { connector: 'github-review', meta: {} } }));
    await rejects(w.service.complete(auth(), 'completed'), 'event_wait_disposition_not_event_wait');
    w.messages.set(WAKE_MESSAGE, wakeMessage(w.carrier, { source: undefined }));
    await rejects(w.service.complete(auth(), 'completed'), 'event_wait_disposition_not_event_wait');
    w.messages.set(WAKE_MESSAGE, wakeMessage(w.carrier, { source: { connector: 'deployment-wait', meta: {} } }));
    await rejects(w.service.complete(auth(), 'completed'), 'event_wait_disposition_carrier_invalid');
    w.messages.set(WAKE_MESSAGE, wakeMessage(w.carrier, { threadId: 'another-thread' }));
    await rejects(w.service.complete(auth(), 'completed'), 'event_wait_disposition_thread_mismatch');

    assert.equal(w.eventLog.events.filter((event) => event.kind === 'ball.wait_dispositioned').length, 0);
  });

  test('a wake that never handed the ball to this cat cannot be completed by it', async () => {
    const noHandoff = await world({ handed: false });
    await rejects(noHandoff.service.complete(auth(), 'completed'), 'event_wait_disposition_handoff_missing');

    const w = await world();
    await rejects(
      w.service.complete(auth({ catId: 'someone-else' }), 'completed'),
      'event_wait_disposition_handoff_missing',
    );
  });

  test('a self-settling wake owes nothing and an unreadable outcome fails closed: neither gets a terminal', async () => {
    for (const reason of ['subject_terminal', 'expired']) {
      const w = await world({ carrier: carrierFor(reason) });
      await rejects(w.service.complete(auth(), 'completed'), 'event_wait_disposition_nothing_owed');
    }
    const garbled = await world({ carrier: { ...carrierFor(), outcomeId: 'garbage' } });
    await rejects(garbled.service.complete(auth(), 'completed'), 'event_wait_disposition_outcome_unrecognized');
  });

  test('when the holder no longer owns the ball the terminal is retired: it closes this obligation and leaves the ball alone', async () => {
    const w = await world();
    await w.ingest.record(
      buildHandedEvent({ threadId: THREAD, toCatId: 'opus55', messageId: 'later-handoff', at: 2_000 }),
    );

    const result = await w.service.complete(auth(), 'completed');

    assert.equal(result.retired, true);
    assert.equal(result.retiredReason, 'ball_not_held');
    const projection = await w.projectionStore.get(SUBJECT);
    assert.equal(projection.holder, 'opus55', 'the other holder keeps the ball');
    assert.equal(projection.state, 'active');
    const terminal = w.eventLog.events.find((event) => event.kind === 'ball.wait_dispositioned');
    assert.equal(terminal.payload.retired, true);
    assert.equal(terminal.payload.retiredReason, 'ball_not_held');
  });

  test('a thread ball that already resolved retires the terminal as subject_resolved', async () => {
    const w = await world();
    await w.ingest.record({
      kind: 'task.done',
      sourceEventId: 'task:t1:done',
      subjectKey: SUBJECT,
      classification: 'state-changing',
      payload: { taskId: 't1' },
      at: 2_000,
    });

    const result = await w.service.complete(auth(), 'handled');

    assert.equal(result.retired, true);
    assert.equal(result.retiredReason, 'subject_resolved');
  });

  test('a concurrent heartbeat does not fail the call: one fresh authority check, then the terminal lands', async () => {
    const w = await world();
    w.eventLog.racers.push({
      kind: 'invocation.heartbeat',
      sourceEventId: 'inv:inv-1:hb:1',
      subjectKey: SUBJECT,
      classification: 'informational',
      payload: { catId: HOLDER, invocationId: 'inv-1' },
      at: 4_000,
    });

    const result = await w.service.complete(auth(), 'completed');

    assert.equal(result.outcome, 'applied');
    assert.equal(w.eventLog.events.filter((event) => event.kind === 'ball.wait_dispositioned').length, 1);
  });

  test('a transient failure that surfaces after another call wrote the terminal does not make this call answer applied', async () => {
    // Two same-value calls from one invocation take the same pre-append snapshot. The first appends. The second's
    // append attempt dies transiently before reaching the log; its recovery then finds the FIRST call's terminal.
    // Nothing here proves the second call wrote anything, so it must not claim `applied` (#5049 round 2, P2).
    const w = await world();
    const readEvents = w.eventLog.read.bind(w.eventLog);
    let snapshots = 0;
    let release;
    const bothHaveSnapshot = new Promise((resolve) => {
      release = resolve;
    });
    w.eventLog.read = async (...args) => {
      const captured = await readEvents(...args);
      if (snapshots < 2 && !captured.some((event) => event.kind === 'ball.wait_dispositioned')) {
        snapshots += 1;
        if (snapshots === 2) release();
        await bothHaveSnapshot;
      }
      return captured;
    };
    const record = w.ingest.recordFenced.bind(w.ingest);
    let attempts = 0;
    let firstWritten;
    const firstDone = new Promise((resolve) => {
      firstWritten = resolve;
    });
    w.ingest.recordFenced = async (event, expectedSequence) => {
      attempts += 1;
      if (attempts === 1) {
        try {
          return await record(event, expectedSequence);
        } finally {
          firstWritten();
        }
      }
      await firstDone;
      throw new Error('transient recordFenced failure');
    };

    const results = await Promise.all([
      w.service.complete(auth(), 'completed'),
      w.service.complete(auth(), 'completed'),
    ]);

    assert.equal(w.eventLog.events.filter((event) => event.kind === 'ball.wait_dispositioned').length, 1);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['applied', 'replayed']);
    assert.ok(results.every((result) => result.disposition === 'completed'));
  });

  test('anything but a heartbeat intervening is a real conflict and is not papered over', async () => {
    const w = await world();
    w.eventLog.racers.push({
      kind: 'ball.handed',
      sourceEventId: 'route:racer:opus55',
      subjectKey: SUBJECT,
      classification: 'state-changing',
      payload: { fromCatId: 'x', toCatId: 'opus55' },
      at: 4_000,
    });

    await rejects(w.service.complete(auth(), 'completed'), 'event_wait_disposition_fence_conflict');
    assert.equal(w.eventLog.events.filter((event) => event.kind === 'ball.wait_dispositioned').length, 0);
  });

  test("only this thread's ledger is read or written", async () => {
    const w = await world();
    await w.ingest.record(buildHeldEvent({ threadId: 'thread-other', catId: HOLDER, fireAt: 9_000, at: 1_500 }));

    await w.service.complete(auth(), 'completed');

    const subjects = new Set(
      w.eventLog.events.filter((e) => e.kind === 'ball.wait_dispositioned').map((e) => e.subjectKey),
    );
    assert.deepEqual([...subjects], [SUBJECT]);
  });
});
