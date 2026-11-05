import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { updateCanonicalInvocationIndex } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-canonical-index.js';
import { compactTranscriptEvent } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-compact-event.js';
import { TRANSCRIPT_INVOCATION_INDEX_SCHEMA } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-index-schema.js';

const session = { id: 'session', threadId: 'thread', catId: 'codex61-sol', seq: 0, status: 'active' };
function event(key, eventNo) {
  return compactTranscriptEvent({
    v: 1,
    t: 1000 + key.charCodeAt(0),
    threadId: session.threadId,
    catId: session.catId,
    sessionId: session.id,
    invocationId: 'inv',
    eventNo,
    event: {
      type: 'text',
      content: `${key}:`.padEnd(4096, 'x'),
      outputMessage: {
        provider: 'private',
        runtimeSessionId: 'private-runtime',
        turnId: 'private-turn',
        nativeId: `output-${key}`,
        channel: 'final',
        complete: true,
      },
    },
  });
}

function fixture(
  run,
  live = [
    [2, event('A', 11)],
    [4, event('B', 21)],
    [8, event('A', 11)],
    [12, event('C', 31)],
    [16, event('A', 99)],
    [20, event('D', 41)],
  ],
) {
  const db = new Database(':memory:');
  try {
    db.exec(TRANSCRIPT_INVOCATION_INDEX_SCHEMA);
    assert.equal(live[0][1].hash, live[2][1].hash);
    assert.equal(live[0][1].hash, live[4][1].hash);
    const insert = db.prepare('INSERT INTO source_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [seq, item] of live)
      insert.run(
        1,
        seq,
        item.projection.eventNo,
        'inv',
        item.hash,
        seq * 5000,
        5000,
        JSON.stringify(item.projection),
        '[]',
      );
    run(db, live);
  } finally {
    db.close();
  }
}

function verify(db, buffered, expected) {
  updateCanonicalInvocationIndex(
    db,
    { session, directory: 'unused', includeLive: true, buffered },
    ['missing', 'live'],
    { sourceBytesScanned: 0, hydratedBytes: 0, summaryCacheHits: 0 },
  );
  const rows = db
    .prepare(`SELECT c.logical_no, c.event_no, c.source, c.seq, c.projection AS payload,
    CASE WHEN c.source=2 THEN (SELECT projection FROM buffer WHERE seq=c.seq)
      ELSE (SELECT projection FROM source_events WHERE source=c.source AND seq=c.seq) END AS full
    FROM canonical c ORDER BY logical_no`)
    .all();
  assert.deepEqual(
    rows,
    expected.map(([source, seq, item], index) => ({
      logical_no: index,
      event_no: index,
      source,
      seq,
      payload: '',
      full: JSON.stringify(item.projection),
    })),
  );
  const summary = JSON.parse(db.prepare('SELECT projection FROM summaries').get().projection);
  assert.equal(summary.eventCount, expected.length);
  assert.equal(summary.messageCount, expected.length);
  return summary;
}

test('live and buffer retain counted same-coordinate duplicates, unmatched rows and sparse anchors', () => {
  fixture((db, live) => {
    const buffered = new Array(14);
    for (const [index, key, eventNo] of [
      [1, 'X', 15],
      [3, 'A', 11],
      [5, 'Y', 25],
      [7, 'A', 11],
      [9, 'Z', 35],
      [11, 'A', 99],
      [13, 'W', 45],
    ])
      buffered[index] = event(key, eventNo);
    const summary = verify(db, buffered, [
      [2, 1, buffered[1]],
      [2, 3, buffered[3]],
      [1, ...live[1]],
      [2, 5, buffered[5]],
      [2, 7, buffered[7]],
      [1, ...live[3]],
      [2, 9, buffered[9]],
      [2, 11, buffered[11]],
      [2, 13, buffered[13]],
      [1, ...live[5]],
    ]);
    assert.equal(summary.firstAssistantOutputEvidence.status, 'available');
    assert.equal(summary.firstAssistantOutputEvidence.identity.nativeId, 'output-X');
    assert.equal(summary.firstAssistantOutputEvidence.content, 'X:'.padEnd(4096, 'x'));
  });
});

test('a shared hash with a different event number does not consume a live occurrence', () => {
  fixture((db, live) => {
    const buffered = new Array(2);
    buffered[1] = event('A', 12);
    assert.equal(buffered[1].hash, live[0][1].hash);
    verify(db, buffered, [...live.map(([seq, item]) => [1, seq, item]), [2, 1, buffered[1]]]);
  });
});

test('an empty buffer retains all live rows and their original projection pointers', () => {
  fixture((db, live) =>
    verify(
      db,
      [],
      live.map(([seq, item]) => [1, seq, item]),
    ),
  );
});

test('a small buffer preserves a long run of identical live coordinates', () => {
  const live = Array.from({ length: 50 }, (_, index) => [index * 2, event('A', 11)]);
  fixture((db) => {
    const buffered = new Array(4);
    buffered[1] = event('A', 11);
    buffered[3] = event('A', 11);
    verify(db, buffered, [
      [2, 1, buffered[1]],
      [2, 3, buffered[3]],
      ...live.slice(2).map(([seq, item]) => [1, seq, item]),
    ]);
  }, live);
});
