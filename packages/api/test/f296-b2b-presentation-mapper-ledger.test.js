// F296 B2b: presentation mapper + ledger.
//
// The mapper is the single admission point: a producer cannot present a claim
// more strongly than the weakest applicable ceiling. The ledger answers only
// "did this projection already reach the model in this generation" — it holds
// coordinates, never payload.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { mapToPresentation } = await import('../dist/domains/cats/services/session/context-presentation.js');
const { InMemoryPresentationLedgerStore, PresentationLedger, presentationLedgerKey, decodePresentationLedgerKey } =
  await import('../dist/domains/cats/services/session/PresentationLedger.js');
const { mintDeliveryReceipt } = await import('../dist/domains/cats/services/session/delivery-receipt.js');

const VERSION = { kind: 'version', value: 'rev-1' };
const INVALIDATOR = { owner: 'task-store', ref: 'task-42' };
const SCOPE = { scopeKey: 'user-1::opus::thread-1', contextEpoch: 3 };

function candidate(overrides) {
  return { subjectKey: 'subject-a', asOf: VERSION, requested: 'directive', ...overrides };
}

describe('F296 B2b mapper: tier ceilings are exhaustive', () => {
  const TIER_TABLE = [
    { sourceTier: 'T0', invalidator: undefined, expected: 'directive' },
    { sourceTier: 'T1', invalidator: INVALIDATOR, expected: 'state' },
    { sourceTier: 'T2', invalidator: undefined, expected: 'pointer' },
    { sourceTier: 'invalid', invalidator: undefined, expected: 'omit' },
  ];

  for (const row of TIER_TABLE) {
    test(`${row.sourceTier} asking for directive is capped at ${row.expected}`, () => {
      const result = mapToPresentation(
        candidate({ sourceTier: row.sourceTier, ...(row.invalidator ? { invalidator: row.invalidator } : {}) }),
      );
      assert.equal(result.presentation, row.expected);
      assert.equal(result.sourceTier, row.sourceTier);
    });
  }

  test('a producer request only ever lowers, never raises', () => {
    const asPointer = mapToPresentation(candidate({ sourceTier: 'T0', requested: 'pointer' }));
    assert.equal(asPointer.presentation, 'pointer', 'T0 may choose to under-claim');

    const t2Directive = mapToPresentation(candidate({ sourceTier: 'T2', requested: 'directive' }));
    assert.equal(t2Directive.presentation, 'pointer', 'T2 asking for directive still lands on pointer');
  });

  test('T1 without an invalidator is not a state claim — it degrades to invalid/omit', () => {
    const result = mapToPresentation(candidate({ sourceTier: 'T1', requested: 'state' }));
    assert.equal(result.sourceTier, 'invalid');
    assert.equal(result.presentation, 'omit');
  });

  test('every tier × request combination terminates in a legal presentation', () => {
    for (const sourceTier of ['T0', 'T1', 'T2', 'invalid']) {
      for (const requested of ['directive', 'state', 'pointer', 'omit']) {
        const result = mapToPresentation(candidate({ sourceTier, requested, invalidator: INVALIDATOR }));
        assert.ok(['directive', 'state', 'pointer', 'omit'].includes(result.presentation));
        if (result.sourceTier === 'T2') assert.ok(['pointer', 'omit'].includes(result.presentation));
        if (result.sourceTier === 'invalid') assert.equal(result.presentation, 'omit');
        if (result.sourceTier === 'T1') assert.ok(['state', 'pointer', 'omit'].includes(result.presentation));
      }
    }
  });
});

describe('F296 B2b mapper: the Opportunity ceiling applies on top of the tier', () => {
  test('no epistemic ceiling can ever produce a directive', () => {
    for (const epistemicCeiling of ['mechanical_observation', 'state', 'pointer']) {
      const result = mapToPresentation(candidate({ sourceTier: 'T0', requested: 'directive', epistemicCeiling }));
      assert.notEqual(result.presentation, 'directive', `${epistemicCeiling} must not reach directive`);
    }
  });

  test('mechanical_observation reaching state must carry claimKind', () => {
    const result = mapToPresentation(
      candidate({ sourceTier: 'T0', requested: 'state', epistemicCeiling: 'mechanical_observation' }),
    );
    assert.equal(result.presentation, 'state');
    assert.equal(result.claimKind, 'mechanical_observation', 'a state without this reads as intent, not observation');
  });

  test('the lower of the two ceilings wins, in both directions', () => {
    // Tier is lower than the opportunity ceiling.
    const t2WithStateCeiling = mapToPresentation(
      candidate({ sourceTier: 'T2', requested: 'state', epistemicCeiling: 'state' }),
    );
    assert.equal(t2WithStateCeiling.presentation, 'pointer', 'a T2 payload stays a pointer inside a state envelope');

    // Opportunity ceiling is lower than the tier.
    const t0WithPointerCeiling = mapToPresentation(
      candidate({ sourceTier: 'T0', requested: 'state', epistemicCeiling: 'pointer' }),
    );
    assert.equal(t0WithPointerCeiling.presentation, 'pointer');
  });
});

// B3a migrated these from `admit()` / `recordDelivered()` to the reservation
// state machine. The invariants are B2b's and still belong here; only the API
// that expresses them changed. Reservation lifecycle, crash recovery and the
// receipt brand are covered in `f296-b3a-admission-state-machine.test.js`.
describe('F296 B2b ledger: only a provider receipt consumes dedupe', () => {
  function ledger() {
    return new PresentationLedger(new InMemoryPresentationLedgerStore(), { now: () => 1_000_000 });
  }
  const stateClaim = () =>
    mapToPresentation(candidate({ sourceTier: 'T1', requested: 'state', invalidator: INVALIDATOR }));
  const receipt = () =>
    mintDeliveryReceipt({
      promptGenerationId: 'gen-1',
      providerReceivedAt: 1_700_000_000_000,
      providerAdapterId: 'codex/exec_json',
    });

  test('reservation alone does not mark delivery', async () => {
    const l = ledger();
    const first = await l.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    assert.equal(first.admitted, true);

    // Prompt was built but the provider launch failed — nothing was received.
    await l.release(first.reservation, 'provider_launch_failed');
    const second = await l.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(second.admitted, true, 'a projection the cat never saw must not be suppressed');
  });

  test('after a receipt, the same projection is deduped within the epoch', async () => {
    const l = ledger();
    const first = await l.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    await l.commit(first.reservation, receipt());

    const second = await l.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(second.admitted, false);
    assert.equal(second.reason, 'already_delivered_this_epoch');
  });

  test('a new revision of the same subject is a different projection', async () => {
    const l = ledger();
    const first = await l.reserve(stateClaim(), SCOPE, { promptGenerationId: 'gen-1' });
    await l.commit(first.reservation, receipt());

    const newer = mapToPresentation(
      candidate({
        sourceTier: 'T1',
        requested: 'state',
        invalidator: INVALIDATOR,
        asOf: { kind: 'version', value: 'rev-2' },
      }),
    );
    const second = await l.reserve(newer, SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(second.admitted, true, 'a newer revision is new information, not a duplicate');
  });

  test('omit is a decision, never a delivery — and never even a reservation', async () => {
    const l = ledger();
    const omitted = mapToPresentation(candidate({ sourceTier: 'invalid', requested: 'state' }));
    const outcome = await l.reserve(omitted, SCOPE, { promptGenerationId: 'gen-1' });
    assert.equal(outcome.admitted, false);
    assert.equal(outcome.reason, 'omitted_by_mapper');

    // The same subject later becomes verifiable — omit must not have blocked it.
    const revived = mapToPresentation(candidate({ sourceTier: 'T1', requested: 'state', invalidator: INVALIDATOR }));
    const retry = await l.reserve(revived, SCOPE, { promptGenerationId: 'gen-2' });
    assert.equal(retry.admitted, true, 'an omit must not block a future valid revision');

    // Load-bearing reason, asserted rather than assumed: `presentation` is part
    // of the key, so an omit entry CANNOT collide with a later state entry for
    // the same subject+revision. Without this assertion the test above would
    // pass by construction and prove nothing about intent — a mutation that
    // writes omit into the ledger would go undetected.
    assert.notEqual(outcome.address.entryField, retry.reservation.address.entryField);
    assert.ok(outcome.address.entryField.endsWith('4:omit'));
    assert.ok(retry.reservation.address.entryField.endsWith('5:state'));
  });
});

describe('F296 B2b ledger: a new epoch is not replay authorization', () => {
  const ledger = () => new PresentationLedger(new InMemoryPresentationLedgerStore(), { now: () => 1_000_000 });

  test('the same projection may be re-admitted in a later epoch', async () => {
    const l = ledger();
    const claim = mapToPresentation(candidate({ sourceTier: 'T1', requested: 'state', invalidator: INVALIDATOR }));

    const first = await l.reserve(claim, SCOPE, { promptGenerationId: 'gen-1' });
    await l.commit(
      first.reservation,
      mintDeliveryReceipt({
        promptGenerationId: 'gen-1',
        providerReceivedAt: 1_700_000_000_000,
        providerAdapterId: 'codex/exec_json',
      }),
    );
    assert.equal((await l.reserve(claim, SCOPE, { promptGenerationId: 'gen-2' })).admitted, false);

    const nextEpoch = await l.reserve(
      claim,
      { ...SCOPE, contextEpoch: SCOPE.contextEpoch + 1 },
      {
        promptGenerationId: 'gen-3',
      },
    );
    assert.equal(nextEpoch.admitted, true, 'a new generation has not been told this yet');
  });

  test('re-admission is silence about delivery, not a claim of validity', async () => {
    // The ledger has no API that could resurrect an expired object: it is only
    // ever asked about an ALREADY-mapped presentation. An expired subject maps to
    // omit upstream, and omit is never admitted — regardless of epoch.
    const l = ledger();
    const expired = mapToPresentation(candidate({ sourceTier: 'invalid', requested: 'state' }));
    for (const contextEpoch of [3, 4, 99]) {
      const outcome = await l.reserve(expired, { ...SCOPE, contextEpoch }, { promptGenerationId: 'gen-1' });
      assert.equal(outcome.admitted, false, `epoch ${contextEpoch} must not revive an expired subject`);
    }
  });
});

describe('F296 B2b ledger: the key is content-free', () => {
  test('no candidate text can reach the stored key', () => {
    const key = presentationLedgerKey({
      scopeKey: SCOPE.scopeKey,
      contextEpoch: SCOPE.contextEpoch,
      subjectKey: 'pr:owner/repo#42',
      asOf: VERSION,
      presentation: 'state',
    });
    // Only coordinates: scope, epoch, subject id, revision token, presentation.
    // B3a: length-prefixed rather than separator-joined, so a subject containing
    // the old U+001F separator can no longer forge a field boundary.
    assert.deepEqual(decodePresentationLedgerKey(key), {
      scopeKey: 'user-1::opus::thread-1',
      contextEpoch: 3,
      subjectKey: 'pr:owner/repo#42',
      asOf: VERSION,
      presentation: 'state',
    });
    assert.ok(!/[a-z]{4,}\s[a-z]{4,}/i.test(key), 'no prose, no payload — coordinates only');
  });
});
