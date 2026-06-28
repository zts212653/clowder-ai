/**
 * community-sla-policy tests (F168 Phase D — D4)
 * Pure functions, no Redis needed.
 *
 * AC coverage:
 * D4.3 — fixed unreported SLA
 * D4.4 — stale awaiting external
 * D4.5 — stale needs info
 * D4.6 — policy override
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

const DAY = 86_400_000;
const NOW = 1_718_700_000_000; // deterministic base timestamp

/** Minimal projection stub for SLA evaluation. */
function proj(overrides = {}) {
  return {
    subjectKey: 'issue:acme/repo#1',
    state: 'new',
    lastExternalActivityAt: null,
    lastPublicCommentAt: null,
    closureWaiver: null,
    updatedAt: NOW - 1 * DAY,
    createdAt: NOW - 2 * DAY,
    ...overrides,
  };
}

describe('community-sla-policy', () => {
  let DEFAULT_SLA_POLICY;
  let evaluateSlaFindings;

  before(async () => {
    const mod = await import('../dist/domains/community/community-sla-policy.js');
    DEFAULT_SLA_POLICY = mod.DEFAULT_SLA_POLICY;
    evaluateSlaFindings = mod.evaluateSlaFindings;
  });

  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------

  describe('DEFAULT_SLA_POLICY', () => {
    it('has conservative defaults (7d/14d/14d)', () => {
      assert.equal(DEFAULT_SLA_POLICY.fixedUnreportedAfterMs, 7 * DAY);
      assert.equal(DEFAULT_SLA_POLICY.awaitingExternalStaleAfterMs, 14 * DAY);
      assert.equal(DEFAULT_SLA_POLICY.needsInfoStaleAfterMs, 14 * DAY);
    });
  });

  // -------------------------------------------------------------------------
  // D4.3 — fixed unreported SLA
  // -------------------------------------------------------------------------

  describe('fixed unreported (D4.3)', () => {
    it('fires when fixed older than threshold and no report or waiver', () => {
      const p = proj({ state: 'fixed', updatedAt: NOW - 8 * DAY });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].findingKind, 'case-fixed-unreported');
    });

    it('does NOT fire when fixed is younger than threshold', () => {
      const p = proj({ state: 'fixed', updatedAt: NOW - 3 * DAY });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(findings.length, 0);
    });

    it('does NOT fire when fixed has a closure waiver', () => {
      const p = proj({
        state: 'fixed',
        updatedAt: NOW - 8 * DAY,
        closureWaiver: { reason: 'test', actor: 'cat', evidence: 'link' },
      });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(findings.filter((f) => f.findingKind === 'case-fixed-unreported').length, 0);
    });

    it('does NOT fire when fixed has public comment (reported)', () => {
      const p = proj({
        state: 'fixed',
        updatedAt: NOW - 8 * DAY,
        lastPublicCommentAt: NOW - 7 * DAY,
      });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(findings.filter((f) => f.findingKind === 'case-fixed-unreported').length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // D4.4 — stale awaiting external
  // -------------------------------------------------------------------------

  describe('stale awaiting external (D4.4)', () => {
    it('fires when awaiting_external older than threshold with no recent external activity', () => {
      const p = proj({
        state: 'awaiting_external',
        updatedAt: NOW - 15 * DAY,
        lastExternalActivityAt: NOW - 20 * DAY,
      });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].findingKind, 'stale-awaiting-external');
    });

    it('does NOT fire when recent external activity', () => {
      const p = proj({
        state: 'awaiting_external',
        updatedAt: NOW - 15 * DAY,
        lastExternalActivityAt: NOW - 1 * DAY,
      });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(findings.length, 0);
    });

    it('fires when no external activity at all and older than threshold', () => {
      const p = proj({
        state: 'awaiting_external',
        updatedAt: NOW - 15 * DAY,
        lastExternalActivityAt: null,
      });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].findingKind, 'stale-awaiting-external');
    });
  });

  // -------------------------------------------------------------------------
  // D4.4b — awaiting_external SLA uses declaration time floor (cloud R3 P2-1)
  // -------------------------------------------------------------------------

  describe('awaiting_external SLA declaration time floor (D4.4b — cloud R3 P2-1)', () => {
    it('does NOT fire when case just entered awaiting_external despite old external activity', () => {
      // Case entered awaiting_external 1 day ago, but had external activity 20 days ago.
      // SLA should NOT fire — the *current* wait period is only 1 day old.
      const p = proj({
        state: 'awaiting_external',
        updatedAt: NOW - 1 * DAY,
        lastExternalActivityAt: NOW - 20 * DAY,
      });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(
        findings.filter((f) => f.findingKind === 'stale-awaiting-external').length,
        0,
        'should NOT fire stale-awaiting-external when awaiting_external was declared recently',
      );
    });

    it('fires when both declaration and external activity are older than threshold', () => {
      const p = proj({
        state: 'awaiting_external',
        updatedAt: NOW - 15 * DAY,
        lastExternalActivityAt: NOW - 20 * DAY,
      });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].findingKind, 'stale-awaiting-external');
    });
  });

  // -------------------------------------------------------------------------
  // D4.5 — stale needs info
  // -------------------------------------------------------------------------

  describe('stale needs info (D4.5)', () => {
    it('fires when needs_info older than threshold', () => {
      const p = proj({ state: 'needs_info', updatedAt: NOW - 15 * DAY });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].findingKind, 'stale-needs-info');
    });

    it('does NOT fire when needs_info is younger than threshold', () => {
      const p = proj({ state: 'needs_info', updatedAt: NOW - 5 * DAY });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      assert.equal(findings.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // D4.6 — policy override
  // -------------------------------------------------------------------------

  describe('policy override (D4.6)', () => {
    it('custom policy changes thresholds', () => {
      const customPolicy = {
        fixedUnreportedAfterMs: 2 * DAY,
        awaitingExternalStaleAfterMs: 3 * DAY,
        needsInfoStaleAfterMs: 3 * DAY,
      };
      // fixed for 3 days — under default 7d but over custom 2d
      const p = proj({ state: 'fixed', updatedAt: NOW - 3 * DAY });
      const findings = evaluateSlaFindings(p, customPolicy, NOW);
      assert.equal(
        findings.some((f) => f.findingKind === 'case-fixed-unreported'),
        true,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Edge: non-matching states produce no SLA findings
  // -------------------------------------------------------------------------

  describe('non-matching states', () => {
    for (const state of ['new', 'triaged', 'routed', 'in_progress', 'closed', 'declined', 'reported']) {
      it(`state=${state} produces no SLA findings`, () => {
        const p = proj({ state, updatedAt: NOW - 30 * DAY });
        const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
        assert.equal(findings.length, 0);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Finding shape validation
  // -------------------------------------------------------------------------

  describe('finding shape', () => {
    it('includes stable findingId, subjectKey, and severity', () => {
      const p = proj({ state: 'fixed', updatedAt: NOW - 8 * DAY });
      const findings = evaluateSlaFindings(p, DEFAULT_SLA_POLICY, NOW);
      const f = findings[0];
      assert.match(f.findingId, /^sla:/);
      assert.equal(f.subjectKey, 'issue:acme/repo#1');
      assert.equal(f.severity, 'warning');
      assert.equal(f.findingKind, 'case-fixed-unreported');
    });
  });
});
