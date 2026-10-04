/**
 * F167 — a projection rebuild is ordered against the writers of the same subject.
 *
 * `projector.rebuild` is delete + replay: it reads the log once and applies that snapshot event by event.
 * Run beside a writer it can finish last with a snapshot older than the writer's event and overwrite the
 * writer's projection with a stale holder. `BallCustodyIngest.rebuild` takes its place on the same
 * per-subject chain as `record` / `recordFenced`, so a rebuild reads the log only after every earlier writer
 * applied, and a later writer waits for it. These tests pin that ordering with an observable operation log.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { buildHeldEvent } from '../dist/domains/ball-custody/ball-custody-events.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** An event log and a projection store that record every operation, with optional gates to hold one open. */
function stack() {
  const ops = [];
  const events = [];
  const rows = new Map();
  const gates = { append: undefined, read: undefined };
  const eventLog = {
    async append(event) {
      ops.push(`append:${event.sourceEventId}`);
      await gates.append?.promise;
      events.push(event);
      return { appended: true, sequence: events.length - 1 };
    },
    async appendFenced() {
      throw new Error('not used');
    },
    async read(subjectKey) {
      ops.push(`read:${subjectKey}`);
      const snapshot = events.filter((event) => event.subjectKey === subjectKey);
      await gates.read?.promise;
      return snapshot;
    },
    async listSubjects() {
      return [...new Set(events.map((event) => event.subjectKey))];
    },
  };
  const store = {
    async get(key) {
      return rows.has(key) ? structuredClone(rows.get(key)) : null;
    },
    async save(projection) {
      ops.push(`save:${projection.subjectKey}:${projection.holder}`);
      rows.set(projection.subjectKey, structuredClone(projection));
    },
    async delete(key) {
      ops.push(`delete:${key}`);
      rows.delete(key);
    },
    async listSubjectKeys() {
      return [...rows.keys()];
    },
  };
  const ingest = new BallCustodyIngest(eventLog, new BallCustodyProjector(eventLog, store));
  return { ingest, ops, gates, store, eventLog };
}

const held = (threadId, catId, at) => buildHeldEvent({ threadId, catId, fireAt: at + 100_000, at });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('F167 BallCustodyIngest.rebuild is ordered against record', () => {
  test('a rebuild queued behind an in-flight record reads the log only after that record applied', async () => {
    const { ingest, ops, gates } = stack();
    gates.append = deferred();
    const record = ingest.record(held('t1', 'cat-a', 1_000));
    const rebuild = ingest.rebuild('ball:thread:t1');
    await settle();

    assert.deepEqual(ops, [`append:${held('t1', 'cat-a', 1_000).sourceEventId}`], 'the rebuild has not started yet');

    gates.append.resolve();
    await Promise.all([record, rebuild]);

    const readAt = ops.findIndex((op) => op.startsWith('read:'));
    const saveAt = ops.findIndex((op) => op.startsWith('save:'));
    assert.ok(saveAt !== -1 && readAt > saveAt, `the record applied before the rebuild read: ${ops.join(' | ')}`);
  });

  test('a record issued while a rebuild is replaying waits until the rebuild finished', async () => {
    const { ingest, ops, gates } = stack();
    await ingest.record(held('t1', 'cat-a', 1_000));
    ops.length = 0;
    gates.read = deferred();
    const rebuild = ingest.rebuild('ball:thread:t1');
    await settle();
    const successor = ingest.record(held('t1', 'cat-b', 2_000));
    await settle();

    assert.ok(!ops.some((op) => op.startsWith('append:')), `the writer waits for the rebuild: ${ops.join(' | ')}`);

    gates.read.resolve();
    await Promise.all([rebuild, successor]);

    const lastSave = [...ops].reverse().find((op) => op.startsWith('save:'));
    assert.equal(lastSave, 'save:ball:thread:t1:cat-b', 'the successor is applied last, on top of the rebuilt state');
  });

  test('a rebuild of one subject never blocks another subject', async () => {
    const { ingest, ops, gates } = stack();
    await ingest.record(held('t1', 'cat-a', 1_000));
    ops.length = 0;
    gates.read = deferred();
    const rebuild = ingest.rebuild('ball:thread:t1');
    await settle();

    await ingest.record(held('t2', 'cat-b', 2_000));

    assert.ok(
      ops.some((op) => op === 'save:ball:thread:t2:cat-b'),
      'the other subject was written meanwhile',
    );
    gates.read.resolve();
    await rebuild;
  });

  test('a failing rebuild does not break the chain for the next writer', async () => {
    const { ingest, eventLog } = stack();
    await ingest.record(held('t1', 'cat-a', 1_000));
    const read = eventLog.read.bind(eventLog);
    eventLog.read = async () => {
      eventLog.read = read;
      throw new Error('log unavailable');
    };

    await assert.rejects(ingest.rebuild('ball:thread:t1'), /log unavailable/);
    await ingest.record(held('t1', 'cat-b', 2_000));
  });
});

describe('F167 production repair wiring goes through the ingest', () => {
  // A bare `projector.rebuild` is not on the ingest chain. These are the two services that repair a
  // projection; if either is wired back to the projector the overwrite window returns silently, and no
  // behavioural test of the service can see the production wiring, so this reads it.
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  test('every repairProjection in index.ts is the ingest rebuild, and none is the projector rebuild', () => {
    const wirings = [...index.matchAll(/repairProjection:\s*\(subjectKey: string\)\s*=>\s*([^\n]+)/g)].map((m) => m[1]);
    assert.ok(
      wirings.length >= 2,
      `expected the managed-hold and A2A dispatch services to be wired: ${wirings.length}`,
    );
    for (const wiring of wirings) {
      assert.match(
        wiring,
        /ballCustodyIngest!?\.rebuild\(subjectKey\)/,
        `repair must go through the ingest: ${wiring}`,
      );
    }
    assert.doesNotMatch(index, /ballCustodyProjector!?\.rebuild\(/);
  });
});
