/**
 * F167 — the write reports what the projection did with the event it just applied.
 *
 * The projection keeps a marker of its last rejection, but any later accepted event (a heartbeat, a
 * successor) overwrites it, and it is read outside the write chain. So whether the state machine accepted an
 * exact event can only be reported by the write operation itself: the projector returns it from `apply`,
 * the ingest carries it out of `recordFenced`, and the managed-hold recording helper hands it to the service.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { buildHeldEvent, buildHoldDispositionEvent } from '../dist/domains/ball-custody/ball-custody-events.js';

function stack() {
  const events = [];
  const rows = new Map();
  const eventLog = {
    async append(event) {
      if (events.some((e) => e.sourceEventId === event.sourceEventId)) return { appended: false, sequence: -1 };
      events.push(event);
      return { appended: true, sequence: events.length - 1 };
    },
    async appendFenced(event, expectedSequence) {
      if (events.some((e) => e.sourceEventId === event.sourceEventId)) return { outcome: 'duplicate' };
      const actual = events.filter((e) => e.subjectKey === event.subjectKey).length;
      if (actual !== expectedSequence) return { outcome: 'conflict', actualSequence: actual };
      events.push(event);
      return { outcome: 'appended', sequence: expectedSequence };
    },
    async read(subjectKey) {
      return events.filter((e) => e.subjectKey === subjectKey);
    },
    async listSubjects() {
      return [...new Set(events.map((e) => e.subjectKey))];
    },
  };
  const store = {
    failNextSave: false,
    async get(key) {
      return rows.has(key) ? structuredClone(rows.get(key)) : null;
    },
    async save(projection) {
      if (this.failNextSave) {
        this.failNextSave = false;
        throw new Error('projection save failed');
      }
      rows.set(projection.subjectKey, structuredClone(projection));
    },
    async delete(key) {
      rows.delete(key);
    },
    async listSubjectKeys() {
      return [...rows.keys()];
    },
  };
  const projector = new BallCustodyProjector(eventLog, store);
  return { eventLog, store, projector, ingest: new BallCustodyIngest(eventLog, projector) };
}

const SUBJECT = 'ball:thread:t1';
const held = (catId, at) => buildHeldEvent({ threadId: 't1', catId, fireAt: at + 100_000, at });
const terminal = (catId, at) =>
  buildHoldDispositionEvent({
    threadId: 't1',
    catId,
    invocationId: `inv-${catId}`,
    sourceMessageId: 'message-1',
    taskId: 'task-1',
    disposition: 'completed',
    at,
  });

describe('F167 the projector reports whether it accepted the event', () => {
  test('accepted when the state machine takes it, rejected when it does not', async () => {
    const { projector, ingest } = stack();
    await ingest.record(held('cat-a', 1_000));

    // A non-retired terminal is only accepted from the holder.
    assert.deepEqual(await projector.apply(terminal('cat-b', 2_000)), { accepted: false });
    assert.deepEqual(await projector.apply(terminal('cat-a', 2_001)), { accepted: true });
  });
});

describe('F167 recordFenced carries the projection outcome out of the write', () => {
  test('appended: accepted or rejected, decided by the state the cache holds when the event is applied', async () => {
    const { ingest, eventLog } = stack();
    await ingest.record(held('cat-a', 1_000));

    const rejected = await ingest.recordFenced(terminal('cat-b', 2_000), (await eventLog.read(SUBJECT)).length);
    assert.equal(rejected.outcome, 'appended');
    assert.equal(rejected.projection, 'rejected');

    const accepted = await ingest.recordFenced(terminal('cat-a', 2_100), (await eventLog.read(SUBJECT)).length);
    assert.equal(accepted.outcome, 'appended');
    assert.equal(accepted.projection, 'accepted');
  });

  test('a later accepted event does not change what the earlier write reported', async () => {
    const { ingest, eventLog, store } = stack();
    await ingest.record(held('cat-a', 1_000));
    const rejected = await ingest.recordFenced(terminal('cat-b', 2_000), (await eventLog.read(SUBJECT)).length);
    assert.equal((await store.get(SUBJECT)).lastRejectedEvent?.kind, 'ball.hold_dispositioned');

    await ingest.record(held('cat-a', 3_000)); // an accepted event clears the marker
    assert.equal((await store.get(SUBJECT)).lastRejectedEvent, null, 'the marker is gone');

    assert.equal(rejected.projection, 'rejected', 'the write result is what survives');
  });

  test('a duplicate or a fence conflict reports no projection outcome', async () => {
    const { ingest, eventLog } = stack();
    await ingest.record(held('cat-a', 1_000));
    const first = terminal('cat-a', 2_000);
    await ingest.recordFenced(first, (await eventLog.read(SUBJECT)).length);

    const duplicate = await ingest.recordFenced(first, 99);
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal('projection' in duplicate, false);
    const conflict = await ingest.recordFenced(terminal('cat-z', 3_000), 0);
    assert.equal(conflict.outcome, 'conflict');
    assert.equal('projection' in conflict, false);
  });
});
