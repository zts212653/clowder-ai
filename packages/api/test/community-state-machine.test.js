/**
 * community-state-machine tests (F168 Phase A — Task 3)
 * 纯函数，不需要 Redis。
 *
 * 核心验证：
 * 1. closure invariant — fixed→closed 没有 reported/waiver → 拒绝
 * 2. closure invariant — 有 waiver → 放行
 * 3. closure invariant — 经 reported (lastPublicCommentAt ≠ null) → 放行
 * 4. case.waived 缺 evidence 字段 → 拒绝
 * 5. 正常转换链完整走通
 * 6. 未定义组合 → invalid_transition
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

function makeEvent(kind, payloadOverride = {}) {
  return {
    sourceEventId: `test-${kind}`,
    subjectKey: 'issue:owner/repo#42',
    kind,
    classification: 'state-changing',
    payload: payloadOverride,
    at: Date.now(),
  };
}

function makeSnapshot(overrides = {}) {
  return {
    lastPublicCommentAt: null,
    closureWaiver: null,
    ...overrides,
  };
}

describe('community-state-machine', () => {
  let transition;

  before(async () => {
    const mod = await import('../dist/domains/community/community-state-machine.js');
    transition = mod.transition;
  });

  // -------------------------------------------------------------------------
  // closure invariant — the P0 guard
  // -------------------------------------------------------------------------

  describe('closure_invariant guard', () => {
    it('rejects fixed→closed when no reported and no waiver', () => {
      const result = transition('fixed', makeEvent('issue.closed'), makeSnapshot());
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'closure_invariant');
    });

    it('allows fixed→closed when lastPublicCommentAt is set (reported path)', () => {
      const snapshot = makeSnapshot({ lastPublicCommentAt: 12345 });
      const result = transition('fixed', makeEvent('issue.closed'), snapshot);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'closed');
    });

    it('allows fixed→closed when closureWaiver is set', () => {
      const snapshot = makeSnapshot({
        closureWaiver: { reason: 'no repro', actor: 'maintainer', evidence: 'https://...' },
      });
      const result = transition('fixed', makeEvent('issue.closed'), snapshot);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'closed');
    });

    it('allows closed transition from other states without guard (reported already closed)', () => {
      // reported → closed should be allowed (no guard needed here)
      const result = transition('reported', makeEvent('issue.closed'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'closed');
    });
  });

  // -------------------------------------------------------------------------
  // case.waived validation
  // -------------------------------------------------------------------------

  describe('case.waived validation', () => {
    it('rejects case.waived payload missing evidence', () => {
      const event = makeEvent('case.waived', { reason: 'not repro', actor: 'bob' });
      const result = transition('fixed', event, makeSnapshot());
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'invalid_transition');
    });

    it('rejects case.waived payload missing reason', () => {
      const event = makeEvent('case.waived', { actor: 'bob', evidence: 'https://...' });
      const result = transition('fixed', event, makeSnapshot());
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'invalid_transition');
    });

    it('rejects case.waived payload missing actor', () => {
      const event = makeEvent('case.waived', { reason: 'stale', evidence: 'https://...' });
      const result = transition('fixed', event, makeSnapshot());
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'invalid_transition');
    });

    it('accepts case.waived with all three required fields (state unchanged)', () => {
      const event = makeEvent('case.waived', {
        reason: 'stale issue',
        actor: 'maintainer',
        evidence: 'https://example.com/issue/1',
      });
      const result = transition('fixed', event, makeSnapshot());
      assert.strictEqual(result.ok, true);
      // waived does not change state
      assert.strictEqual(result.next, 'fixed');
    });
  });

  // -------------------------------------------------------------------------
  // Normal transition chain
  // -------------------------------------------------------------------------

  describe('normal transition chain', () => {
    it('issue.opened → new', () => {
      const result = transition('new', makeEvent('issue.opened'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'new');
    });

    it('pr.opened → new', () => {
      const result = transition('new', makeEvent('pr.opened'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'new');
    });

    it('pr.ready_for_review → new', () => {
      const result = transition('new', makeEvent('pr.ready_for_review'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'new');
    });

    it('case.triaged → triaged', () => {
      const result = transition('new', makeEvent('case.triaged'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'triaged');
    });

    it('case.routed → routed', () => {
      const result = transition('triaged', makeEvent('case.routed'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'routed');
    });

    it('case.declined → declined', () => {
      const result = transition('new', makeEvent('case.declined'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'declined');
    });

    it('pr.merged → fixed', () => {
      const result = transition('in_progress', makeEvent('pr.merged'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'fixed');
    });

    it('pr.closed → closed (non-merged closure)', () => {
      const result = transition('in_progress', makeEvent('pr.closed'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'closed');
    });

    it('case.reported → reported', () => {
      const result = transition('fixed', makeEvent('case.reported'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'reported');
    });

    it('issue.reopened → new (reopen resets state)', () => {
      const result = transition('closed', makeEvent('issue.reopened'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'new');
    });

    it('issue.closed from non-fixed state allows direct close', () => {
      const result = transition('declined', makeEvent('issue.closed'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'closed');
    });
  });

  // -------------------------------------------------------------------------
  // case.bootstrap (migration) — bypasses closure invariant
  // -------------------------------------------------------------------------

  describe('case.bootstrap', () => {
    it('bootstrap maps payload.mappedState to projection state', () => {
      const event = makeEvent('case.bootstrap', { mappedState: 'triaged', originalState: 'discussing' });
      const result = transition('new', event, makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'triaged');
    });

    it('bootstrap can set closed without lastPublicCommentAt (historical data exempt)', () => {
      const event = makeEvent('case.bootstrap', { mappedState: 'closed', originalState: 'closed' });
      const result = transition('new', event, makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'closed');
    });
  });

  // -------------------------------------------------------------------------
  // P1-5 guard: opened events must NOT reset existing state (plan note: "仅当无既有状态")
  // -------------------------------------------------------------------------

  describe('opened events: only valid from "new" state (cannot reset existing projection)', () => {
    it('issue.opened from routed → invalid_transition (plan: 仅当无既有状态)', () => {
      const result = transition('routed', makeEvent('issue.opened'), makeSnapshot());
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'invalid_transition');
    });

    it('pr.opened from triaged → invalid_transition', () => {
      const result = transition('triaged', makeEvent('pr.opened'), makeSnapshot());
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'invalid_transition');
    });

    it('pr.ready_for_review from fixed → invalid_transition', () => {
      const result = transition('fixed', makeEvent('pr.ready_for_review'), makeSnapshot());
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'invalid_transition');
    });

    it('issue.reopened from closed → new (explicit reopen is always valid)', () => {
      // issue.reopened IS allowed from any state — it explicitly re-opens a closed case
      const result = transition('closed', makeEvent('issue.reopened'), makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'new');
    });
  });

  // -------------------------------------------------------------------------
  // invalid_transition for undefined combos
  // -------------------------------------------------------------------------

  describe('invalid_transition', () => {
    it('returns invalid_transition for unknown event kind', () => {
      const result = transition('new', makeEvent('unknown.event'), makeSnapshot());
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'invalid_transition');
    });
  });

  // -------------------------------------------------------------------------
  // awaiting_external — informational events (Cloud R9 P2)
  // -------------------------------------------------------------------------

  describe('awaiting_external — informational events', () => {
    it('issue.labeled (no authorAssociation) from awaiting_external stays awaiting_external — label events must not wake owner (Cloud R9 P2)', () => {
      // Label events carry no authorAssociation in the webhook handler.
      // Without this fix, authorAssociation=undefined → isMaintainer=false →
      // in_progress (false wake-up for owner).
      const event = {
        sourceEventId: 'test-issue.labeled',
        subjectKey: 'issue:owner/repo#42',
        kind: 'issue.labeled',
        classification: 'informational',
        payload: {},
        at: Date.now(),
      };
      const result = transition('awaiting_external', event, makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(
        result.next,
        'awaiting_external',
        'label event (no authorAssociation) must NOT trigger in_progress wake-up',
      );
    });

    it('informational event with NONE authorAssociation from awaiting_external → in_progress (genuine external respondent)', () => {
      // A real external commenter always provides authorAssociation=NONE/COLLABORATOR/etc.
      // This must still wake the owner.
      const event = {
        sourceEventId: 'test-pr.review_submitted',
        subjectKey: 'issue:owner/repo#42',
        kind: 'pr.review_submitted',
        classification: 'informational',
        payload: { authorAssociation: 'NONE' },
        at: Date.now(),
      };
      const result = transition('awaiting_external', event, makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'in_progress', 'external respondent (NONE) must wake owner');
    });

    it('informational event with OWNER authorAssociation from awaiting_external stays awaiting_external (maintainer activity)', () => {
      const event = {
        sourceEventId: 'test-issue.commented-owner',
        subjectKey: 'issue:owner/repo#42',
        kind: 'issue.commented',
        classification: 'informational',
        payload: { authorAssociation: 'OWNER' },
        at: Date.now(),
      };
      const result = transition('awaiting_external', event, makeSnapshot());
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.next, 'awaiting_external', 'maintainer activity must not wake owner');
    });
  });
});
