// F296 B3a hard gate 3: admission -> delivery must be an honest state machine.
//
// The two dishonest options the spec rules out:
//
//   a) `has() -> put()` (B2b): two concurrent prompts both see "not delivered"
//      and both present the same projection. Double injection.
//   b) `SETNX` at admission time: the projection is consumed before the provider
//      ever sees it, so a render/launch failure suppresses it FOREVER — the cat
//      never sees content the ledger believes it received.
//
// This implements (c): `pending reservation -> delivered`, with a token, an
// expiry, explicit release on failure, and reclaim-on-expiry for crash recovery.
//
// What that buys, stated honestly and asserted below: at most one presentation
// per (scope, epoch, subject, revision, presentation) per *successful* delivery,
// with a real crash window between provider receipt and commit that re-presents
// (at-least-once tail). It is NOT exactly-once and nothing here may claim it is.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { mapToPresentation } = await import('../dist/domains/cats/services/session/context-presentation.js');
const { mintDeliveryReceipt } = await import('../dist/domains/cats/services/session/delivery-receipt.js');
const {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
  PRESENTATION_DELIVERY_GUARANTEE,
  DEFAULT_RESERVATION_TTL_MS,
} = await import('../dist/domains/cats/services/session/PresentationLedger.js');

const SCOPE = { scopeKey: 'user-1::opus5::thread-1', contextEpoch: 3 };
const INVALIDATOR = { owner: 'task-store', ref: 'task-42' };

function stateClaim(overrides = {}) {
  return mapToPresentation({
    subjectKey: 'subject-a',
    asOf: { kind: 'version', value: 'rev-1' },
    sourceTier: 'T1',
    invalidator: INVALIDATOR,
    requested: 'state',
    ...overrides,
  });
}

function receipt(overrides = {}) {
  return mintDeliveryReceipt({
    promptGenerationId: 'gen-1',
    providerReceivedAt: 1_700_000_000_000,
    providerAdapterId: 'codex/exec_json',
    ...overrides,
  });
}

// Expiry tests pass an EXPLICIT ttl rather than reusing DEFAULT_RESERVATION_TTL_MS.
// Deriving the clock advance from the same constant under test makes the test
// self-referential: raising the default to infinity would keep it green while
// crash recovery was in fact dead. (Caught by mutation, 2026-08-19.)
const TEST_RESERVATION_TTL_MS = 1_000;

/** Ledger with a controllable clock so expiry is deterministic, never slept on. */
function makeLedger(reservationTtlMs = TEST_RESERVATION_TTL_MS) {
  const clock = { nowMs: 1_000_000 };
  const store = new InMemoryPresentationLedgerStore();
  const ledger = new PresentationLedger(store, { now: () => clock.nowMs, reservationTtlMs });
  return { ledger, store, clock };
}

describe('F296 B3a gate 3: reservation lifecycle', () => {
  test('a reservation admits once and blocks a concurrent second prompt', async () => {
    const { ledger } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    assert.equal(first.admitted, true);

    // Second prompt for the same scope+epoch, while the first is still in flight.
    const second = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(second.admitted, false);
    assert.equal(second.reason, 'reserved_by_concurrent_prompt');
  });

  test('release makes the projection presentable again — a render failure is not a delivery', async () => {
    const { ledger } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    assert.equal(first.admitted, true);

    await ledger.release(first.reservation, 'render_failed');

    const retry = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(retry.admitted, true, 'a projection the cat never saw must not be suppressed');
  });

  test('commit consumes dedupe for this epoch', async () => {
    const { ledger } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    const committed = await ledger.commit(first.reservation, receipt());
    assert.equal(committed.committed, true);

    const second = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(second.admitted, false);
    assert.equal(second.reason, 'already_delivered_this_epoch');
  });

  test('commit is idempotent for the same reservation token', async () => {
    const { ledger } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    assert.equal((await ledger.commit(first.reservation, receipt())).committed, true);
    // At-least-once transports retry; a duplicate receipt must not corrupt state.
    assert.equal((await ledger.commit(first.reservation, receipt())).committed, true);
  });

  test('a receipt from a different prompt generation cannot claim the reservation', async () => {
    // Self-heal replaces a generation mid-flight. The spec is explicit: the
    // replaced generation must not collect the receipt of the one that shipped.
    const { ledger } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    const wrong = await ledger.commit(first.reservation, receipt({ promptGenerationId: 'gen-2' }));
    assert.equal(wrong.committed, false);
    assert.equal(wrong.reason, 'generation_mismatch');

    // ...and the projection is still owed to the cat, not silently swallowed.
    await ledger.release(first.reservation, 'generation_replaced');
    assert.equal((await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' })).admitted, true);
  });

  test('a forged (non-provider-minted) receipt is refused at the ledger boundary', async () => {
    const { ledger } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    await assert.rejects(
      () => ledger.commit(first.reservation, { promptGenerationId: 'gen-1', providerReceivedAt: 1 }),
      /delivery_receipt_not_provider_minted/,
    );
    // The refusal must not have consumed dedupe as a side effect.
    await ledger.release(first.reservation, 'forged_receipt');
    assert.equal((await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' })).admitted, true);
  });
});

describe('F296 B3a gate 3: crash recovery via reservation expiry', () => {
  test('an abandoned reservation is reclaimable once it expires', async () => {
    // The crash case: the process died between reserve() and release(). Without
    // expiry the projection would be wedged in `pending` forever.
    const { ledger, clock } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    assert.equal(first.admitted, true);

    assert.equal(
      (await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' })).admitted,
      false,
      'still held before expiry',
    );

    clock.nowMs += TEST_RESERVATION_TTL_MS + 1;

    const reclaimed = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(reclaimed.admitted, true);
  });

  test('an expired reservation cannot be committed after someone else reclaimed it', async () => {
    const { ledger, clock } = makeLedger();
    const stale = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    clock.nowMs += TEST_RESERVATION_TTL_MS + 1;
    const fresh = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(fresh.admitted, true);

    const late = await ledger.commit(stale.reservation, receipt({ promptGenerationId: 'gen-1' }));
    assert.equal(late.committed, false);
    assert.equal(late.reason, 'reservation_superseded');

    // The reclaiming prompt still owns it and can still deliver.
    assert.equal((await ledger.commit(fresh.reservation, receipt({ promptGenerationId: 'gen-2' }))).committed, true);
  });

  test('release with a stale token does not release the current holder', async () => {
    const { ledger, clock } = makeLedger();
    const stale = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    clock.nowMs += TEST_RESERVATION_TTL_MS + 1;
    const fresh = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' });

    await ledger.release(stale.reservation, 'late_cleanup');

    assert.equal(
      (await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-3' })).admitted,
      false,
      'the live reservation must survive a late release from a dead prompt',
    );
    assert.equal((await ledger.commit(fresh.reservation, receipt({ promptGenerationId: 'gen-2' }))).committed, true);
  });
});

describe('F296 B3a gate 3: the guarantee is stated, not overstated', () => {
  test('the default reservation ttl is a real, finite, human-scale bound', () => {
    // An "infinite" default would silently disable crash recovery while every
    // expiry test above (which sets its own ttl) stayed green.
    assert.equal(Number.isFinite(DEFAULT_RESERVATION_TTL_MS), true);
    assert.ok(DEFAULT_RESERVATION_TTL_MS >= 30_000, 'too short: would double-present under normal load');
    assert.ok(DEFAULT_RESERVATION_TTL_MS <= 30 * 60_000, 'too long: wedges a projection behind a dead process');
  });

  test('the declared guarantee is at-most-once-with-crash-window, never exactly-once', () => {
    assert.equal(PRESENTATION_DELIVERY_GUARANTEE, 'at_most_once_per_epoch_with_crash_redelivery');
    assert.equal(PRESENTATION_DELIVERY_GUARANTEE.includes('exactly_once'), false);
  });

  test('the crash window is real and re-presents rather than losing content', async () => {
    // Provider genuinely received the prompt, then the process died before
    // commit. We choose re-presentation (annoying) over suppression (a lie).
    const { ledger, clock } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    assert.equal(first.admitted, true);
    // ...provider received it here; no commit lands.
    clock.nowMs += TEST_RESERVATION_TTL_MS + 1;

    const afterRestart = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(afterRestart.admitted, true, 'documented at-least-once tail');
  });
});

describe('F296 B3a gate 3: invariants carried over from B2b', () => {
  test('an omitted projection never reserves and never blocks a later valid revision', async () => {
    const { ledger } = makeLedger();
    const omitted = mapToPresentation({
      subjectKey: 'subject-a',
      asOf: { kind: 'version', value: 'rev-1' },
      sourceTier: 'invalid',
      requested: 'state',
    });
    const outcome = await ledger.reserve(omitted, SCOPE, { promptGenerationId: 'gen-1' });
    assert.equal(outcome.admitted, false);
    assert.equal(outcome.reason, 'omitted_by_mapper');

    const revived = stateClaim();
    assert.equal((await ledger.reserve(revived, SCOPE, { promptGenerationId: 'gen-2' })).admitted, true);
  });

  test('a new revision of the same subject is a new projection', async () => {
    const { ledger } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    await ledger.commit(first.reservation, receipt());

    const newer = stateClaim({ asOf: { kind: 'version', value: 'rev-2' } });
    assert.equal((await ledger.reserve(newer, SCOPE, { promptGenerationId: 'gen-2' })).admitted, true);
  });

  test('a new epoch has no entries, but that is not replay authorization', async () => {
    const { ledger } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    await ledger.commit(first.reservation, receipt());
    assert.equal((await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' })).admitted, false);

    const nextEpoch = { ...SCOPE, contextEpoch: SCOPE.contextEpoch + 1 };
    assert.equal((await ledger.reserve(stateClaim(), nextEpoch, { promptGenerationId: 'gen-3' })).admitted, true);
  });

  test('the ledger stores coordinates only — never payload or disposition', async () => {
    const { ledger, store } = makeLedger();
    const first = await ledger.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    await ledger.commit(first.reservation, receipt());

    const serialized = JSON.stringify(store.snapshot());
    for (const forbidden of ['subject-a-body', 'propose', 'defer', 'abstain', 'canonical']) {
      assert.equal(serialized.includes(forbidden), false, `ledger leaked ${forbidden}`);
    }
  });
});
