/**
 * Tests for reviewer-matcher.ts
 * F032: Dynamic reviewer selection
 *
 * Current roster has 2 peer-reviewers:
 *   opus (ragdoll) and codex (maine-coon)
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// We need to test the module with mocked config
let resolveReviewer, canReview, _getAvailableReviewers;

describe('reviewer-matcher', () => {
  beforeEach(async () => {
    // Dynamic import to get fresh module
    const mod = await import('../dist/domains/cats/services/collaboration/reviewer-matcher.js');
    resolveReviewer = mod.resolveReviewer;
    canReview = mod.canReview;
    _getAvailableReviewers = mod.getAvailableReviewers;
  });

  describe('resolveReviewer', () => {
    it('selects different-family reviewer for opus', async () => {
      // opus is ragdoll, should get codex (maine-coon, peer-reviewer)
      const result = await resolveReviewer({ author: 'opus' });

      assert.equal(result.reviewer, 'codex');
      assert.equal(result.isDegraded, false);
    });

    it('selects different-family reviewer for codex', async () => {
      // codex is maine-coon, should get opus (ragdoll, peer-reviewer)
      const result = await resolveReviewer({ author: 'codex' });

      assert.equal(result.reviewer, 'opus');
      assert.equal(result.isDegraded, false);
    });

    it('returns candidates list', async () => {
      const result = await resolveReviewer({ author: 'opus' });

      // Should include peer-reviewers except author
      assert.ok(result.candidates.length >= 1);
      assert.ok(!result.candidates.includes('opus')); // author excluded
    });
  });

  describe('canReview', () => {
    it('rejects self-review', () => {
      const result = canReview('opus', 'opus');
      assert.equal(result.canReview, false);
      assert.ok(result.reason.includes('own code'));
    });

    it('rejects non-peer-reviewer', () => {
      // gemini has 'designer' role, not 'peer-reviewer'
      const result = canReview('gemini', 'codex');
      assert.equal(result.canReview, false);
      assert.ok(result.reason.includes('peer-reviewer role'));
    });

    it('allows different-family peer-reviewer', () => {
      // codex (maine-coon) reviewing opus (ragdoll)
      const result = canReview('codex', 'opus');
      assert.equal(result.canReview, true);
      assert.equal(result.reason, 'OK');
    });

    it('allows opus reviewing codex', () => {
      const result = canReview('opus', 'codex');
      assert.equal(result.canReview, true);
      assert.equal(result.reason, 'OK');
    });
  });

  describe('unavailable cats', () => {
    it('handles missing author in roster gracefully', async () => {
      // unknown cat not in roster
      const result = await resolveReviewer({ author: 'unknown-cat' });

      // Should return default cat without error
      assert.ok(result.reviewer);
      assert.equal(result.isDegraded, false);
    });
  });
});
