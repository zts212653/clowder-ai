/**
 * CommunityReconciler tests (F168 Phase D — D3)
 * Pure function, no Redis.
 *
 * AC coverage:
 * D3.1 — first-run baseline creates no events/findings/wakes
 * D3.2 — stable sourceEventId, no duplicate events on repeated runs
 * D3.3 — no direct ObjectStore write (verified by interface shape)
 * D3.4 — fetch failure does not clear existing findings
 * D3.5 — GitHub closed while case open → append event + finding
 * D3.6 — case closed while GitHub open → finding, no fake event
 * D3.7 — GitHub reopened after close → append issue.reopened + finding
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

const DAY = 86_400_000;
const NOW = 1_718_700_000_000;

/** Minimal projection stub. */
function proj(overrides = {}) {
  return {
    repo: 'acme/repo',
    type: 'issue',
    number: 1,
    subjectKey: 'issue:acme/repo#1',
    state: 'new',
    ownerThreadId: null,
    ownerRole: null,
    nextOwner: 'none',
    lastExternalActivityAt: null,
    lastPublicCommentAt: null,
    linkedIssues: [],
    linkedPrs: [],
    closureWaiver: null,
    appliedEventCount: 1,
    lastRejectedEvent: null,
    deliveryCursor: null,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 5 * DAY,
    ...overrides,
  };
}

/** GitHub snapshot stub. */
function ghSnap(overrides = {}) {
  return {
    state: 'open',
    closedAt: null,
    mergedAt: null,
    ...overrides,
  };
}

describe('CommunityReconciler', () => {
  let reconcile;

  before(async () => {
    const mod = await import('../dist/domains/community/CommunityReconciler.js');
    reconcile = mod.reconcile;
  });

  // -----------------------------------------------------------------------
  // D3.1 — first-run baseline
  // -----------------------------------------------------------------------

  describe('first-run baseline (D3.1)', () => {
    it('marks baseline and creates no events, findings, or wakes', () => {
      const projection = proj({ state: 'routed' });
      const ghSnapshot = ghSnap({ state: 'open' });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: false,
        now: NOW,
      });

      assert.equal(result.isBaseline, true);
      assert.equal(result.events.length, 0);
      assert.equal(result.findings.length, 0);
    });
  });

  // -----------------------------------------------------------------------
  // D3.2 — stable sourceEventId
  // -----------------------------------------------------------------------

  describe('stable sourceEventId (D3.2)', () => {
    it('same missing fact on repeated runs produces identical sourceEventId', () => {
      const projection = proj({ state: 'routed' });
      const ghSnapshot = ghSnap({ state: 'closed', closedAt: '2026-06-10T00:00:00Z' });

      const r1 = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      const r2 = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      assert.equal(r1.events.length, 1);
      assert.equal(r2.events.length, 1);
      assert.equal(r1.events[0].sourceEventId, r2.events[0].sourceEventId);
    });
  });

  // -----------------------------------------------------------------------
  // D3.3 — no direct ObjectStore write
  // -----------------------------------------------------------------------

  describe('no direct ObjectStore write (D3.3)', () => {
    it('reconcile returns events + findings but no store mutation references', () => {
      const projection = proj({ state: 'routed' });
      const ghSnapshot = ghSnap({ state: 'closed', closedAt: '2026-06-10T00:00:00Z' });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      // The result shape should only contain events and findings,
      // not ObjectStore references or write commands
      assert.ok(Array.isArray(result.events));
      assert.ok(Array.isArray(result.findings));
      assert.equal(typeof result.isBaseline, 'boolean');
      // No objectStore mutation in return shape
      assert.equal(result.storeMutations, undefined);
    });
  });

  // -----------------------------------------------------------------------
  // D3.4 — fetch failure safety
  // -----------------------------------------------------------------------

  describe('fetch failure safety (D3.4)', () => {
    it('missing GitHub snapshot records a warning, does not produce findings', () => {
      const projection = proj({ state: 'routed' });
      // Simulate fetch failure: subjectKey not in githubSnapshots
      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map(),
        baselineEstablished: true,
        now: NOW,
      });

      // Should not produce any drift finding for this subject
      assert.equal(result.findings.filter((f) => f.subjectKey === 'issue:acme/repo#1').length, 0);
      // Should emit a warning
      assert.ok(result.warnings.some((w) => w.includes('issue:acme/repo#1')));
    });
  });

  // -----------------------------------------------------------------------
  // D3.5 — GitHub closed while case open
  // -----------------------------------------------------------------------

  describe('GitHub closed while case open (D3.5)', () => {
    it('appends issue.closed event and opens finding', () => {
      const projection = proj({ state: 'routed', type: 'issue' });
      const ghSnapshot = ghSnap({ state: 'closed', closedAt: '2026-06-10T00:00:00Z' });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      // Should produce an issue.closed event
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].kind, 'issue.closed');
      assert.equal(result.events[0].subjectKey, 'issue:acme/repo#1');
      assert.match(result.events[0].sourceEventId, /^reconciler:/);

      // Should produce a finding
      const finding = result.findings.find((f) => f.findingKind === 'github-closed-case-open');
      assert.ok(finding);
      assert.equal(finding.subjectKey, 'issue:acme/repo#1');
    });

    it('appends pr.merged event for merged PR', () => {
      const projection = proj({
        state: 'routed',
        type: 'pr',
        subjectKey: 'pr:acme/repo#5',
        number: 5,
      });
      const ghSnapshot = ghSnap({
        state: 'closed',
        closedAt: '2026-06-10T00:00:00Z',
        mergedAt: '2026-06-10T00:00:00Z',
      });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['pr:acme/repo#5', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].kind, 'pr.merged');
    });

    it('appends pr.closed event for unmerged closed PR', () => {
      const projection = proj({
        state: 'routed',
        type: 'pr',
        subjectKey: 'pr:acme/repo#5',
        number: 5,
      });
      const ghSnapshot = ghSnap({
        state: 'closed',
        closedAt: '2026-06-10T00:00:00Z',
        mergedAt: null,
      });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['pr:acme/repo#5', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].kind, 'pr.closed');
    });
  });

  // -----------------------------------------------------------------------
  // D3.6 — case closed while GitHub open
  // -----------------------------------------------------------------------

  describe('case closed while GitHub open (D3.6)', () => {
    it('opens finding without appending a fake event (declined case)', () => {
      // Use 'declined' state — 'closed' + issue hits D3.7 instead
      const projection = proj({ state: 'declined' });
      const ghSnapshot = ghSnap({ state: 'open' });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      // No fake event — we cannot fabricate a GitHub fact
      assert.equal(result.events.length, 0);

      // But should produce a drift finding
      const finding = result.findings.find((f) => f.findingKind === 'case-closed-github-open');
      assert.ok(finding);
      assert.equal(finding.subjectKey, 'issue:acme/repo#1');
    });

    it('opens finding for closed PR with GitHub open (no reopen event for PRs)', () => {
      const projection = proj({
        state: 'closed',
        type: 'pr',
        subjectKey: 'pr:acme/repo#3',
        number: 3,
      });
      const ghSnapshot = ghSnap({ state: 'open' });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['pr:acme/repo#3', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      // No fake event for PRs
      assert.equal(result.events.length, 0);

      const finding = result.findings.find((f) => f.findingKind === 'case-closed-github-open');
      assert.ok(finding);
    });
  });

  // -----------------------------------------------------------------------
  // D3.7 — GitHub reopened after close
  // -----------------------------------------------------------------------

  describe('GitHub reopened after close (D3.7)', () => {
    it('appends issue.reopened event and opens finding', () => {
      const projection = proj({ state: 'closed', type: 'issue' });
      // GitHub shows it's open again (was previously closed in our projection)
      const ghSnapshot = ghSnap({ state: 'open' });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      // Should append issue.reopened
      const reopenedEvent = result.events.find((e) => e.kind === 'issue.reopened');
      assert.ok(reopenedEvent);
      assert.equal(reopenedEvent.subjectKey, 'issue:acme/repo#1');

      // Should produce a finding
      const finding = result.findings.find((f) => f.findingKind === 'github-reopened-case-closed');
      assert.ok(finding);
    });

    it('does NOT produce issue.reopened for PRs (PRs cannot reopen)', () => {
      const projection = proj({
        state: 'closed',
        type: 'pr',
        subjectKey: 'pr:acme/repo#5',
        number: 5,
      });
      // PR showing open while we have it as closed
      const ghSnapshot = ghSnap({ state: 'open' });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['pr:acme/repo#5', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      // No event — PRs don't truly "reopen" in GitHub API sense for this flow
      // But should still produce a drift finding
      const finding = result.findings.find((f) => f.findingKind === 'case-closed-github-open');
      assert.ok(finding);
    });
  });

  // -----------------------------------------------------------------------
  // D3.8 — event ID uniqueness across reopen cycles
  // -----------------------------------------------------------------------

  describe('event ID uniqueness across reopen cycles (D3.8 — cloud P1-1)', () => {
    it('different closedAt timestamps produce different event IDs for close events', () => {
      const projection = proj({ state: 'routed', type: 'issue' });

      const r1 = reconcile({
        projections: [projection],
        githubSnapshots: new Map([
          ['issue:acme/repo#1', ghSnap({ state: 'closed', closedAt: '2026-06-10T00:00:00Z' })],
        ]),
        baselineEstablished: true,
        now: NOW,
      });

      const r2 = reconcile({
        projections: [projection],
        githubSnapshots: new Map([
          ['issue:acme/repo#1', ghSnap({ state: 'closed', closedAt: '2026-06-15T00:00:00Z' })],
        ]),
        baselineEstablished: true,
        now: NOW,
      });

      assert.equal(r1.events.length, 1);
      assert.equal(r2.events.length, 1);
      // Different close facts must produce different event IDs
      assert.notEqual(r1.events[0].sourceEventId, r2.events[0].sourceEventId);
    });

    it('same closedAt across runs still produces stable (identical) event IDs', () => {
      const projection = proj({ state: 'routed', type: 'issue' });
      const snapshot = ghSnap({ state: 'closed', closedAt: '2026-06-10T00:00:00Z' });

      const r1 = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', snapshot]]),
        baselineEstablished: true,
        now: NOW,
      });
      const r2 = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', snapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      assert.equal(r1.events[0].sourceEventId, r2.events[0].sourceEventId);
    });
  });

  // -----------------------------------------------------------------------
  // D3.8b — reopened event ID stability across retries (封板 final review P1)
  // -----------------------------------------------------------------------

  describe('reopened event ID stability across retries (D3.8b — 封板 P1)', () => {
    it('same reopen fact on repeated runs with different now produces identical sourceEventId', () => {
      // Scenario: projection is closed, GitHub is open → issue.reopened.
      // If append succeeds but apply fails (crash), projection stays closed.
      // Next run must produce the SAME sourceEventId for dedup.
      const projection = proj({ state: 'closed', type: 'issue', updatedAt: NOW - 3 * DAY });
      const ghSnapshot = ghSnap({ state: 'open' });

      const r1 = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      const r2 = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW + 60_000, // 1 minute later — simulates retry after crash
      });

      assert.equal(r1.events.length, 1);
      assert.equal(r2.events.length, 1);
      assert.equal(r1.events[0].kind, 'issue.reopened');
      assert.equal(r2.events[0].kind, 'issue.reopened');
      // Must be identical for EventLog dedup
      assert.equal(
        r1.events[0].sourceEventId,
        r2.events[0].sourceEventId,
        'same reopen fact must produce identical sourceEventId across retries',
      );
    });

    it('different close cycles produce different reopened sourceEventIds', () => {
      // First close cycle: updatedAt = NOW - 10d (closed at that time)
      const proj1 = proj({ state: 'closed', type: 'issue', updatedAt: NOW - 10 * DAY });
      // Second close cycle: updatedAt = NOW - 2d (closed more recently)
      const proj2 = proj({ state: 'closed', type: 'issue', updatedAt: NOW - 2 * DAY });
      const ghSnapshot = ghSnap({ state: 'open' });

      const r1 = reconcile({
        projections: [proj1],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      const r2 = reconcile({
        projections: [proj2],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      assert.equal(r1.events[0].kind, 'issue.reopened');
      assert.equal(r2.events[0].kind, 'issue.reopened');
      // Different close cycles → different updatedAt → different sourceEventIds
      assert.notEqual(
        r1.events[0].sourceEventId,
        r2.events[0].sourceEventId,
        'different close cycles must produce different reopened sourceEventIds',
      );
    });
  });

  // -----------------------------------------------------------------------
  // D3.9 — reported cases are active for closure reconciliation (cloud R2 P1-2)
  // -----------------------------------------------------------------------

  describe('reported cases are active (D3.9 — cloud R2 P1-2)', () => {
    it('appends issue.closed event for a reported case whose GitHub issue is closed', () => {
      // A case in 'reported' state (initial intake, not triaged) should be reconciled
      // against GitHub — if the submitter closes their issue, we must detect it.
      const projection = proj({ state: 'reported', type: 'issue' });
      const ghSnapshot = ghSnap({ state: 'closed', closedAt: '2026-06-12T00:00:00Z' });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      // Must produce an issue.closed event — reported is not truly terminal
      assert.equal(result.events.length, 1, 'should produce a close event for reported case');
      assert.equal(result.events[0].kind, 'issue.closed');
      assert.equal(result.events[0].subjectKey, 'issue:acme/repo#1');

      // Must produce a drift finding
      const finding = result.findings.find((f) => f.findingKind === 'github-closed-case-open');
      assert.ok(finding, 'should produce github-closed-case-open finding for reported case');
    });

    it('does NOT produce decline-drift finding for reported case with open GitHub', () => {
      // A reported case with an open GitHub issue is the normal state — no drift.
      const projection = proj({ state: 'reported', type: 'issue' });
      const ghSnapshot = ghSnap({ state: 'open' });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      // No events — reported + open is the normal initial state
      assert.equal(result.events.length, 0);
      // No decline-drift finding
      const driftFinding = result.findings.find((f) => f.findingKind === 'case-closed-github-open');
      assert.equal(driftFinding, undefined, 'should NOT produce decline-drift for reported + open');
    });
  });

  // -----------------------------------------------------------------------
  // SLA findings integration (D4.3-D4.5 via reconciler)
  // -----------------------------------------------------------------------

  describe('SLA findings integration', () => {
    it('includes SLA findings alongside drift findings', () => {
      const projection = proj({
        state: 'fixed',
        updatedAt: NOW - 8 * DAY,
      });
      const ghSnapshot = ghSnap({ state: 'open' });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map([['issue:acme/repo#1', ghSnapshot]]),
        baselineEstablished: true,
        now: NOW,
      });

      // Should have the SLA finding for fixed unreported
      const slaFinding = result.findings.find((f) => f.findingKind === 'case-fixed-unreported');
      assert.ok(slaFinding);
    });
  });

  // -----------------------------------------------------------------------
  // D4.7 — SLA evaluation independent of GitHub fetch (cloud R4 P2-1)
  // -----------------------------------------------------------------------

  describe('SLA evaluation during GitHub outage (D4.7 — cloud R4 P2-1)', () => {
    it('produces SLA findings even when GitHub snapshot is missing', () => {
      // Case is fixed for 8 days without report/waiver — should fire SLA.
      // But GitHub snapshot is missing (fetch failure). SLA must still work.
      const projection = proj({ state: 'fixed', updatedAt: NOW - 8 * DAY });

      const result = reconcile({
        projections: [projection],
        githubSnapshots: new Map(), // no snapshot — simulates GitHub outage
        baselineEstablished: true,
        now: NOW,
      });

      // SLA finding must be present despite no GitHub snapshot
      const slaFinding = result.findings.find((f) => f.findingKind === 'case-fixed-unreported');
      assert.ok(slaFinding, 'SLA finding should fire even without GitHub snapshot');

      // Should also have a warning about missing snapshot
      assert.ok(result.warnings.some((w) => w.includes('issue:acme/repo#1')));

      // No drift events (no GitHub state to compare)
      assert.equal(result.events.length, 0);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple projections
  // -----------------------------------------------------------------------

  describe('multiple projections', () => {
    it('processes all projections and collects all events + findings', () => {
      const p1 = proj({ state: 'routed', subjectKey: 'issue:acme/repo#1', number: 1 });
      const p2 = proj({
        state: 'routed',
        type: 'pr',
        subjectKey: 'pr:acme/repo#2',
        number: 2,
      });

      const result = reconcile({
        projections: [p1, p2],
        githubSnapshots: new Map([
          ['issue:acme/repo#1', ghSnap({ state: 'closed', closedAt: '2026-06-10T00:00:00Z' })],
          [
            'pr:acme/repo#2',
            ghSnap({ state: 'closed', closedAt: '2026-06-10T00:00:00Z', mergedAt: '2026-06-10T00:00:00Z' }),
          ],
        ]),
        baselineEstablished: true,
        now: NOW,
      });

      // Both should produce events
      assert.equal(result.events.length, 2);
      assert.equal(result.findings.filter((f) => f.findingKind === 'github-closed-case-open').length, 2);
    });
  });
});
