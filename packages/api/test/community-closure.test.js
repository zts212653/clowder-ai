import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { transition } = await import('../dist/domains/community/community-state-machine.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

/** Make a minimal CommunityEvent. */
function makeEvent(kind, payload = {}, overrides = {}) {
  return {
    sourceEventId: `test:${kind}:${NOW}`,
    subjectKey: 'issue:test/repo#1',
    kind,
    classification: 'state-changing',
    payload,
    at: NOW,
    ...overrides,
  };
}

/** Minimal projection snapshot for state machine guards. */
function makeSnapshot(overrides = {}) {
  return {
    lastPublicCommentAt: null,
    closureWaiver: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// D1 — State machine: case.reported transition
// ---------------------------------------------------------------------------

describe('case.reported state transition (D1)', () => {
  test('case.reported from fixed → reported', () => {
    const result = transition('fixed', makeEvent('case.reported'), makeSnapshot());
    assert.deepStrictEqual(result, { ok: true, next: 'reported' });
  });

  test('case.reported from any state → reported (wildcard from)', () => {
    // case.reported uses from: '*' in transition table
    for (const state of ['new', 'triaged', 'routed', 'in_progress', 'fixed', 'closed']) {
      const result = transition(state, makeEvent('case.reported'), makeSnapshot());
      assert.deepStrictEqual(result, { ok: true, next: 'reported' }, `from ${state}`);
    }
  });
});

// ---------------------------------------------------------------------------
// D1 — State machine: case.waived (no state change)
// ---------------------------------------------------------------------------

describe('case.waived state transition (D1)', () => {
  test('case.waived with valid payload does NOT change state', () => {
    const event = makeEvent('case.waived', {
      reason: 'Upstream fix applied, no public comment needed',
      actor: 'case-owner',
      evidence: 'PR #42 merged upstream',
    });
    const result = transition('fixed', event, makeSnapshot());
    assert.deepStrictEqual(result, { ok: true, next: 'fixed' });
  });

  test('case.waived rejects invalid payload (missing reason)', () => {
    const event = makeEvent('case.waived', {
      actor: 'case-owner',
      evidence: 'PR #42',
    });
    const result = transition('fixed', event, makeSnapshot());
    assert.equal(result.ok, false);
  });

  test('case.waived rejects invalid payload (missing actor)', () => {
    const event = makeEvent('case.waived', {
      reason: 'Upstream fix',
      evidence: 'PR #42',
    });
    const result = transition('fixed', event, makeSnapshot());
    assert.equal(result.ok, false);
  });

  test('case.waived rejects invalid payload (missing evidence)', () => {
    const event = makeEvent('case.waived', {
      reason: 'Upstream fix',
      actor: 'case-owner',
    });
    const result = transition('fixed', event, makeSnapshot());
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// D1 — Closure invariant: fixed → closed guards
// ---------------------------------------------------------------------------

describe('closure invariant guards (D1)', () => {
  test('fixed → closed without report or waiver → closure_invariant rejection', () => {
    const result = transition('fixed', makeEvent('issue.closed'), makeSnapshot());
    assert.deepStrictEqual(result, { ok: false, reason: 'closure_invariant' });
  });

  test('fixed → closed with lastPublicCommentAt (reported path) → allowed', () => {
    const result = transition('fixed', makeEvent('issue.closed'), makeSnapshot({ lastPublicCommentAt: NOW }));
    assert.deepStrictEqual(result, { ok: true, next: 'closed' });
  });

  test('fixed → closed with closureWaiver → allowed', () => {
    const result = transition(
      'fixed',
      makeEvent('issue.closed'),
      makeSnapshot({
        closureWaiver: {
          reason: 'Upstream fix',
          actor: 'case-owner',
          evidence: 'PR #42',
        },
      }),
    );
    assert.deepStrictEqual(result, { ok: true, next: 'closed' });
  });
});

// ---------------------------------------------------------------------------
// D2 — Closure checklist selector
// ---------------------------------------------------------------------------

const { computeClosureChecklist } = await import('../dist/domains/community/community-closure-checklist.js');

describe('computeClosureChecklist (D2)', () => {
  test('fixed without report or waiver → not ready, blocker = fixed-not-reported', () => {
    const result = computeClosureChecklist({
      state: 'fixed',
      lastPublicCommentAt: null,
      closureWaiver: null,
    });
    assert.equal(result.readyToClose, false);
    assert.ok(result.blockers.some((b) => b.kind === 'fixed-not-reported'));
  });

  test('fixed + reported (lastPublicCommentAt set) → ready', () => {
    const result = computeClosureChecklist({
      state: 'fixed',
      lastPublicCommentAt: NOW,
      closureWaiver: null,
    });
    assert.equal(result.readyToClose, true);
    assert.equal(result.blockers.length, 0);
  });

  test('fixed + waived → ready with audit evidence', () => {
    const result = computeClosureChecklist({
      state: 'fixed',
      lastPublicCommentAt: null,
      closureWaiver: {
        reason: 'Upstream fix',
        actor: 'case-owner',
        evidence: 'PR #42',
      },
    });
    assert.equal(result.readyToClose, true);
    assert.equal(result.blockers.length, 0);
    assert.ok(result.waiverPresent, 'should flag waiver as present');
  });

  test('reported state → ready (reported implies public reply)', () => {
    const result = computeClosureChecklist({
      state: 'reported',
      lastPublicCommentAt: NOW,
      closureWaiver: null,
    });
    assert.equal(result.readyToClose, true);
  });

  test('non-fixed/non-reported state → not applicable', () => {
    const result = computeClosureChecklist({
      state: 'in_progress',
      lastPublicCommentAt: null,
      closureWaiver: null,
    });
    // For non-terminal states, the checklist is not the gate
    assert.equal(result.readyToClose, false);
    assert.ok(result.blockers.some((b) => b.kind === 'not-in-closeable-state'));
  });

  test('closed state → already closed, ready = true', () => {
    const result = computeClosureChecklist({
      state: 'closed',
      lastPublicCommentAt: null,
      closureWaiver: null,
    });
    assert.equal(result.readyToClose, true);
  });

  test('missing fields fail closed as blockers', () => {
    // Simulating a projection with missing lastPublicCommentAt
    const result = computeClosureChecklist({
      state: 'fixed',
      lastPublicCommentAt: undefined,
      closureWaiver: undefined,
    });
    assert.equal(result.readyToClose, false);
    assert.ok(result.blockers.length > 0, 'missing fields should produce blockers');
  });
});
