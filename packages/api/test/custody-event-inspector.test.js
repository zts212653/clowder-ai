/**
 * F167 PR-2 — the read-only custody event inspector.
 *
 * A cat that is judged by the ball ledger could not read it, so every incident (895 / 971, wake 3674, the hold
 * fence 503) ended as "unknown" after another cat read code and logs across threads. The inspector answers one
 * question from the ledger itself: starting at the first event about this source message, what happened next?
 *
 * Contract (decision: opus55, thread_mo3g2p88okl7u4ai#0001790990544151-001119-f69c378f):
 * - the thread is the caller's own, passed by the route from the authenticated invocation, never a parameter;
 * - the anchor is the first event that references the source message; events from there forward, up to `limit`;
 * - a field whitelist: ids, codes, times; never message bodies, commands or free text;
 * - three explicit "not a plain yes": nothing found (`found:false`), the ledger could not be read
 *   (`status:'unavailable'` with a reason), more events than the limit (`truncated:true`). An empty list never
 *   stands in for any of them.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import {
  buildDispatchDispositionEvent,
  buildHandedEvent,
  buildHeldEvent,
  buildHoldDispositionEvent,
  buildTaskDoneEvent,
  buildWakeConditionMetEvent,
} from '../dist/domains/ball-custody/ball-custody-events.js';
import { CustodyEventInspector } from '../dist/domains/ball-custody/CustodyEventInspector.js';

const THREAD = 'thread-1';
const SUBJECT = `ball:thread:${THREAD}`;
const ALLOWED_EVENT_KEYS = new Set([
  'sequence',
  'kind',
  'at',
  'catId',
  'fromCatId',
  'toCatId',
  'invocationId',
  'sourceMessageId',
  'taskId',
  'disposition',
  'adopted',
  'retired',
  'retiredReason',
  'via',
  'unrecognizedFields',
]);

class MemoryEventLog {
  events = [];
  failReads = false;
  async append(event) {
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { appended: false, sequence: -1 };
    }
    this.events.push(structuredClone(event));
    return { appended: true, sequence: this.events.length - 1 };
  }
  async appendFenced(event, expectedSequence) {
    const own = this.events.filter((candidate) => candidate.subjectKey === event.subjectKey).length;
    if (own !== expectedSequence) return { outcome: 'conflict', actualSequence: own };
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }
  async read(subjectKey, fromSequence = 0) {
    if (this.failReads) throw new Error('ledger unavailable');
    return this.events.filter((event) => event.subjectKey === subjectKey).slice(fromSequence);
  }
  async listSubjects() {
    return [...new Set(this.events.map((event) => event.subjectKey))];
  }
}

class MemoryProjectionStore {
  projections = new Map();
  failReads = false;
  async get(subjectKey) {
    if (this.failReads) throw new Error('projection unavailable');
    return structuredClone(this.projections.get(subjectKey) ?? null);
  }
  async save(projection) {
    this.projections.set(projection.subjectKey, structuredClone(projection));
  }
  async listSubjectKeys() {
    return [...this.projections.keys()];
  }
  async delete(subjectKey) {
    this.projections.delete(subjectKey);
  }
}

function world() {
  const eventLog = new MemoryEventLog();
  const projectionStore = new MemoryProjectionStore();
  const ingest = new BallCustodyIngest(eventLog, new BallCustodyProjector(eventLog, projectionStore));
  const inspector = new CustodyEventInspector({
    ballCustodyEventLog: eventLog,
    ballCustodyProjectionStore: projectionStore,
  });
  return { eventLog, projectionStore, ingest, inspector };
}

describe('F167 custody event inspector', () => {
  test('the 895 / 971 shape: from the handoff, through the coordination terminal that wrote `completed`', async () => {
    const w = world();
    await w.ingest.record(buildHeldEvent({ threadId: THREAD, catId: 'sonnet', fireAt: 99_000, at: 500 }));
    await w.ingest.record(
      buildHandedEvent({
        threadId: THREAD,
        fromCatId: 'sonnet',
        toCatId: 'codex-astra',
        messageId: 'src-895',
        at: 1_000,
      }),
    );
    await w.ingest.record(
      buildDispatchDispositionEvent({
        threadId: THREAD,
        catId: 'codex-astra',
        fromCatId: 'sonnet',
        invocationId: 'inv-1',
        sourceMessageId: 'src-895',
        disposition: 'completed',
        via: 'coordination_terminal',
        at: 2_000,
      }),
    );

    const result = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-895' });

    assert.equal(result.status, 'ok');
    assert.equal(result.found, true);
    assert.equal(result.anchorSequence, 1, 'anchored on the handoff, not on the unrelated earlier hold');
    assert.deepEqual(
      result.events.map((event) => [event.sequence, event.kind]),
      [
        [1, 'ball.handed'],
        [2, 'ball.dispatch_dispositioned'],
      ],
    );
    assert.deepEqual(result.events[0], {
      sequence: 1,
      kind: 'ball.handed',
      at: 1_000,
      fromCatId: 'sonnet',
      toCatId: 'codex-astra',
    });
    assert.deepEqual(result.events[1], {
      sequence: 2,
      kind: 'ball.dispatch_dispositioned',
      at: 2_000,
      catId: 'codex-astra',
      fromCatId: 'sonnet',
      invocationId: 'inv-1',
      sourceMessageId: 'src-895',
      disposition: 'completed',
      via: 'coordination_terminal',
    });
    assert.equal(result.truncated, false);
    assert.equal(result.subjectEventCount, 3);
  });

  test('a managed-hold wake, then what happened to the ball after it (the holder_mismatch question)', async () => {
    const w = world();
    await w.ingest.record(buildHeldEvent({ threadId: THREAD, catId: 'codex-sol', fireAt: 99_000, at: 1_000 }));
    await w.ingest.record(
      buildWakeConditionMetEvent({
        threadId: THREAD,
        catId: 'codex-sol',
        taskId: 'task-1',
        command: 'pnpm gate --secret-looking-flag',
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
        at: 2_000,
      }),
    );
    await w.ingest.record(
      buildHandedEvent({ threadId: THREAD, toCatId: 'codex-sol', messageId: 'wake-message', at: 2_200 }),
    );
    // Resolved at the thread subject, the way the existing managed-hold regression records it.
    await w.ingest.record({ ...buildTaskDoneEvent({ taskId: 'task-1', at: 3_000 }), subjectKey: SUBJECT });
    await w.ingest.record(
      buildHoldDispositionEvent({
        threadId: THREAD,
        catId: 'codex-sol',
        invocationId: 'inv-9',
        sourceMessageId: 'wake-message',
        taskId: 'task-1',
        disposition: 'handled',
        retired: true,
        retiredReason: 'subject_resolved',
        at: 4_000,
      }),
    );

    const result = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'wake-message' });

    assert.equal(result.found, true);
    assert.deepEqual(
      result.events.map((event) => event.kind),
      ['ball.handed', 'task.done', 'ball.hold_dispositioned'],
    );
    const dispositioned = result.events.at(-1);
    assert.equal(dispositioned.retired, true);
    assert.equal(dispositioned.retiredReason, 'subject_resolved');
    assert.equal(dispositioned.taskId, 'task-1');
  });

  test('only whitelisted fields leave: no message body, command or any free text, whatever the payload carries', async () => {
    const w = world();
    await w.ingest.record(
      buildHandedEvent({ threadId: THREAD, fromCatId: 'sonnet', toCatId: 'codex-sol', messageId: 'src-1', at: 1_000 }),
    );
    // Events as an older or richer writer may have produced them: extra payload that must not leak.
    w.eventLog.events.push({
      sourceEventId: 'dispatch-disposition:inv-1:src-1',
      subjectKey: SUBJECT,
      kind: 'ball.dispatch_dispositioned',
      classification: 'state-changing',
      payload: {
        catId: 'codex-sol',
        fromCatId: 'sonnet',
        invocationId: 'inv-1',
        sourceMessageId: 'src-1',
        disposition: 'handled',
        content: 'the full message body',
        command: 'pnpm secret',
        note: 'free text',
        adopted: {
          adoptedSourceMessageId: 'src-1',
          witnessTimestamp: 1,
          readEvidenceKind: 'x',
          liveInvocationId: 'live-1',
        },
      },
      at: 2_000,
    });

    const result = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1' });

    for (const event of result.events) {
      assert.deepEqual(
        Object.keys(event).filter((key) => !ALLOWED_EVENT_KEYS.has(key)),
        [],
        `no key outside the whitelist: ${JSON.stringify(event)}`,
      );
    }
    assert.equal(JSON.stringify(result).includes('the full message body'), false);
    assert.equal(JSON.stringify(result).includes('pnpm secret'), false);
    assert.equal(result.events.at(-1).adopted, true, 'adoption is reported as a fact, not as its detail');
  });

  test('no event about the source is found:false, with no events, and it is not an error', async () => {
    const w = world();
    await w.ingest.record(
      buildHandedEvent({
        threadId: THREAD,
        fromCatId: 'sonnet',
        toCatId: 'codex-sol',
        messageId: 'someone-elses',
        at: 1_000,
      }),
    );

    const result = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-missing' });

    assert.equal(result.status, 'ok');
    assert.equal(result.found, false);
    assert.deepEqual(result.events, []);
    assert.equal(result.truncated, false);
    assert.equal(result.subjectEventCount, 1);
  });

  test('an unreadable ledger is `unavailable` with a reason, never an empty list', async () => {
    const w = world();
    await w.ingest.record(
      buildHandedEvent({ threadId: THREAD, fromCatId: 'sonnet', toCatId: 'codex-sol', messageId: 'src-1', at: 1_000 }),
    );
    w.eventLog.failReads = true;

    const result = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1' });

    assert.deepEqual(result, { status: 'unavailable', reason: 'event_log_read_failed' });
  });

  test('an unreadable projection does not hide the events, and says so instead of inventing a state', async () => {
    const w = world();
    await w.ingest.record(
      buildHandedEvent({ threadId: THREAD, fromCatId: 'sonnet', toCatId: 'codex-sol', messageId: 'src-1', at: 1_000 }),
    );
    w.projectionStore.failReads = true;

    const result = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1' });

    assert.equal(result.status, 'ok');
    assert.equal(result.found, true);
    assert.deepEqual(result.projection, { status: 'unavailable', reason: 'projection_read_failed' });
  });

  test('the projection summary carries state, holder, last state change and the last rejected event', async () => {
    const w = world();
    await w.ingest.record(
      buildHandedEvent({ threadId: THREAD, fromCatId: 'sonnet', toCatId: 'codex-sol', messageId: 'src-1', at: 1_000 }),
    );
    await w.ingest.record(
      buildDispatchDispositionEvent({
        threadId: THREAD,
        catId: 'codex-sol',
        fromCatId: 'sonnet',
        invocationId: 'inv-1',
        sourceMessageId: 'src-1',
        disposition: 'handled',
        via: 'direct',
        at: 2_000,
      }),
    );
    // The projection cache remembers the last event the state machine refused; the inspector only reports it.
    const projection = await w.projectionStore.get(SUBJECT);
    projection.lastRejectedEvent = structuredClone(w.eventLog.events[1]);
    await w.projectionStore.save(projection);

    const result = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1' });

    assert.equal(result.projection.status, 'ok');
    assert.equal(result.projection.state, projection.state);
    assert.equal(result.projection.holderCatId, projection.holder);
    assert.equal(result.projection.lastStateChangeAt, projection.lastStateChangeAt);
    assert.deepEqual(result.projection.lastRejectedEvent, {
      kind: 'ball.dispatch_dispositioned',
      sequence: 1,
      at: 2_000,
    });
  });

  test('a projection that has refused nothing reports null, not a made-up event', async () => {
    const w = world();
    await w.ingest.record(
      buildHandedEvent({ threadId: THREAD, fromCatId: 'sonnet', toCatId: 'codex-sol', messageId: 'src-1', at: 1_000 }),
    );
    const result = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1' });
    assert.equal(result.projection.lastRejectedEvent, null);
  });

  test('a missing projection is its own state, not an `ok` with made-up values', async () => {
    const w = world();
    w.eventLog.events.push(
      buildHandedEvent({ threadId: THREAD, fromCatId: 'sonnet', toCatId: 'codex-sol', messageId: 'src-1', at: 1_000 }),
    );

    const result = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1' });

    assert.deepEqual(result.projection, { status: 'not_found' });
  });

  test('truncation is explicit: exactly `limit` events is complete, one more is truncated', async () => {
    const w = world();
    await w.ingest.record(
      buildHandedEvent({ threadId: THREAD, fromCatId: 'sonnet', toCatId: 'codex-sol', messageId: 'src-1', at: 1_000 }),
    );
    const later = (index) => ({
      sourceEventId: `after-${index}`,
      subjectKey: SUBJECT,
      kind: 'ball.wake_sent',
      classification: 'observability',
      payload: {},
      at: 2_000 + index,
    });
    for (let index = 0; index < 19; index += 1) await w.eventLog.append(later(index));

    // The anchor plus 19 more is exactly the default limit of 20: complete.
    const exact = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1' });
    assert.equal(exact.events.length, 20, 'the default limit is 20');
    assert.equal(exact.truncated, false);

    await w.eventLog.append(later(19));
    const byDefault = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1' });
    assert.equal(byDefault.events.length, 20);
    assert.equal(byDefault.truncated, true);

    for (let index = 20; index < 59; index += 1) await w.eventLog.append(later(index));
    const capped = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1', limit: 50 });
    assert.equal(capped.events.length, 50);
    assert.equal(capped.truncated, true);
    assert.equal(capped.events.at(-1).sequence, 49);
  });

  test('a limit outside 1..50 is refused rather than clamped', async () => {
    const w = world();
    for (const limit of [0, -1, 51, 1.5, Number.NaN]) {
      await assert.rejects(
        () => w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1', limit }),
        RangeError,
        String(limit),
      );
    }
  });

  test("only the caller's own thread is ever read", async () => {
    const w = world();
    await w.ingest.record(
      buildHandedEvent({
        threadId: 'thread-other',
        fromCatId: 'sonnet',
        toCatId: 'codex-sol',
        messageId: 'src-1',
        at: 1_000,
      }),
    );
    const reads = [];
    const read = w.eventLog.read.bind(w.eventLog);
    w.eventLog.read = async (subjectKey, from) => {
      reads.push(subjectKey);
      return read(subjectKey, from);
    };

    const result = await w.inspector.inspect({ threadId: THREAD, sourceMessageId: 'src-1' });

    assert.equal(result.found, false, 'the same source id in another thread is not visible');
    assert.deepEqual(reads, [SUBJECT]);
  });
});
