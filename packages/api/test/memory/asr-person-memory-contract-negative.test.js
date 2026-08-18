import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contractTrialFixture as fixture } from './asr-person-memory-contract-fixture.js';

describe('ASR → F276 opportunity invalidation and re-entry', () => {
  it('fails closed on invalid scenes, author/scope drift, predicate drift, ACL loss, expiry, and dedupe', async () => {
    const cases = [
      [{}, 'invalid_scene', 'rejected'],
      [{ ownerUserId: 'other-owner' }, 'scope_mismatch', 'invalidated'],
      [{ threadId: 'other-thread' }, 'scope_mismatch', 'invalidated'],
      [{ predicateRevision: 2 }, 'predicate_revision_mismatch', 'invalidated'],
      [{ aclAllowed: false }, 'scope_revoked', 'invalidated'],
    ];
    for (const [override, reason, expectedStatus] of cases) {
      const { scene, trace, trial } = await fixture();
      const result = trial.admit(reason === 'invalid_scene' ? override : scene, {
        now: 1_200,
        ownerUserId: 'owner-1',
        threadId: 'thread-1',
        consumerCatId: 'codex-sol',
        predicateRevision: 1,
        aclAllowed: true,
        terminalGenerationKeys: new Set(),
        ...override,
      });
      assert.equal(result.status, expectedStatus);
      assert.equal(reason === 'invalid_scene' ? result.reason : trace.events.at(-1).outcome, reason);
    }

    const { scene, trace, trial } = await fixture();
    const expired = trial.admit(scene, {
      now: scene.opportunity.expiresAt,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      consumerCatId: 'codex-sol',
      predicateRevision: 1,
      aclAllowed: true,
      terminalGenerationKeys: new Set(),
    });
    assert.equal(expired.status, 'expired');
    assert.equal(trace.events.at(-1).stage, 'omitted');
    const duplicate = trial.admit(scene, {
      now: 1_200,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      consumerCatId: 'codex-sol',
      predicateRevision: 1,
      aclAllowed: true,
      terminalGenerationKeys: new Set([`${scene.opportunity.dedupeLineage}:1`]),
    });
    assert.equal(duplicate.status, 'invalidated');
    assert.equal(trace.events.at(-1).outcome, 'duplicate_generation');
  });

  it('re-enters defer only after the predicate, on current source/ACL, before expiry, once per generation', async () => {
    const { scene, trial } = await fixture();
    const eligible = trial.admit(scene, {
      now: 1_200,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      consumerCatId: 'codex-sol',
      predicateRevision: 1,
      aclAllowed: true,
      terminalGenerationKeys: new Set(),
    });
    const delivered = trial.recordPresentation(eligible, {
      kind: 'f296_opportunity_presentation_v1',
      outcome: 'delivered',
      continuityDispositionRef: 'continuity-1',
      generationId: `sha256:${'a'.repeat(64)}`,
      evidenceRef: 'presentation-1',
      occurredAt: 1_250,
    }).state;
    const deferred = trial.recordDisposition(delivered, {
      v: 1,
      opportunityId: scene.opportunity.opportunityId,
      generation: 1,
      disposition: 'defer',
      recordedAt: 1_300,
      destination: {
        receiptContract: 'StandingReflex.DeferredWriteOpportunityReceipt.v1',
        receiptId: `deferred_person_${'d'.repeat(32)}`,
      },
    });
    assert.equal(deferred.status, 'transitioned');
    assert.doesNotMatch(JSON.stringify(deferred.receipt), /private transcript/);

    const context = {
      now: deferred.receipt.eligibleAt,
      reason: 'eligible_owner_context',
      aclAllowed: true,
      sourceRevision: scene.opportunity.sourceCoordinates[0].sourceRevision,
      attributionRevision: scene.opportunity.sourceCoordinates[0].speaker.attributionRevision,
      terminalGenerationKeys: new Set(),
    };
    assert.equal(
      trial.reenterDeferred(deferred.receipt, scene.opportunity, { ...context, now: context.now - 1 }).reason,
      'not_yet_eligible',
    );
    const reentered = trial.reenterDeferred(deferred.receipt, scene.opportunity, context);
    assert.equal(reentered.status, 'reentered');
    assert.equal(reentered.scene.opportunity.generation, 2);
    assert.equal(reentered.scene.opportunity.dedupeLineage, scene.opportunity.dedupeLineage);
    assert.notEqual(reentered.scene.opportunity.opportunityId, scene.opportunity.opportunityId);

    for (const state of ['reentered', 'invalidated', 'expired']) {
      assert.equal(
        trial.reenterDeferred({ ...deferred.receipt, state }, scene.opportunity, context).reason,
        'receipt_not_deferred',
      );
    }
    assert.equal(
      trial.reenterDeferred(
        { ...deferred.receipt, expiresAt: deferred.receipt.expiresAt + 1 },
        scene.opportunity,
        context,
      ).reason,
      'invalid_lineage',
    );
    assert.equal(
      trial.reenterDeferred(
        {
          ...deferred.receipt,
          sourceRefs: deferred.receipt.sourceRefs.map((ref) => ({ ...ref, artifactId: 'other-artifact' })),
        },
        scene.opportunity,
        context,
      ).reason,
      'invalid_lineage',
    );

    const failures = [
      [{ ...context, sourceRevision: `sha256:${'0'.repeat(64)}` }, 'source_revision_mismatch'],
      [{ ...context, attributionRevision: `sha256:${'0'.repeat(64)}` }, 'source_revision_mismatch'],
      [{ ...context, aclAllowed: false }, 'scope_revoked'],
      [{ ...context, reason: 'timer_elapsed' }, 'rearm_predicate_not_met'],
      [
        { ...context, terminalGenerationKeys: new Set([`${scene.opportunity.dedupeLineage}:2`]) },
        'duplicate_generation',
      ],
      [{ ...context, now: deferred.receipt.expiresAt }, 'expired'],
    ];
    for (const [candidateContext, reason] of failures) {
      assert.equal(trial.reenterDeferred(deferred.receipt, scene.opportunity, candidateContext).reason, reason);
    }
  });
});
