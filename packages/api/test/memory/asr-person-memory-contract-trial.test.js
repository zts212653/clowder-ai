import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contractTrialFixture as fixture } from './asr-person-memory-contract-fixture.js';

describe('ASR → F276 opportunity lifecycle', () => {
  it('projects the six runtime trace dimensions without source or person payloads', async () => {
    const { memoryContractTrialTraceAttributes } = await import(
      '../../dist/domains/memory/people/AsrPersonMemoryContractTrial.js'
    );
    const events = [
      { stage: 'eligible', outcome: 'admitted' },
      { stage: 'delivered', outcome: 'delivered' },
      { stage: 'omitted', outcome: 'omitted' },
      { stage: 'disposition', outcome: 'recorded', disposition: 'defer' },
      { stage: 'error', outcome: 'scope_revoked' },
      { stage: 'burden', outcome: 'owner_approval_requested', units: 1 },
    ];
    const attributes = events.map(memoryContractTrialTraceAttributes);
    assert.deepEqual(
      attributes.map((item) => item['memory.contract.stage']),
      ['eligible', 'delivered', 'omitted', 'disposition', 'error', 'burden'],
    );
    assert.equal(attributes[3]['memory.contract.disposition'], 'defer');
    assert.equal(attributes[5]['memory.contract.burden_units'], 1);
    assert.doesNotMatch(JSON.stringify(attributes), /owner-1|speaker|transcript|sourceRevision/);
  });

  it('requires authoritative delivery evidence before exactly one disposition', async () => {
    const { scene, trace, trial } = await fixture();
    let state = trial.admit(scene, {
      now: 1_200,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      consumerCatId: 'codex-sol',
      predicateRevision: 1,
      aclAllowed: true,
      terminalGenerationKeys: new Set(),
    });
    assert.equal(state.status, 'eligible');

    const beforeDelivery = trial.recordDisposition(state, {
      v: 1,
      opportunityId: scene.opportunity.opportunityId,
      generation: 1,
      disposition: 'abstain',
      reasonCode: 'not_continuity_valued',
      recordedAt: 1_250,
    });
    assert.equal(beforeDelivery.status, 'rejected');
    assert.equal(beforeDelivery.reason, 'delivery_required');

    const presented = trial.recordPresentation(state, {
      kind: 'f296_opportunity_presentation_v1',
      outcome: 'delivered',
      continuityDispositionRef: 'continuity-1',
      generationId: `sha256:${'a'.repeat(64)}`,
      evidenceRef: 'presentation-1',
      occurredAt: 1_260,
    });
    assert.equal(presented.status, 'transitioned');
    state = presented.state;
    assert.equal(state.status, 'delivered');

    const disposed = trial.recordDisposition(state, {
      v: 1,
      opportunityId: scene.opportunity.opportunityId,
      generation: 1,
      disposition: 'propose',
      recordedAt: 1_300,
      destination: {
        proposalContract: 'F276.CaptureCandidate.v1',
        proposalId: 'person_candidate_1',
      },
    });
    assert.equal(disposed.status, 'transitioned');
    assert.equal(disposed.state.status, 'disposed');
    assert.equal(trial.recordDisposition(disposed.state, disposed.state.disposition).reason, 'already_disposed');
    assert.deepEqual(
      trace.events.map((event) => event.stage),
      ['eligible', 'error', 'delivered', 'disposition', 'burden', 'error'],
    );
  });

  it('fails closed on freshness, token-drop, or body-signature heuristics', async () => {
    const { scene, trace, trial } = await fixture({ presentationVerifier: undefined });
    const state = trial.admit(scene, {
      now: 1_200,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      consumerCatId: 'codex-sol',
      predicateRevision: 1,
      aclAllowed: true,
      terminalGenerationKeys: new Set(),
    });
    for (const evidence of [{ messageFresh: true }, { tokenDrop: 0.8 }, { bodySignature: '[continue]' }]) {
      const result = trial.recordPresentation(state, evidence);
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason, 'continuity_authority_unavailable');
    }
    assert.equal(trace.events.filter((event) => event.stage === 'delivered').length, 0);
  });

  it('records authoritative omission separately and requires delivered evidence for abstention', async () => {
    const { scene, trace, trial } = await fixture();
    const eligible = trial.admit(scene, {
      now: 1_200,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      consumerCatId: 'codex-sol',
      predicateRevision: 1,
      aclAllowed: true,
      terminalGenerationKeys: new Set(),
    });
    const omitted = trial.recordPresentation(eligible, {
      kind: 'f296_opportunity_presentation_v1',
      outcome: 'omitted',
      continuityDispositionRef: 'continuity-omitted-1',
      generationId: `sha256:${'b'.repeat(64)}`,
      evidenceRef: 'omission-1',
      occurredAt: 1_260,
    });
    assert.equal(omitted.status, 'transitioned');
    assert.equal(omitted.state.status, 'omitted');
    assert.equal(
      trial.recordDisposition(omitted.state, {
        v: 1,
        opportunityId: scene.opportunity.opportunityId,
        generation: 1,
        disposition: 'abstain',
        reasonCode: 'not_continuity_valued',
        recordedAt: 1_300,
      }).reason,
      'delivery_required',
    );
    assert.deepEqual(
      trace.events.map((event) => event.stage),
      ['eligible', 'omitted', 'error'],
    );
  });

  it('treats abstain as an explicit terminal disposition with no destination proposal', async () => {
    const { scene, trace, trial } = await fixture();
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
      continuityDispositionRef: 'continuity-abstain-1',
      generationId: `sha256:${'c'.repeat(64)}`,
      evidenceRef: 'presentation-abstain-1',
      occurredAt: 1_260,
    }).state;
    const abstained = trial.recordDisposition(delivered, {
      v: 1,
      opportunityId: scene.opportunity.opportunityId,
      generation: 1,
      disposition: 'abstain',
      reasonCode: 'not_continuity_valued',
      recordedAt: 1_300,
    });
    assert.equal(abstained.status, 'transitioned');
    assert.equal(abstained.state.disposition.disposition, 'abstain');
    assert.equal(
      await trial.readDestinationOutcome(abstained.state, { getStatus: async () => null }).then((x) => x.status),
      'not_available',
    );
    assert.equal(
      trace.events.some((event) => event.stage === 'burden'),
      false,
    );
  });

  it('projects approve/reject/not-now from the canonical F276 proposal reader without treating approval as delivery', async () => {
    const { scene, trace, trial } = await fixture();
    const state = {
      status: 'disposed',
      scene,
      disposition: {
        v: 1,
        opportunityId: scene.opportunity.opportunityId,
        generation: 1,
        disposition: 'propose',
        recordedAt: 1_300,
        destination: {
          proposalContract: 'F276.CaptureCandidate.v1',
          proposalId: 'person_candidate_1',
        },
      },
    };
    for (const [canonicalStatus, expected] of [
      ['materialized', 'approved'],
      ['rejected', 'rejected'],
      ['not_now', 'not_now'],
    ]) {
      assert.deepEqual(
        await trial.readDestinationOutcome(state, {
          getStatus: async () => ({ status: canonicalStatus, proposalId: 'person_candidate_1' }),
        }),
        { status: expected, proposalId: 'person_candidate_1' },
      );
    }
    assert.equal(
      trace.events.some((event) => event.stage === 'delivered'),
      false,
    );
  });
});
