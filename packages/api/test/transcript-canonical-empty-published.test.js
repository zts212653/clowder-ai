import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { updateCanonicalInvocationIndex } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-canonical-index.js';
import { compactTranscriptEvent } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-compact-event.js';
import { TRANSCRIPT_INVOCATION_INDEX_SCHEMA } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-index-schema.js';

const session = { id: 'session', threadId: 'thread', catId: 'codex61-sol', seq: 0, status: 'active' };
const compact = (id, eventNo) =>
  compactTranscriptEvent({
    v: 1,
    t: 1000 + id,
    threadId: session.threadId,
    catId: session.catId,
    sessionId: session.id,
    invocationId: 'inv',
    eventNo,
    event: {
      type: 'text',
      content: `${id}:`.padEnd(4096, 'x'),
      outputMessage: {
        provider: 'private',
        runtimeSessionId: 'private-runtime',
        turnId: 'private-turn',
        nativeId: `output-${id}`,
        channel: 'final',
        complete: true,
      },
    },
  });

for (const [liveRows, includeLive] of [
  [true, true],
  [true, false],
  [false, true],
]) {
  test(`empty published source retains duplicate and sparse buffer coordinates (live=${liveRows}, includeLive=${includeLive})`, () => {
    const db = new Database(':memory:');
    try {
      db.exec(TRANSCRIPT_INVOCATION_INDEX_SCHEMA);
      const first = compact(0, 40);
      const overlap = compact(1, 42);
      const repeated = compact(0, 43);
      const appendedRepeat = compact(0, 44);
      const last = compact(2, 80);
      assert.equal(first.hash, repeated.hash);
      assert.equal(first.hash, appendedRepeat.hash);
      if (liveRows) {
        const insert = db.prepare('INSERT INTO source_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const [seq, event] of [
          [2, first],
          [6, overlap],
          [10, repeated],
        ])
          insert.run(
            1,
            seq,
            event.projection.eventNo,
            'inv',
            event.hash,
            seq * 5000,
            5000,
            JSON.stringify(event.projection),
            '[]',
          );
      }
      const buffered = new Array(6);
      buffered[1] = overlap;
      buffered[3] = appendedRepeat;
      buffered[5] = last;
      updateCanonicalInvocationIndex(db, { session, directory: 'unused', buffered, includeLive }, ['missing', 'live'], {
        sourceBytesScanned: 0,
        hydratedBytes: 0,
        summaryCacheHits: 0,
      });
      const active = liveRows && includeLive;
      const expected = active
        ? [
            [1, 2, first],
            [2, 1, overlap],
            [2, 3, appendedRepeat],
            [2, 5, last],
            [1, 10, repeated],
          ]
        : [
            [2, 1, overlap],
            [2, 3, appendedRepeat],
            [2, 5, last],
          ];
      const rows = db
        .prepare(`SELECT c.logical_no, c.source, c.seq, c.event_no, c.projection AS payload,
        CASE WHEN c.source = 2 THEN (SELECT projection FROM buffer WHERE seq = c.seq)
          ELSE (SELECT projection FROM source_events WHERE source = c.source AND seq = c.seq) END AS full
        FROM canonical c ORDER BY c.logical_no`)
        .all();
      assert.deepEqual(
        rows,
        expected.map(([source, seq, event], eventNo) => ({
          logical_no: eventNo,
          source,
          seq,
          event_no: eventNo,
          payload: '',
          full: JSON.stringify(event.projection),
        })),
      );
      const summary = JSON.parse(db.prepare('SELECT projection FROM summaries').get().projection);
      assert.equal(summary.eventCount, expected.length);
      assert.equal(summary.firstAssistantOutputEvidence.status, active ? 'conflict' : 'available');
      assert.equal(summary.firstAssistantOutputEvidence.identity.nativeId, active ? 'output-0' : 'output-1');
      if (!active)
        assert.equal(
          summary.firstAssistantOutputEvidence.content,
          expected[0][2].projection.event.assistantOutputFragment.content,
        );
    } finally {
      db.close();
    }
  });
}
