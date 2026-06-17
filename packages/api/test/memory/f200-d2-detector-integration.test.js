import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

/**
 * F200 AC-D2 — OutputVerifiedDetector integration tests.
 *
 * Verifies the detector correctly wires optional thread-aware signal methods
 * (isCvoAcceptedForThread, isReviewerApprovedForThread, isCiPassedForThread)
 * alongside the existing invocation-status and PR-merge signals.
 */

describe('F200 AC-D2 — Extended signal sources in OutputVerifiedDetector', () => {
  let OutputVerifiedDetector;

  before(async () => {
    const mod = await import(`../../dist/domains/memory/output-verified-detector.js?v=${Date.now()}`);
    OutputVerifiedDetector = mod.OutputVerifiedDetector;
  });

  // AC-D2.1: operator accept auto-detect
  it('detects cvo_accepted signal when source returns true', async () => {
    const detector = new OutputVerifiedDetector({
      getInvocationStatus: async () => null,
      isPrMergedForThread: async () => false,
      isCvoAcceptedForThread: async () => true,
      isReviewerApprovedForThread: async () => false,
      isCiPassedForThread: async () => false,
    });
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, true, 'cvo_accepted is a strong signal');
    assert.ok(result.signals.includes('cvo_accepted'));
  });

  // AC-D2.1: Reviewer approval auto-detect
  it('detects reviewer_approved signal when source returns true', async () => {
    const detector = new OutputVerifiedDetector({
      getInvocationStatus: async () => null,
      isPrMergedForThread: async () => false,
      isCvoAcceptedForThread: async () => false,
      isReviewerApprovedForThread: async () => true,
      isCiPassedForThread: async () => false,
    });
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, true, 'reviewer_approved is a strong signal');
    assert.ok(result.signals.includes('reviewer_approved'));
  });

  // AC-D2.2: CI check passed auto-detect
  it('detects ci_passed signal when source returns true', async () => {
    const detector = new OutputVerifiedDetector({
      getInvocationStatus: async () => null,
      isPrMergedForThread: async () => false,
      isCvoAcceptedForThread: async () => false,
      isReviewerApprovedForThread: async () => false,
      isCiPassedForThread: async () => true,
    });
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, true, 'ci_passed is a strong signal');
    assert.ok(result.signals.includes('ci_passed'));
  });

  // Multiple signals combine
  it('collects all signals when multiple sources fire', async () => {
    const detector = new OutputVerifiedDetector({
      getInvocationStatus: async () => 'succeeded',
      isPrMergedForThread: async () => true,
      isCvoAcceptedForThread: async () => true,
      isReviewerApprovedForThread: async () => true,
      isCiPassedForThread: async () => true,
    });
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, true);
    assert.ok(result.signals.includes('invocation_succeeded'));
    assert.ok(result.signals.includes('pr_merged'));
    assert.ok(result.signals.includes('cvo_accepted'));
    assert.ok(result.signals.includes('reviewer_approved'));
    assert.ok(result.signals.includes('ci_passed'));
    assert.equal(result.signals.length, 5);
  });

  // Backward compat: old sources without new methods still work
  it('works with sources that only implement v1 interface (no new methods)', async () => {
    const detector = new OutputVerifiedDetector({
      getInvocationStatus: async () => 'succeeded',
      isPrMergedForThread: async () => true,
    });
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, true);
    assert.ok(result.signals.includes('pr_merged'));
    assert.ok(!result.signals.includes('cvo_accepted'));
  });

  // Error isolation: one failing source doesn't block others
  it('isolates errors per signal source', async () => {
    const detector = new OutputVerifiedDetector({
      getInvocationStatus: async () => 'succeeded',
      isPrMergedForThread: async () => {
        throw new Error('redis down');
      },
      isCvoAcceptedForThread: async () => true,
      isReviewerApprovedForThread: async () => {
        throw new Error('timeout');
      },
      isCiPassedForThread: async () => true,
    });
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, true, 'cvo_accepted still fires despite other errors');
    assert.ok(result.signals.includes('cvo_accepted'));
    assert.ok(result.signals.includes('ci_passed'));
    assert.ok(!result.signals.includes('pr_merged'), 'failed source excluded');
    assert.ok(!result.signals.includes('reviewer_approved'), 'failed source excluded');
  });
});
