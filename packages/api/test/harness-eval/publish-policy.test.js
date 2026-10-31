import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computePublishPolicy } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-policy.js';

/**
 * F192 Phase H 收尾 PR-3 — publish policy classifier (砚砚 R2 design-lock).
 *
 * Severity-driven: separates "real workspace PRs needing owner action" from
 * "low-noise evidence artifacts". Without this, every scheduled eval run opens
 * a regular PR (#2114 surfacing during PR-2 validation triggered this fix).
 *
 * Routing:
 *   fix / build / delete_sunset                 → regular_pr (owner action)
 *   keep_observe + findings.length > 0           → regular_pr + evidence-only (cat-owned)
 *   keep_observe + attribution.noFindingRecord   → evidence_only_interim_pr
 *                                                  (labels + body footer; futureMode rollup_deferred)
 *   missing/unknown attribution shape            → regular_pr (FAIL-OPEN — never misclassify as no-action)
 */
function packetWith(verdict) {
  return {
    id: 'p1',
    domainId: 'eval:a2a',
    createdAt: '2026-06-06T00:00:00.000Z',
    phenomenon: 'x',
    harnessUnderEval: { featureId: 'F1', componentId: 'c', name: 'n' },
    evidencePacket: { snapshotRefs: ['s'], attributionRefs: ['a'], metricRefs: ['m'], sampleTraceRefs: ['t'] },
    dailyTrend: { window: '7d', current: {}, baseline: {}, threshold: {}, direction: 'flat' },
    rootCauseHypothesis: { summary: 's', confidence: 'low', alternatives: ['a'] },
    verdict,
    ownerAsk: { targetFeatureId: 'F1', targetOwnerCatId: 'opus', requestedAction: 'r' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-13T00:00:00.000Z', closureCondition: 'c' },
    counterarguments: ['c'],
  };
}

describe('computePublishPolicy (砚砚 R2 design-lock)', () => {
  describe('regular_pr verdicts (owner action required)', () => {
    for (const verdict of ['fix', 'build', 'delete_sunset']) {
      it(`returns regular_pr for verdict=${verdict}`, () => {
        const policy = computePublishPolicy(packetWith(verdict), { findings: [{ id: 'f1' }] });
        assert.equal(policy.mode, 'regular_pr');
        assert.equal(policy.cvoMergeRequired, false);
        assert.ok(Array.isArray(policy.labels));
      });
    }
  });

  describe('keep_observe routing', () => {
    it('returns regular_pr + evidence-only label when actionable findings present', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), { findings: [{ id: 'f1' }, { id: 'f2' }] });
      assert.equal(policy.mode, 'regular_pr');
      assert.ok(policy.labels.includes('evidence-only'), 'evidence-only label required');
    });

    it('returns evidence_only_interim_pr when noFindingRecord present + findings empty', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), {
        findings: [],
        noFindingRecord: { reason: 'no actionable miss findings exceeded threshold' },
      });
      assert.equal(policy.mode, 'evidence_only_interim_pr');
      assert.deepEqual(policy.labels, ['evidence-only', 'no-action-needed']);
      assert.equal(policy.cvoMergeRequired, false);
      assert.equal(policy.futureMode, 'rollup_deferred');
    });

    it('returns evidence_only_interim_pr when noFindingRecord present + findings absent', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), {
        noFindingRecord: { reason: 'no actionable miss findings exceeded threshold' },
      });
      assert.equal(policy.mode, 'evidence_only_interim_pr');
    });
  });

  describe('FAIL-OPEN safety (砚砚 R2)', () => {
    it('returns regular_pr when attribution is undefined (unknown shape)', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), undefined);
      assert.equal(
        policy.mode,
        'regular_pr',
        'fail-open: missing attribution → regular PR (do not misclassify as no-action)',
      );
    });

    it('returns regular_pr when attribution is null', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), null);
      assert.equal(policy.mode, 'regular_pr');
    });

    it('returns regular_pr when attribution is malformed (non-object)', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), 'garbage');
      assert.equal(policy.mode, 'regular_pr');
    });

    it('returns regular_pr when findings.length > 0 AND noFindingRecord present (ambiguous → fail-open)', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), {
        findings: [{ id: 'f1' }],
        noFindingRecord: { reason: 'contradiction' },
      });
      assert.equal(policy.mode, 'regular_pr', 'contradiction → fail-open to regular PR (alert reviewer)');
    });

    it('returns regular_pr when findings is non-array (malformed)', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), { findings: 'not-an-array' });
      assert.equal(policy.mode, 'regular_pr');
    });

    it('returns regular_pr when noFindingRecord is not a record (malformed)', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), { noFindingRecord: 'string' });
      assert.equal(policy.mode, 'regular_pr');
    });

    // 砚砚 R1 PR-3 review P2: typeof [] === 'object' slips arrays through.
    it('returns regular_pr when noFindingRecord is an array (Array.isArray rejection)', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), { noFindingRecord: [] });
      assert.equal(policy.mode, 'regular_pr');
    });

    it('returns regular_pr when noFindingRecord is non-empty array (no special-casing)', () => {
      const policy = computePublishPolicy(packetWith('keep_observe'), { noFindingRecord: [{ x: 1 }] });
      assert.equal(policy.mode, 'regular_pr');
    });
  });

  describe('regular_pr verdicts ignore attribution shape', () => {
    it('fix verdict still regular_pr even with empty findings + noFindingRecord (severity wins)', () => {
      const policy = computePublishPolicy(packetWith('fix'), {
        findings: [],
        noFindingRecord: { reason: 'x' },
      });
      assert.equal(policy.mode, 'regular_pr', 'severity ladders above attribution shape — fix always regular_pr');
    });
  });
});
