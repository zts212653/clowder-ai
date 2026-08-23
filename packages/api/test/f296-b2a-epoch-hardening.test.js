// F296 B2a: epoch owner hardening — the prerequisites the ledger stands on.
//
// Two defects found after B1 landed (zero consumer, so no live failure):
//
//   1. Compaction dedupe compared only `lastCompactionEventId`, so it was
//      "last one wins". `A → B → A` re-advanced on the replayed A, and any
//      fresh/unknown/replaced transition dropped the remembered id entirely.
//      The fix is BOUNDED replay suppression (64-entry window), not
//      lifecycle-wide exact-once — see the eviction test below.
//   2. `resolve()` was read-modify-write with no CAS. Two writers on the same
//      scope could share epoch N+1 — and there ARE two writers: the invocation
//      path and the PreCompact hook route, which never takes the invocation's
//      (process-local) policy mutex.
//
// Both corrupt the meaning of the B2 ledger key even though each one's immediate
// failure direction is cold.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { applyContinuityToEpoch, ContextEpochOwner, contextEpochScopeKey } = await import(
  '../dist/domains/cats/services/session/ContextEpochOwner.js'
);
const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');

const SCOPE = { userId: 'user-1', catId: 'opus', threadId: 'thread-1' };
const KEY = contextEpochScopeKey(SCOPE);

const resumed = { state: 'resumed', reason: 'resume_confirmed', evidenceRef: 'ev:resumed', runtimeSessionId: 'r1' };
const fresh = { state: 'fresh', reason: 'no_prior_session', evidenceRef: 'ev:fresh', runtimeSessionId: 'r1' };
const unknown = { state: 'unknown', reason: 'signal_unavailable', evidenceRef: 'ev:unknown' };

function seed() {
  return {
    scopeKey: KEY,
    contextEpoch: 5,
    contextMode: 'hot',
    boundRuntimeSessionId: 'r1',
    lastTransitionRef: 'ev:seed',
  };
}

function step(previous, disposition, compaction) {
  return applyContinuityToEpoch({
    scopeKey: KEY,
    previous,
    disposition,
    ...(compaction ? { compaction } : {}),
  });
}

describe('F296 B2a: compaction dedupe is bounded replay suppression, not last-one-wins', () => {
  test('A → B → replay A does not advance again', () => {
    let s = step(seed(), resumed, { eventId: 'A', runtimeSessionId: 'r1' }).state;
    const afterA = s.contextEpoch;
    s = step(s, resumed, { eventId: 'B', runtimeSessionId: 'r1' }).state;
    const afterB = s.contextEpoch;
    assert.equal(afterB, afterA + 1, 'a genuinely new event still advances');

    const replay = step(s, resumed, { eventId: 'A', runtimeSessionId: 'r1' });
    assert.equal(replay.state.contextEpoch, afterB, 'replaying A must not advance a second time');
    assert.equal(replay.transition, 'context_compaction_replay');
    assert.equal(replay.state.contextMode, 'cold', 'replay suppression cannot manufacture a hot verdict');
  });

  test('a consumed event id survives fresh / unknown / replaced transitions', () => {
    for (const intervening of [fresh, unknown]) {
      let s = step(seed(), resumed, { eventId: 'A', runtimeSessionId: 'r1' }).state;
      s = step(s, intervening).state;
      // Re-establish a binding so the resumed branch is reachable again.
      s = { ...s, boundRuntimeSessionId: 'r1' };
      const before = s.contextEpoch;

      const replay = step(s, resumed, { eventId: 'A', runtimeSessionId: 'r1' });
      assert.equal(
        replay.state.contextEpoch,
        before,
        `replaying A after ${intervening.state} must not advance (id must not be forgotten)`,
      );
    }
  });

  test('the window is bounded, and an evicted replay WILL advance again', () => {
    let s = seed();
    for (let i = 0; i < 200; i++) {
      s = step(s, resumed, { eventId: `evt-${i}`, runtimeSessionId: 'r1' }).state;
    }
    assert.ok(
      s.consumedCompactionEventIds.length <= 64,
      `consumed set must stay bounded, got ${s.consumedCompactionEventIds.length}`,
    );
    assert.ok(s.consumedCompactionEventIds.includes('evt-199'), 'newest ids are kept');
    assert.ok(!s.consumedCompactionEventIds.includes('evt-0'), 'oldest ids are evicted');

    // The honest half: an evicted id is NOT suppressed. This is the epistemic
    // ceiling of the design, asserted rather than merely described — so nobody
    // can later cite "exact-once" from a passing test name.
    const before = s.contextEpoch;
    const evictedReplay = step(s, resumed, { eventId: 'evt-0', runtimeSessionId: 'r1' });
    assert.equal(
      evictedReplay.state.contextEpoch,
      before + 1,
      'a replay past the window advances again — bounded suppression, not exact-once',
    );
    assert.equal(evictedReplay.transition, 'context_compacted');
  });
});

describe('F296 B2a: health signals are exposed (not yet recorded by any consumer)', () => {
  test('resolve() surfaces heuristic signals instead of swallowing them', async () => {
    const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
    const first = await owner.resolve({ ...SCOPE, disposition: fresh });
    await owner.confirmColdConsumed({ ...SCOPE, contextEpoch: first.contextEpoch });
    const result = await owner.resolve({
      ...SCOPE,
      disposition: resumed,
      heuristicSignals: ['token_drop'],
    });

    // "Exposed", not "recorded": no telemetry consumer writes these yet, and the
    // spec's 另记 health telemetry stays unclaimed until one does.
    assert.deepEqual(result.healthSignals, ['token_drop'], 'spec requires these be recordable, so expose them');
    assert.equal(result.contextEpoch, 1, 'and they still change nothing about the epoch');
    assert.equal(result.contextMode, 'hot');
  });
});

describe('F296 B2a: concurrent same-scope resolve cannot share an epoch', () => {
  /** A store that interleaves two readers before either writes — the exact race. */
  class RacingStore extends InMemoryContextEpochStore {
    constructor() {
      super();
      this.pendingReads = [];
    }
  }

  test('two writers racing on one scope produce two distinct epochs', async () => {
    const store = new InMemoryContextEpochStore();
    const owner = new ContextEpochOwner(store);
    await owner.resolve({ ...SCOPE, disposition: fresh });

    // Both read the same baseline, then both write.
    const [a, b] = await Promise.all([
      owner.resolve({ ...SCOPE, disposition: unknown }),
      owner.resolve({ ...SCOPE, disposition: unknown }),
    ]);

    assert.notEqual(a.contextEpoch, b.contextEpoch, 'a shared epoch would collide in the ledger key');
    const final = await store.get(KEY);
    assert.equal(final.contextEpoch, Math.max(a.contextEpoch, b.contextEpoch), 'the store holds the newest epoch');
  });

  test('a CAS conflict is retried, not silently dropped', async () => {
    const store = new InMemoryContextEpochStore();
    const owner = new ContextEpochOwner(store);
    await owner.resolve({ ...SCOPE, disposition: fresh });

    let conflicts = 0;
    const realCompareAndPut = store.compareAndPut.bind(store);
    let injected = false;
    store.compareAndPut = (record, expectedVersion) => {
      if (!injected) {
        injected = true;
        conflicts++;
        return false; // simulate a competing writer landing first
      }
      return realCompareAndPut(record, expectedVersion);
    };

    const result = await owner.resolve({ ...SCOPE, disposition: unknown });
    assert.equal(conflicts, 1, 'the conflict actually happened');
    assert.ok(result.contextEpoch >= 2, 'and the transition still landed after retry');
  });
});
