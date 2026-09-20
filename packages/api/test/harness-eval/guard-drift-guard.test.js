/**
 * F257 V2/Phase B — differential drift guard.
 *
 * Property test: coalesceGuardEpisodes (full coalescer) and
 * EpisodeBoundaryTracker (streaming state machine) must always agree
 * on episode count for the same input — 500 random seeds.
 *
 * Fable ruling: "differential guard 落盘" — if the two ever diverge,
 * it means the state machine was not correctly absorbed into the coalescer
 * (or vice versa), and the dual implementation drift is back.
 *
 * [opus/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  coalesceGuardEpisodes,
  EPISODE_GAP_MS,
  EpisodeBoundaryTracker,
} from '../../dist/infrastructure/harness-eval/guard-episode-coalescing.js';

import { rawEvent, T } from './_guard-test-helpers.js';

// ---------------------------------------------------------------------------
// Seeded PRNG (xorshift32) for reproducible random tests
// ---------------------------------------------------------------------------

function xorshift32(seed) {
  let state = seed | 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

// ---------------------------------------------------------------------------
// Random event generator
// ---------------------------------------------------------------------------

const GUARD_IDS = ['hold_ball_rate_limit', 'a2a_pingpong_block', 'schema_reject'];
const THREAD_IDS = ['thread_1', 'thread_2', 'thread_3', 'thread_4'];
const CAT_IDS = ['cat_1', 'cat_2', 'cat_3'];
const UNTRUSTED = ['', 'unknown'];

function generateRandomEvents(rand, count) {
  const events = [];
  for (let i = 0; i < count; i++) {
    const useUntrusted = rand() < 0.1;
    const guardId =
      useUntrusted && rand() < 0.5
        ? UNTRUSTED[Math.floor(rand() * UNTRUSTED.length)]
        : GUARD_IDS[Math.floor(rand() * GUARD_IDS.length)];
    const threadId =
      useUntrusted && rand() < 0.3
        ? UNTRUSTED[Math.floor(rand() * UNTRUSTED.length)]
        : THREAD_IDS[Math.floor(rand() * THREAD_IDS.length)];
    const catId = CAT_IDS[Math.floor(rand() * CAT_IDS.length)];
    // 40% within-gap clusters, 60% across-gap
    const gapScale = rand() < 0.4 ? 1000 : 200_000;
    const timestamp = T + Math.floor(rand() * 50) * gapScale + Math.floor(rand() * 500);
    events.push(rawEvent({ timestamp, seq: i, eventId: `drift-${i}-${timestamp}`, guardId, threadId, catId }));
  }
  return events;
}

/** Sort events the same way coalesceGuardEpisodes does internally. */
function sortEvents(events) {
  return [...events].sort(
    (a, b) => a.timestamp - b.timestamp || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );
}

/** Feed sorted events through tracker, return lowerBound. */
function trackerCount(sorted, gapMs = EPISODE_GAP_MS) {
  const tracker = new EpisodeBoundaryTracker(gapMs);
  for (const event of sorted) tracker.feed(event);
  return tracker.lowerBound;
}

// ---------------------------------------------------------------------------
// Explicit edge cases
// ---------------------------------------------------------------------------

describe('drift guard — edge cases', () => {
  it('empty input → 0 episodes for both paths', () => {
    assert.equal(coalesceGuardEpisodes([]).length, 0);
    assert.equal(trackerCount([]), 0);
  });

  it('single event → 1 episode for both paths', () => {
    const events = [rawEvent()];
    assert.equal(coalesceGuardEpisodes(events).length, 1);
    assert.equal(trackerCount(sortEvents(events)), 1);
  });

  it('all same key, within gap → 1 episode for both paths', () => {
    const events = Array.from({ length: 10 }, (_, i) => rawEvent({ timestamp: T + i * 1000, seq: i }));
    assert.equal(coalesceGuardEpisodes(events).length, 1);
    assert.equal(trackerCount(sortEvents(events)), 1);
  });

  it('all different keys → N episodes for both paths', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      rawEvent({ timestamp: T + i * 1000, seq: i, threadId: `thread_${i}`, catId: `cat_${i}` }),
    );
    assert.equal(coalesceGuardEpisodes(events).length, 5);
    assert.equal(trackerCount(sortEvents(events)), 5);
  });

  it('untrusted keys → each forms solo episode for both paths', () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0, threadId: '' }),
      rawEvent({ timestamp: T + 100, seq: 1, threadId: '' }),
      rawEvent({ timestamp: T + 200, seq: 2, catId: 'unknown' }),
    ];
    assert.equal(coalesceGuardEpisodes(events).length, 3);
    assert.equal(trackerCount(sortEvents(events)), 3);
  });
});

// ---------------------------------------------------------------------------
// 500-seed property test
// ---------------------------------------------------------------------------

describe('drift guard — 500-seed property test', () => {
  it('tracker.lowerBound === coalescer.length for 500 random event sets', () => {
    let failures = 0;
    const firstFailure = { seed: -1, msg: '' };

    for (let seed = 1; seed <= 500; seed++) {
      const rand = xorshift32(seed);
      const count = Math.floor(rand() * 50) + 1;
      const events = generateRandomEvents(rand, count);

      const coalescerCount = coalesceGuardEpisodes(events).length;
      const sorted = sortEvents(events);
      const lb = trackerCount(sorted);

      if (lb !== coalescerCount) {
        failures++;
        if (firstFailure.seed === -1) {
          firstFailure.seed = seed;
          firstFailure.msg = `seed=${seed}: tracker=${lb} coalescer=${coalescerCount} events=${count}`;
        }
      }
    }

    assert.equal(failures, 0, `${failures} seeds failed. First: ${firstFailure.msg}`);
  });
});
