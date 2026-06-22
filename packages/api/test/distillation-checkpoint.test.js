/**
 * F208 Phase E AC-E2: Distillation Checkpoint
 *
 * Event-driven checkpoint that fires on feat-phase-close and review-complete
 * events. Records lightweight "distillation opportunities" that surface to
 * cats as prompts to create full proposals (KD-3: judgment stays with cats).
 *
 * Idempotency: sourceId prevents duplicate opportunities for the same event.
 * Integration: hooks into ReviewFeedbackTaskSpec PR-merged and APPROVE paths.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('DistillationCheckpoint', () => {
  /** @type {import('../dist/infrastructure/distillation/DistillationCheckpoint.js').DistillationCheckpoint} */
  let checkpoint;
  /** @type {import('../dist/infrastructure/distillation/DistillationCheckpoint.js').InMemoryOpportunityStore} */
  let opportunityStore;

  const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

  beforeEach(async () => {
    const mod = await import('../dist/infrastructure/distillation/DistillationCheckpoint.js');
    opportunityStore = new mod.InMemoryOpportunityStore();
    checkpoint = new mod.DistillationCheckpoint({
      opportunityStore,
      log: noopLog,
    });
  });

  // ──────────────────── feat-phase-close ────────────────────

  describe('onFeatPhaseClose', () => {
    const ctx = {
      prNumber: 2461,
      repoFullName: 'zts212653/cat-cafe',
      authorCatId: 'opus',
      threadId: 'thread_abc',
      featureId: 'F208',
      phaseLabel: 'E',
    };

    it('creates an opportunity record on first call', async () => {
      const result = await checkpoint.onFeatPhaseClose(ctx);
      assert.equal(result.fired, true);
      assert.equal(result.sourceId, 'feat-phase-close:F208:E');

      const pending = await opportunityStore.listPending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].sourceEvent, 'feat-phase-close');
      assert.equal(pending[0].targetCatId, 'opus');
      assert.equal(pending[0].prNumber, 2461);
    });

    it('is idempotent — same sourceId does not create duplicate', async () => {
      await checkpoint.onFeatPhaseClose(ctx);
      const result = await checkpoint.onFeatPhaseClose(ctx);
      assert.equal(result.fired, false);

      const pending = await opportunityStore.listPending();
      assert.equal(pending.length, 1);
    });

    it('generates correct sourceId from featureId + phaseLabel', async () => {
      const result = await checkpoint.onFeatPhaseClose({
        ...ctx,
        featureId: 'F167',
        phaseLabel: 'O',
      });
      assert.equal(result.sourceId, 'feat-phase-close:F167:O');
    });
  });

  // ──────────────────── review-complete ─────────────────────

  describe('onReviewComplete', () => {
    const ctx = {
      prNumber: 2466,
      repoFullName: 'zts212653/cat-cafe',
      reviewerCatId: 'gpt52',
      authorCatId: 'opus-47',
      threadId: 'thread_xyz',
    };

    it('creates an opportunity record targeting the PR author', async () => {
      const result = await checkpoint.onReviewComplete(ctx);
      assert.equal(result.fired, true);
      assert.match(result.sourceId, /^review-complete:/);

      const pending = await opportunityStore.listPending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].sourceEvent, 'review-complete');
      assert.equal(pending[0].targetCatId, 'opus-47'); // targets author, not reviewer
      assert.equal(pending[0].prNumber, 2466);
    });

    it('is idempotent — same reviewer + PR does not create duplicate', async () => {
      await checkpoint.onReviewComplete(ctx);
      const result = await checkpoint.onReviewComplete(ctx);
      assert.equal(result.fired, false);

      const pending = await opportunityStore.listPending();
      assert.equal(pending.length, 1);
    });

    it('different reviewer on same PR creates separate opportunity', async () => {
      await checkpoint.onReviewComplete(ctx);
      await checkpoint.onReviewComplete({ ...ctx, reviewerCatId: 'codex' });

      const pending = await opportunityStore.listPending();
      assert.equal(pending.length, 2);
    });

    it('includes both reviewer and author in opportunity metadata', async () => {
      await checkpoint.onReviewComplete(ctx);

      const pending = await opportunityStore.listPending();
      assert.equal(pending[0].targetCatId, 'opus-47'); // author is target (visible to valid catId)
      assert.equal(pending[0].metadata.reviewerCatId, 'gpt52'); // reviewer preserved in metadata
      assert.equal(pending[0].metadata.authorCatId, 'opus-47');
    });
  });

  // ──────────────────── lifecycle: dismiss / convert ────────

  describe('lifecycle', () => {
    it('dismiss removes opportunity from pending list', async () => {
      await checkpoint.onFeatPhaseClose({
        prNumber: 100,
        repoFullName: 'r',
        authorCatId: 'opus',
        threadId: 't',
        featureId: 'F001',
        phaseLabel: 'A',
      });

      const pending = await opportunityStore.listPending();
      assert.equal(pending.length, 1);

      await opportunityStore.dismiss(pending[0].opportunityId);
      const afterDismiss = await opportunityStore.listPending();
      assert.equal(afterDismiss.length, 0);
    });

    it('markConverted tracks that proposal was created', async () => {
      await checkpoint.onFeatPhaseClose({
        prNumber: 100,
        repoFullName: 'r',
        authorCatId: 'opus',
        threadId: 't',
        featureId: 'F001',
        phaseLabel: 'A',
      });

      const pending = await opportunityStore.listPending();
      await opportunityStore.markConverted(pending[0].opportunityId, 'proposal-123');
      const afterConvert = await opportunityStore.listPending();
      assert.equal(afterConvert.length, 0);
    });
  });

  // ──────────────────── cross-event interaction ─────────────

  describe('mixed events', () => {
    it('feat-phase-close and review-complete coexist independently', async () => {
      await checkpoint.onFeatPhaseClose({
        prNumber: 100,
        repoFullName: 'r',
        authorCatId: 'opus',
        threadId: 't',
        featureId: 'F001',
        phaseLabel: 'A',
      });
      await checkpoint.onReviewComplete({
        prNumber: 100,
        repoFullName: 'r',
        reviewerCatId: 'codex',
        authorCatId: 'opus',
        threadId: 't',
      });

      const pending = await opportunityStore.listPending();
      assert.equal(pending.length, 2);
      const events = pending.map((o) => o.sourceEvent).sort();
      assert.deepEqual(events, ['feat-phase-close', 'review-complete']);
    });
  });
});
