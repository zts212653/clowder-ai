/**
 * F167 — the ball custody projection reducer is the single definition of what an event does.
 *
 * `BallCustodyProjector.apply()`, `rebuild()` and the supersession replay all call it. These tests pin
 * three things: the extraction did not change the projector's behaviour (golden output captured from
 * the pre-extraction implementation), the pure fold and the persisted rebuild agree field for field at
 * every prefix (INV-2, including `heldUntil` and `lastStateChangeAt`, which `hold_expired` and the
 * dead-ball heartbeat grace depend on), and an event's outcome depends only on the events before it.
 *
 * The golden file was generated from the implementation as it stood BEFORE the reducer was extracted.
 * Regenerate it only when the state machine's semantics are changed on purpose.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import {
  reduceBallCustodyEvent,
  replayBallCustodyOutcomes,
  replayBallCustodyProjection,
} from '../dist/domains/ball-custody/ball-custody-projection-reducer.js';
import { randomEventSequences } from './helpers/ball-custody-random-events.js';

// JSON Lines, one sequence per line: Biome would expand a minified .json fixture into thousands of lines.
const golden = readFileSync(new URL('./fixtures/ball-custody-projector-golden.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

/** A store that round-trips through JSON, like the Redis-backed one does. */
function memStore() {
  const rows = new Map();
  return {
    get: async (key) => (rows.has(key) ? JSON.parse(JSON.stringify(rows.get(key))) : null),
    save: async (projection) => {
      rows.set(projection.subjectKey, JSON.parse(JSON.stringify(projection)));
    },
    listSubjectKeys: async () => [...rows.keys()],
    delete: async (key) => {
      rows.delete(key);
    },
  };
}

function memLog(events) {
  return {
    read: async (subjectKey) => events.filter((event) => event.subjectKey === subjectKey),
    listSubjects: async () => [...new Set(events.map((event) => event.subjectKey))],
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Pure fold of the reducer: the projection after each prefix. */
function foldAll(events) {
  const projections = [];
  let projection = null;
  for (const event of events) {
    projection = reduceBallCustodyEvent(projection, event).after;
    projections.push(projection);
  }
  return projections;
}

describe('F167 ball custody projection reducer', () => {
  test('the projector still produces exactly what the pre-extraction implementation produced', async () => {
    const sequences = randomEventSequences(golden.length, 1);
    assert.equal(sequences.length, golden.length);
    for (const [index, events] of sequences.entries()) {
      const expected = golden[index];
      assert.equal(events.length, expected.length, `seed ${expected.seed}: generator drifted`);
      const store = memStore();
      const projector = new BallCustodyProjector(memLog([]), store);
      let mask = '';
      let previousApplied = 0;
      for (const event of events) {
        await projector.apply(event);
        const projection = await store.get(event.subjectKey);
        mask += projection.appliedEventCount > previousApplied ? '1' : '0';
        previousApplied = projection.appliedEventCount;
      }
      assert.equal(mask, expected.acceptedMask, `seed ${expected.seed}: accepted/rejected pattern changed`);
      assert.deepEqual(
        await store.get(events[0].subjectKey),
        expected.final,
        `seed ${expected.seed}: projection changed`,
      );
    }
  });

  test('replay and a persisted rebuild agree on every field at every prefix, on sequences the golden never saw', async () => {
    for (const [index, events] of randomEventSequences(300, 5001).entries()) {
      const folded = foldAll(events);
      const subjectKey = events[0].subjectKey;
      const cut = [1, Math.ceil(events.length / 2), events.length];
      for (const length of new Set(cut)) {
        const store = memStore();
        const projector = new BallCustodyProjector(memLog(events.slice(0, length)), store);
        await projector.rebuild(subjectKey);
        assert.deepEqual(
          await store.get(subjectKey),
          JSON.parse(JSON.stringify(folded[length - 1])),
          `sequence ${5001 + index} prefix ${length}`,
        );
      }
    }
  });

  test('the projection a replay ends in is the fold of the reducer at every prefix, and null for an empty log', () => {
    assert.equal(replayBallCustodyProjection([]), null);
    for (const [index, events] of randomEventSequences(300, 17001).entries()) {
      const folded = foldAll(events);
      for (const length of new Set([1, Math.ceil(events.length / 2), events.length])) {
        assert.deepEqual(
          replayBallCustodyProjection(events.slice(0, length)),
          folded[length - 1],
          `sequence ${17001 + index} prefix ${length}`,
        );
      }
    }
  });

  test('the outcome at index i depends only on the events before it', () => {
    for (const [index, events] of randomEventSequences(300, 9001).entries()) {
      const full = replayBallCustodyOutcomes(events);
      assert.equal(full.length, events.length);
      for (const length of [1, Math.ceil(events.length / 2), events.length]) {
        assert.deepEqual(
          replayBallCustodyOutcomes(events.slice(0, length)),
          full.slice(0, length),
          `sequence ${9001 + index} cut at ${length}`,
        );
        assert.deepEqual(replayBallCustodyOutcomes(events, length), full.slice(0, length));
      }
    }
  });

  test('reducing never mutates its inputs and never aliases the projection it was given', () => {
    for (const events of randomEventSequences(60, 13001)) {
      let projection = null;
      for (const event of events) {
        deepFreeze(event);
        const before = projection ? deepFreeze(structuredClone(projection)) : null;
        const reduction = reduceBallCustodyEvent(before, event);
        assert.notEqual(reduction.after, reduction.before);
        if (before) assert.equal(reduction.before, before);
        projection = reduction.after;
      }
    }
  });

  test('the generated sequences exercise accepted and rejected events of every kind', () => {
    const accepted = new Set();
    const rejected = new Set();
    for (const events of randomEventSequences(250, 1)) {
      replayBallCustodyOutcomes(events).forEach((outcome, index) => {
        (outcome.accepted ? accepted : rejected).add(events[index].kind);
      });
    }
    // `ball.handed` is accepted from every state, so it can only ever be accepted.
    assert.ok(accepted.has('ball.handed'));
    for (const kind of ['ball.held', 'ball.handed_cvo', 'ball.hold_expired', 'invocation.heartbeat']) {
      assert.ok(accepted.has(kind), `${kind} is never accepted by the generator`);
      assert.ok(rejected.has(kind), `${kind} is never rejected by the generator`);
    }
  });
});
