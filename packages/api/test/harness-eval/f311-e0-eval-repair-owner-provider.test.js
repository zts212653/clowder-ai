import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createF311E0EvalRepairOwnerBindingProvider } from '../../dist/infrastructure/capability-evolution/change/f311-e0-eval-repair-owner-provider.js';

const PROGRAM_ID = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
const PROGRAM_REF = { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID };
const CYCLE_REF = { ownerFeatureId: 'F311', ownerStateRef: `evolution-cycle:${PROGRAM_ID}:1` };
const TARGET_REF = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'capability:f311-investor-roadshow-expression',
};
const INTERVENTION_REF = TARGET_REF;
const OWNER_USER_ID = 'default-user';
const PRINCIPAL = {
  invocationId: 'inv-owner-source-1',
  userId: OWNER_USER_ID,
  catId: 'codex-sol',
  threadId: 'thread-owner-source',
  originMessageId: 'message-owner-source',
};

function provider(overrides = {}) {
  const record = {
    ...PRINCIPAL,
    ownerAuthProvenance: 'strict',
    originTriggerMessageId: PRINCIPAL.originMessageId,
  };
  return createF311E0EvalRepairOwnerBindingProvider({
    repoRoot: new URL('../../../..', import.meta.url).pathname,
    ownerUserId: OWNER_USER_ID,
    programReader: {
      async get(programId) {
        assert.equal(programId, PROGRAM_ID);
        return {
          program: { programId: PROGRAM_ID, objectRef: TARGET_REF, cycle: 1 },
        };
      },
    },
    invocationRegistry: {
      async peekRecord(invocationId) {
        return invocationId === record.invocationId ? record : null;
      },
    },
    ...overrides,
  });
}

describe('F311 E0 canonical eval-repair owner provider', () => {
  it('loads the exact Program/target/value-owner refs but does not invent intervention authority', async () => {
    const bindings = await provider().resolve();
    assert.ok(bindings);

    const resolution = await bindings.resolveOwnerChangeContract({
      caseId: 'case-f311',
      verdictId: 'verdict-f311',
      featureId: 'F311',
      componentId: TARGET_REF.ownerStateRef,
      expectedTargetVersion: 'owner-binding-v1',
    });
    assert.equal(resolution.status, 'blocked');
    assert.equal(resolution.reason, 'owner_authorization_missing');
    assert.deepEqual(resolution.blockerRef, {
      ownerFeatureId: 'F311',
      ownerStateRef: `evolution-economic-certificate:${PROGRAM_ID}:v1`,
    });
  });

  it('verifies the exact strict callback record and rejects forged or missing origins', async () => {
    const bindings = await provider().resolve();
    const verified = await bindings.requestAuthorityVerifier.verify(PRINCIPAL);
    assert.equal(verified.status, 'verified');

    for (const candidate of [
      { ...PRINCIPAL, originMessageId: 'forged-message' },
      { ...PRINCIPAL, invocationId: 'missing-invocation' },
      { ...PRINCIPAL, userId: 'other-owner' },
    ]) {
      const blocked = await bindings.requestAuthorityVerifier.verify(candidate);
      assert.deepEqual(blocked, { status: 'blocked', reason: 'request_origin_unverified' });
    }
  });

  it('validates the real Program lineage but returns a typed blocker while no owner mapping exists', async () => {
    const bindings = await provider().resolve();
    const missing = await bindings.lineageResolver.resolve({
      programRef: PROGRAM_REF,
      cycleRef: CYCLE_REF,
      interventionRef: INTERVENTION_REF,
    });
    assert.deepEqual(missing, { status: 'blocked', reason: 'lineage_missing' });

    const mismatch = await bindings.lineageResolver.resolve({
      programRef: PROGRAM_REF,
      cycleRef: CYCLE_REF,
      interventionRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:other' },
    });
    assert.deepEqual(mismatch, { status: 'blocked', reason: 'lineage_mismatch' });
  });

  it('keeps fake receipts and non-owner verdicts outside every owner effect', async () => {
    const bindings = await provider().resolve();
    const receiptRef = { ownerFeatureId: 'F311', ownerStateRef: 'owner-receipt:forged' };
    assert.equal(await bindings.interventionReceiptOwner.resolve(receiptRef), null);
    assert.equal(await bindings.freshOutcomeOwner.resolve(receiptRef), null);

    const directOwner = await bindings.valueDecisionAuthorityVerifier.verify(
      { kind: 'owner_session', userId: OWNER_USER_ID },
      {
        programRef: PROGRAM_REF,
        cycleRef: CYCLE_REF,
        caseRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-case:case-f311' },
        proposalRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-proposal:proposal-f311' },
        outcomeReceiptRef: receiptRef,
      },
    );
    assert.equal(directOwner.status, 'verified');

    const nonOwner = await bindings.valueDecisionAuthorityVerifier.verify(
      { kind: 'owner_session', userId: 'attacker' },
      {
        programRef: PROGRAM_REF,
        cycleRef: CYCLE_REF,
        caseRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-case:case-f311' },
        proposalRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-proposal:proposal-f311' },
        outcomeReceiptRef: receiptRef,
      },
    );
    assert.deepEqual(nonOwner, { status: 'blocked', reason: 'value_owner_unverified' });

    const decision = await bindings.decisionOwner.execute({
      programRef: PROGRAM_REF,
      cycleRef: CYCLE_REF,
      caseRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-case:case-f311' },
      proposalRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-proposal:proposal-f311' },
      outcomeReceiptRef: receiptRef,
      decision: 'keep',
      clientMessageId: 'decision-1',
      idempotencyRef: 'eval-repair-metabolism:proposal-f311:receipt',
      decisionAuthorityRef: directOwner.authorityRef,
    });
    assert.deepEqual(decision, { status: 'blocked', reason: 'owner_authorization_missing' });
  });
});
