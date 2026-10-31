import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contractTrialFixture } from './asr-person-memory-contract-fixture.js';

const RECEIPT_ID = `deferred_person_${'a'.repeat(32)}`;

/** Project the fixture scene into the persisted delivered record the callback path consumes. */
async function deliveredFixture(overrides = {}) {
  const { scene, trial, trace } = await contractTrialFixture();
  const { projectDeliveredWriteOpportunityRecord } = await import('@cat-cafe/shared');
  const record = projectDeliveredWriteOpportunityRecord(scene.opportunity, {
    ownerUserId: scene.opportunity.scope.ownerUserId,
    threadId: scene.opportunity.scope.threadId,
    consumerCatId: scene.opportunity.consumer.catId,
    invocationId: 'invocation-1',
    presentedAt: scene.opportunity.eligibleAt + 10,
    generationId: `sha256:${'e'.repeat(64)}`,
    evidenceRef: `context-delivery:invocation-1:sha256:${'e'.repeat(64)}`,
    continuityDispositionRef: 'continuity:invocation-1',
    ...overrides,
  });
  return { scene, trial, trace, record };
}

const disposition = (record, overrides = {}) => ({
  v: 1,
  opportunityId: record.opportunityId,
  generation: record.generation,
  recordedAt: record.presentedAt + 5,
  disposition: 'propose',
  destination: { proposalContract: 'F276.CaptureCandidate.v1', proposalId: 'person_candidate_1' },
  ...overrides,
});

describe('delivered-record disposition path', () => {
  it('records propose without needing the in-invocation lifecycle state', async () => {
    const { trial, record, trace } = await deliveredFixture();
    const result = trial.recordDeliveredDisposition(record, disposition(record));
    assert.equal(result.status, 'recorded');
    assert.equal(result.disposition.disposition, 'propose');
    assert.equal(result.receipt, undefined);
    // propose must still charge exactly one unit of owner approval burden
    assert.ok(trace.events.some((event) => event.stage === 'burden' && event.units === 1));
  });

  it('mints a content-free deferred receipt carrying the same lineage', async () => {
    const { trial, record } = await deliveredFixture();
    const result = trial.recordDeliveredDisposition(
      record,
      disposition(record, {
        disposition: 'defer',
        destination: {
          receiptContract: 'StandingReflex.DeferredWriteOpportunityReceipt.v1',
          receiptId: RECEIPT_ID,
        },
      }),
    );
    assert.equal(result.status, 'recorded');
    assert.equal(result.receipt.dedupeLineage, record.dedupeLineage);
    assert.equal(result.receipt.generation, record.generation);
    assert.equal(result.receipt.destinationProposalContract, 'F276.CaptureCandidate.v1');
    assert.equal(result.receipt.state, 'deferred');
    // The receipt must not carry transcript payload: only artifact/revision/offset coordinates.
    const serialized = JSON.stringify(result.receipt);
    assert.doesNotMatch(serialized, /Alden|黄挺|speaker-/);
  });

  it('rejects a disposition naming a different opportunity or generation', async () => {
    const { trial, record } = await deliveredFixture();
    assert.equal(
      trial.recordDeliveredDisposition(record, disposition(record, { opportunityId: `write_opp_${'9'.repeat(32)}` }))
        .reason,
      'disposition_lineage_mismatch',
    );
    assert.equal(
      trial.recordDeliveredDisposition(record, disposition(record, { generation: 7 })).reason,
      'disposition_lineage_mismatch',
    );
  });

  it('rejects a disposition dated before delivery or at/after expiry', async () => {
    const { trial, record } = await deliveredFixture();
    assert.equal(
      trial.recordDeliveredDisposition(record, disposition(record, { recordedAt: record.presentedAt - 1 })).reason,
      'disposition_lineage_mismatch',
    );
    assert.equal(
      trial.recordDeliveredDisposition(record, disposition(record, { recordedAt: record.expiresAt })).reason,
      'disposition_lineage_mismatch',
    );
  });

  it('rejects a malformed disposition rather than coercing it', async () => {
    const { trial, record } = await deliveredFixture();
    assert.equal(
      trial.recordDeliveredDisposition(record, { v: 1, disposition: 'maybe' }).reason,
      'invalid_disposition',
    );
    // abstain carrying a proposal destination is a contract violation, not a propose
    assert.equal(
      trial.recordDeliveredDisposition(
        record,
        disposition(record, { disposition: 'abstain', reasonCode: 'not_continuity_valued' }),
      ).reason,
      'invalid_disposition',
    );
  });

  it('agrees with the in-invocation state path on the same disposition', async () => {
    // Guards against the two paths drifting apart: they must share one predicate set.
    const { trial, record, scene } = await deliveredFixture();
    const admitted = trial.admit(scene, {
      now: scene.opportunity.eligibleAt,
      ownerUserId: scene.opportunity.scope.ownerUserId,
      threadId: scene.opportunity.scope.threadId,
      consumerCatId: scene.opportunity.consumer.catId,
      predicateRevision: 1,
      aclAllowed: true,
      terminalGenerationKeys: new Set(),
    });
    const presented = trial.recordPresentation(admitted, {
      kind: 'f296_opportunity_presentation_v1',
      outcome: 'delivered',
      continuityDispositionRef: 'continuity:invocation-1',
      generationId: `sha256:${'e'.repeat(64)}`,
      evidenceRef: `context-delivery:invocation-1:sha256:${'e'.repeat(64)}`,
      occurredAt: record.presentedAt,
    });
    assert.equal(presented.status, 'transitioned');

    const candidate = disposition(record, {
      disposition: 'defer',
      destination: {
        receiptContract: 'StandingReflex.DeferredWriteOpportunityReceipt.v1',
        receiptId: RECEIPT_ID,
      },
    });
    const viaState = trial.recordDisposition(presented.state, candidate);
    const viaRecord = trial.recordDeliveredDisposition(record, candidate);

    assert.equal(viaState.status, 'transitioned');
    assert.equal(viaRecord.status, 'recorded');
    assert.deepEqual(viaState.receipt, viaRecord.receipt);

    // And both reject an out-of-window disposition identically.
    const late = disposition(record, { recordedAt: record.expiresAt + 1 });
    assert.equal(trial.recordDisposition(presented.state, late).reason, 'disposition_lineage_mismatch');
    assert.equal(trial.recordDeliveredDisposition(record, late).reason, 'disposition_lineage_mismatch');
  });
});
