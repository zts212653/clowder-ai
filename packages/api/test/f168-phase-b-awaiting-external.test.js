/**
 * F168 Phase B — Task 6: awaiting_external state machine + delivery policy tests
 *
 * TDD: RED tests first.
 *
 * Covers:
 *  - State machine: case.awaiting_external in_progress→awaiting_external
 *  - State machine: external activity auto-restores awaiting_external→in_progress
 *  - Delivery policy: complete rule table (OWNER/MEMBER silent, labeled silent, etc.)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

let transition;
try {
  const mod = await import('../dist/domains/community/community-state-machine.js');
  transition = mod.transition;
} catch {
  // GREEN
}

let decideDelivery;
try {
  const mod = await import('../dist/domains/community/community-delivery-policy.js');
  decideDelivery = mod.decideDelivery;
} catch {
  // GREEN
}

const EMPTY_SNAPSHOT = { lastPublicCommentAt: null, closureWaiver: null };

function makeEvent(kind, overrides = {}) {
  return {
    sourceEventId: `test-${kind}`,
    subjectKey: 'issue:owner/repo#42',
    kind,
    classification: 'state-changing',
    payload: {},
    at: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// State machine: case.awaiting_external transitions
// ---------------------------------------------------------------------------

describe('state machine: case.awaiting_external', () => {
  it('in_progress → awaiting_external on case.awaiting_external', () => {
    assert.ok(transition, 'module must be importable');
    const result = transition('in_progress', makeEvent('case.awaiting_external'), EMPTY_SNAPSHOT);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.next, 'awaiting_external');
  });

  it('rejects case.awaiting_external from terminal or pre-triage states', () => {
    // routed is intentionally NOT in this list — Cloud R6 P1-1: owner must be able to
    // declare awaiting_external directly from routed (no production path moves routed→in_progress).
    assert.ok(transition);
    const invalid = ['new', 'triaged', 'needs_info', 'fixed', 'closed'];
    for (const state of invalid) {
      const result = transition(state, makeEvent('case.awaiting_external'), EMPTY_SNAPSHOT);
      assert.strictEqual(result.ok, false, `should reject from state: ${state}`);
      assert.strictEqual(result.reason, 'invalid_transition');
    }
  });

  it('allows case.awaiting_external from routed — primary post-accept workflow (Cloud R6 P1-1)', () => {
    // /resolve sets state=routed; there is no production path that auto-advances to in_progress,
    // so the owner must be able to call await_external directly from routed state.
    assert.ok(transition);
    const result = transition('routed', makeEvent('case.awaiting_external'), EMPTY_SNAPSHOT);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.next, 'awaiting_external');
  });

  it('allows case.awaiting_external from awaiting_external (re-declare)', () => {
    // Allow idempotent re-declaration when already in awaiting_external
    assert.ok(transition);
    const result = transition('awaiting_external', makeEvent('case.awaiting_external'), EMPTY_SNAPSHOT);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.next, 'awaiting_external');
  });
});

// ---------------------------------------------------------------------------
// State machine: informational events restore awaiting_external → in_progress
// ---------------------------------------------------------------------------

describe('state machine: awaiting_external auto-restore', () => {
  it('issue.commented from external actor restores awaiting_external → in_progress', () => {
    assert.ok(transition);
    const event = makeEvent('issue.commented', {
      classification: 'informational',
      payload: { commentId: 1, authorLogin: 'reporter', authorAssociation: 'CONTRIBUTOR' },
    });
    const result = transition('awaiting_external', event, EMPTY_SNAPSHOT);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.next, 'in_progress');
  });

  it('pr.review_submitted from external actor restores awaiting_external → in_progress', () => {
    assert.ok(transition);
    const event = makeEvent('pr.review_submitted', {
      classification: 'informational',
      payload: { reviewId: 5, reviewerLogin: 'contrib', authorAssociation: 'FIRST_TIME_CONTRIBUTOR' },
    });
    const result = transition('awaiting_external', event, EMPTY_SNAPSHOT);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.next, 'in_progress');
  });

  it('issue.commented from OWNER stays in awaiting_external (silent)', () => {
    assert.ok(transition);
    const event = makeEvent('issue.commented', {
      classification: 'informational',
      payload: { commentId: 2, authorLogin: 'maintainer', authorAssociation: 'OWNER' },
    });
    const result = transition('awaiting_external', event, EMPTY_SNAPSHOT);
    // OWNER/MEMBER activity does not restore — stays in awaiting_external
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.next, 'awaiting_external');
  });

  it('issue.commented from MEMBER stays in awaiting_external (silent)', () => {
    assert.ok(transition);
    const event = makeEvent('issue.commented', {
      classification: 'informational',
      payload: { commentId: 3, authorLogin: 'teammember', authorAssociation: 'MEMBER' },
    });
    const result = transition('awaiting_external', event, EMPTY_SNAPSHOT);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.next, 'awaiting_external');
  });

  it('issue.commented from non-awaiting_external state does NOT change state (informational → no-op)', () => {
    // When state is not awaiting_external, informational events don't change state
    assert.ok(transition);
    const event = makeEvent('issue.commented', {
      classification: 'informational',
      payload: { commentId: 4, authorLogin: 'user', authorAssociation: 'CONTRIBUTOR' },
    });
    const result = transition('in_progress', event, EMPTY_SNAPSHOT);
    // informational events are rejected (no transition) from non-awaiting_external
    assert.strictEqual(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Delivery policy: complete rule table
// ---------------------------------------------------------------------------

describe('decideDelivery: complete rule table', () => {
  it('OWNER comment → silent-log regardless of state', () => {
    assert.ok(decideDelivery, 'module must be importable');
    const result = decideDelivery({
      state: 'in_progress',
      eventKind: 'issue.commented',
      authorAssociation: 'OWNER',
    });
    assert.strictEqual(result, 'silent-log');
  });

  it('MEMBER comment → silent-log regardless of state', () => {
    assert.ok(decideDelivery);
    assert.strictEqual(
      decideDelivery({ state: 'in_progress', eventKind: 'issue.commented', authorAssociation: 'MEMBER' }),
      'silent-log',
    );
  });

  it('issue.labeled → silent-log always (label changes are noise for owners)', () => {
    assert.ok(decideDelivery);
    // issue.labeled covers both labeled + unlabeled webhook events
    assert.strictEqual(
      decideDelivery({ state: 'in_progress', eventKind: 'issue.labeled', authorAssociation: 'CONTRIBUTOR' }),
      'silent-log',
    );
    assert.strictEqual(
      decideDelivery({ state: 'awaiting_external', eventKind: 'issue.labeled', authorAssociation: 'NONE' }),
      'silent-log',
    );
  });

  it('external comment on non-awaiting state → wake-owner', () => {
    assert.ok(decideDelivery);
    assert.strictEqual(
      decideDelivery({
        state: 'in_progress',
        eventKind: 'issue.commented',
        authorAssociation: 'CONTRIBUTOR',
      }),
      'wake-owner',
    );
  });

  it('external comment on awaiting_external → wake-owner (state machine restores)', () => {
    assert.ok(decideDelivery);
    assert.strictEqual(
      decideDelivery({
        state: 'awaiting_external',
        eventKind: 'issue.commented',
        authorAssociation: 'NONE',
      }),
      'wake-owner',
    );
  });

  it('external pr.review_submitted → wake-owner', () => {
    assert.ok(decideDelivery);
    assert.strictEqual(
      decideDelivery({
        state: 'in_progress',
        eventKind: 'pr.review_submitted',
        authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      }),
      'wake-owner',
    );
  });

  it('unknown authorAssociation (undefined) → wake-owner (safe default)', () => {
    assert.ok(decideDelivery);
    assert.strictEqual(
      decideDelivery({ state: 'in_progress', eventKind: 'issue.commented', authorAssociation: undefined }),
      'wake-owner',
    );
  });
});
