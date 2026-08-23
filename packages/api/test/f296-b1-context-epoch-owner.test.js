// F296 B1: Context epoch owner.
//
// The epoch is the answer to one question: "is this cat still holding the working
// memory we last projected into?" Everything else in Phase B keys off it, so the
// transition table is the contract — not an implementation detail. Every row of
// the frozen table gets its own assertion, including the rows whose whole point is
// that they do NOT advance the epoch.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { applyContinuityToEpoch, ContextEpochOwner, contextEpochScopeKey } = await import(
  '../dist/domains/cats/services/session/ContextEpochOwner.js'
);
const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');

const SCOPE = { userId: 'user-1', catId: 'opus', threadId: 'thread-1' };

function disposition(state, extra = {}) {
  const reasons = {
    fresh: 'no_prior_session',
    resumed: 'resume_confirmed',
    replaced: 'runtime_replaced',
    unknown: 'signal_unavailable',
  };
  return { state, reason: extra.reason ?? reasons[state], evidenceRef: `ev:${state}`, ...extra };
}

function priorState(overrides = {}) {
  return {
    scopeKey: contextEpochScopeKey(SCOPE),
    contextEpoch: 7,
    contextMode: 'hot',
    lastTransitionRef: 'ev:previous',
    consumedCompactionEventIds: [],
    ...overrides,
  };
}

describe('F296 B1: epoch transition table (pure)', () => {
  test('scope first appearance → epoch=1, cold', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: null,
      disposition: disposition('fresh'),
    });
    assert.equal(result.state.contextEpoch, 1);
    assert.equal(result.state.contextMode, 'cold');
    assert.equal(result.transition, 'scope_first_seen');
  });

  test('fresh → epoch+1, cold, binding replaced', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: priorState({ boundRuntimeSessionId: 'runtime-old' }),
      disposition: disposition('fresh', { runtimeSessionId: 'runtime-new' }),
    });
    assert.equal(result.state.contextEpoch, 8);
    assert.equal(result.state.contextMode, 'cold');
    assert.equal(result.state.boundRuntimeSessionId, 'runtime-new');
    assert.equal(result.transition, 'fresh');
  });

  test('fresh without a runtime id → epoch+1, cold, binding cleared', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: priorState({ boundRuntimeSessionId: 'runtime-old' }),
      disposition: disposition('fresh'),
    });
    assert.equal(result.state.contextEpoch, 8);
    assert.equal(result.state.boundRuntimeSessionId, undefined);
  });

  test('replaced → epoch+1, cold, binds the new runtime id', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: priorState({ boundRuntimeSessionId: 'runtime-old' }),
      disposition: {
        state: 'replaced',
        reason: 'runtime_replaced',
        evidenceRef: 'ev:replaced',
        previousRuntimeSessionId: 'runtime-old',
        runtimeSessionId: 'runtime-new',
      },
    });
    assert.equal(result.state.contextEpoch, 8);
    assert.equal(result.state.contextMode, 'cold');
    assert.equal(result.state.boundRuntimeSessionId, 'runtime-new');
  });

  test('unknown → epoch+1, cold, binding cleared (fail closed)', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: priorState({ boundRuntimeSessionId: 'runtime-old' }),
      disposition: disposition('unknown', { reason: 'carrier_unsupported' }),
    });
    assert.equal(result.state.contextEpoch, 8);
    assert.equal(result.state.contextMode, 'cold');
    assert.equal(result.state.boundRuntimeSessionId, undefined);
    assert.equal(result.transition, 'unknown');
  });

  test('resumed with an exactly matching binding → epoch held, hot', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: priorState({
        boundRuntimeSessionId: 'runtime-a',
        contextMode: 'cold',
        coldConsumedAtEpoch: 7,
      }),
      disposition: disposition('resumed', { runtimeSessionId: 'runtime-a' }),
    });
    assert.equal(result.state.contextEpoch, 7, 'epoch is held, not advanced');
    assert.equal(result.state.contextMode, 'hot');
    assert.equal(result.state.boundRuntimeSessionId, 'runtime-a');
    assert.equal(result.transition, 'resumed');
  });

  test('resumed with a mismatched binding → normalized to unknown(binding_mismatch), epoch+1, cold', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: priorState({ boundRuntimeSessionId: 'runtime-a' }),
      disposition: disposition('resumed', { runtimeSessionId: 'runtime-b' }),
    });
    assert.equal(result.state.contextEpoch, 8);
    assert.equal(result.state.contextMode, 'cold');
    assert.equal(result.transition, 'binding_mismatch');
    assert.equal(result.normalizedDisposition.state, 'unknown');
    assert.equal(result.normalizedDisposition.reason, 'binding_mismatch');
  });

  test('resumed with no prior binding → cannot be trusted, epoch+1, cold', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: priorState({ boundRuntimeSessionId: undefined }),
      disposition: disposition('resumed', { runtimeSessionId: 'runtime-a' }),
    });
    assert.equal(result.state.contextEpoch, 8);
    assert.equal(result.state.contextMode, 'cold');
    assert.equal(result.transition, 'binding_mismatch');
  });

  test('resumed on a never-seen scope → still cold (nothing to resume into)', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: null,
      disposition: disposition('resumed', { runtimeSessionId: 'runtime-a' }),
    });
    assert.equal(result.state.contextEpoch, 1);
    assert.equal(result.state.contextMode, 'cold');
  });

  test('authoritative compaction → epoch+1, cold, binding preserved', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: priorState({ boundRuntimeSessionId: 'runtime-a' }),
      disposition: disposition('resumed', { runtimeSessionId: 'runtime-a' }),
      compaction: { eventId: 'compact-1', runtimeSessionId: 'runtime-a' },
    });
    assert.equal(result.state.contextEpoch, 8);
    assert.equal(result.state.contextMode, 'cold');
    assert.equal(result.state.boundRuntimeSessionId, 'runtime-a', 'compaction keeps the binding');
    assert.equal(result.transition, 'context_compacted');
    assert.deepEqual(result.state.consumedCompactionEventIds, ['compact-1']);
  });

  test('the same compaction event only advances the epoch once', () => {
    const afterFirst = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: priorState({ boundRuntimeSessionId: 'runtime-a' }),
      disposition: disposition('resumed', { runtimeSessionId: 'runtime-a' }),
      compaction: { eventId: 'compact-1', runtimeSessionId: 'runtime-a' },
    });
    const afterReplay = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: afterFirst.state,
      disposition: disposition('resumed', { runtimeSessionId: 'runtime-a' }),
      compaction: { eventId: 'compact-1', runtimeSessionId: 'runtime-a' },
    });
    assert.equal(afterReplay.state.contextEpoch, afterFirst.state.contextEpoch, 'replay must not advance');
    assert.equal(afterReplay.transition, 'context_compaction_replay');
    assert.equal(afterReplay.state.contextMode, 'cold', 'a duplicate report cannot undo the compaction edge');
  });

  test('a compaction event bound to another runtime is not this scope’s event', () => {
    const result = applyContinuityToEpoch({
      scopeKey: contextEpochScopeKey(SCOPE),
      previous: priorState({ boundRuntimeSessionId: 'runtime-a' }),
      disposition: disposition('resumed', { runtimeSessionId: 'runtime-a' }),
      compaction: { eventId: 'compact-9', runtimeSessionId: 'runtime-zzz' },
    });
    assert.equal(result.state.contextEpoch, 7, 'foreign compaction event must not advance this scope');
    assert.equal(result.transition, 'resumed');
  });

  test('heuristic signals never advance the epoch or flip the mode', () => {
    for (const heuristic of ['token_drop', 'message_drop', 'scratchpad_signature', 'auto_continue_breaker']) {
      const result = applyContinuityToEpoch({
        scopeKey: contextEpochScopeKey(SCOPE),
        previous: priorState({ boundRuntimeSessionId: 'runtime-a', contextMode: 'hot' }),
        disposition: disposition('resumed', { runtimeSessionId: 'runtime-a' }),
        heuristicSignals: [heuristic],
      });
      assert.equal(result.state.contextEpoch, 7, `${heuristic} must not advance the epoch`);
      assert.equal(result.state.contextMode, 'hot', `${heuristic} must not flip the mode`);
      assert.deepEqual(result.healthSignals, [heuristic], 'heuristics are recorded as health telemetry only');
    }
  });

  test('the epoch is monotonic across a long mixed history and never reused', () => {
    const seen = [];
    let state = null;
    const script = [
      disposition('fresh'),
      disposition('resumed', { runtimeSessionId: 'runtime-a' }),
      disposition('unknown'),
      { ...disposition('replaced'), runtimeSessionId: 'runtime-b' },
      disposition('resumed', { runtimeSessionId: 'runtime-b' }),
      disposition('resumed', { runtimeSessionId: 'runtime-c' }),
    ];
    for (const d of script) {
      const result = applyContinuityToEpoch({
        scopeKey: contextEpochScopeKey(SCOPE),
        previous: state,
        disposition: d,
      });
      state = result.state;
      seen.push(state.contextEpoch);
    }
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] >= seen[i - 1], `epoch must never go backwards: ${JSON.stringify(seen)}`);
    }
    assert.equal(new Set(seen).size < seen.length, true, 'held epochs repeat, that is expected');
    assert.equal(Math.max(...seen), seen[seen.length - 1], 'the newest epoch is the highest');
  });
});

describe('F296 B1: epoch owner (store-backed)', () => {
  test('epoch survives across invocations for the same scope', async () => {
    const owner = new ContextEpochOwner(new InMemoryContextEpochStore());

    const first = await owner.resolve({ ...SCOPE, disposition: disposition('fresh') });
    assert.equal(first.contextEpoch, 1);

    const second = await owner.resolve({ ...SCOPE, disposition: disposition('unknown') });
    assert.equal(second.contextEpoch, 2, 'the store carried the previous epoch across calls');
  });

  test('different scopes keep independent epochs', async () => {
    const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
    await owner.resolve({ ...SCOPE, disposition: disposition('fresh') });
    await owner.resolve({ ...SCOPE, disposition: disposition('unknown') });

    const otherThread = await owner.resolve({
      ...SCOPE,
      threadId: 'thread-2',
      disposition: disposition('fresh'),
    });
    assert.equal(otherThread.contextEpoch, 1, 'a different thread is a different scope');

    const otherCat = await owner.resolve({ ...SCOPE, catId: 'codex', disposition: disposition('fresh') });
    assert.equal(otherCat.contextEpoch, 1, 'a different cat is a different scope');
  });

  test('a resumed round-trip through the store stays hot on the same epoch', async () => {
    const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
    const first = await owner.resolve({
      ...SCOPE,
      disposition: disposition('fresh', { runtimeSessionId: 'runtime-a' }),
    });
    assert.equal(first.contextMode, 'cold');
    await owner.confirmColdConsumed({ ...SCOPE, contextEpoch: first.contextEpoch });

    const second = await owner.resolve({
      ...SCOPE,
      disposition: disposition('resumed', { runtimeSessionId: 'runtime-a' }),
    });
    assert.equal(second.contextMode, 'hot');
    assert.equal(second.contextEpoch, first.contextEpoch, 'a real resume holds the epoch');
  });

  test('owner touches no message cursor: its input surface cannot express one', () => {
    // F296: "任何 epoch 转移都不重置 message delivery cursor 或 seen cursor".
    // The strongest version of that guarantee is structural — the owner is not
    // given a cursor store at all, so it has nothing to reset.
    const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
    const keys = Object.getOwnPropertyNames(owner).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(owner)));
    for (const key of keys) {
      assert.ok(!/cursor/i.test(key), `epoch owner must not own a cursor surface, found: ${key}`);
    }
  });
});
