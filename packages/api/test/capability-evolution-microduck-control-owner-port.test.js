import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { createMicroduckControlOwnerPort } from '../dist/infrastructure/capability-evolution/adapters/microduck-control-owner-port.js';
import { createMicroduckControlSlotOwner } from '../dist/infrastructure/capability-evolution/adapters/microduck-control-slot-owner.js';
import { createMicroduckOwnerAdapter } from '../dist/infrastructure/capability-evolution/adapters/microduck-owner-adapter.js';
import {
  cycleRef,
  evaluationReceiptRef,
  controlOwnerFixture as fixture,
  objectRef,
  ownerRef,
  programRef,
  scope,
  controlWritebackInput as writebackInput,
} from './helpers/microduck-control-owner-fixture.js';

describe('F311 Microduck control owner port', () => {
  it('keeps the durable slot untouched until exact permission and F246 approval both resolve', async (t) => {
    const { candidate, contract, owner, slotOwner, statePath } = await fixture(t);
    const current = await slotOwner.readCurrent();
    const blockedAdapter = createMicroduckOwnerAdapter({
      owner,
      credentialBoundary: {
        async authorize() {
          return { status: 'blocked', code: 'permission_missing' };
        },
      },
      approvalResolver: {
        async resolve() {
          throw new Error('permission must fail first');
        },
      },
      proposalResolver: {
        async resolve() {
          return { status: 'blocked', code: 'approval_missing' };
        },
      },
    });

    assert.deepEqual(
      await blockedAdapter.writeback(writebackInput(current, candidate, contract.verificationReceiptRef)),
      { status: 'blocked', code: 'permission_missing' },
    );
    assert.equal((await slotOwner.readCurrent()).targetVersionRef.version, current.targetVersionRef.version);
    await assert.rejects(stat(statePath), { code: 'ENOENT' });

    const approvedInput = writebackInput(current, candidate, contract.verificationReceiptRef, 'deploy-approved');
    const approvedAdapter = createMicroduckOwnerAdapter({
      owner,
      credentialBoundary: {
        async authorize(input) {
          return { status: 'authorized', permissionRef: input.permissionRef, targetVersionRef: input.targetVersionRef };
        },
      },
      approvalResolver: {
        async resolve() {
          return {
            status: 'approved',
            approvalRef: approvedInput.approvalRef,
            proposalRef: approvedInput.proposalRef,
            programRef,
            cycleRef,
            interventionRef: objectRef,
            targetVersionRef: current.targetVersionRef,
          };
        },
      },
      proposalResolver: {
        async resolve() {
          return { status: 'blocked', code: 'approval_missing' };
        },
      },
    });
    const deployed = await approvedAdapter.writeback(approvedInput);
    assert.equal(deployed.status, 'deployed');
    assert.equal(deployed.deployedVersionRef.version, candidate.artifactVersionRef.version);
  });

  it('reads the deployed bytes in a fresh owner, verifies fresh outcome, and restores exact baseline bytes', async (t) => {
    const loadedCalls = [];
    const freshOutcomeRef = ownerRef(`fresh-outcome:sha256:${'c'.repeat(64)}`);
    const restoreOutcomeRef = ownerRef(`restore-outcome:sha256:${'e'.repeat(64)}`);
    const loadedOutcomeRunner = {
      async collect(input) {
        loadedCalls.push(input);
        return input.mode === 'post_writeback'
          ? {
              status: 'fresh',
              outcomeReceiptRef: freshOutcomeRef,
              freshnessProofRef: ownerRef(`freshness-proof:sha256:${'d'.repeat(64)}`),
              deployedVersionRef: input.targetVersionRef,
              deployedArtifactSha256: input.version.artifactVersionRef.version,
              measuredAt: '2026-09-07T06:05:00.000Z',
            }
          : {
              status: 'restore_verified',
              outcomeReceiptRef: restoreOutcomeRef,
              freshnessProofRef: ownerRef(`freshness-proof:sha256:${'f'.repeat(64)}`),
              restoredVersionRef: input.version.artifactVersionRef,
              restoredArtifactSha256: input.version.artifactVersionRef.version,
              measuredAt: '2026-09-07T06:10:00.000Z',
            };
      },
    };
    const { baseline, candidate, contract, dataDir, owner, slotOwner } = await fixture(t, {
      loadedOutcomeRunner,
    });
    const current = await slotOwner.readCurrent();
    const deployed = await owner.writeback(writebackInput(current, candidate, contract.verificationReceiptRef));
    assert.equal(deployed.status, 'deployed');

    const reloadedSlot = createMicroduckControlSlotOwner({ dataDir });
    const reloadedOwner = createMicroduckControlOwnerPort({
      programRef,
      objectRef,
      baselineVersionRef: baseline.artifactVersionRef,
      slotOwner: reloadedSlot,
      resolveCandidate: async () => contract,
      loadedOutcomeRunner,
    });
    const fresh = await reloadedOwner.collectFreshOutcome({
      ...scope,
      deployedVersionRef: deployed.deployedVersionRef,
      writebackReceiptRef: deployed.writebackReceiptRef,
    });
    assert.equal(fresh.status, 'fresh');
    assert.equal(loadedCalls[0].mode, 'post_writeback');
    assert.deepEqual(loadedCalls[0].operationReceiptRef, deployed.writebackReceiptRef);
    assert.deepEqual(loadedCalls[0].targetVersionRef, deployed.deployedVersionRef);
    assert.deepEqual(Buffer.from(loadedCalls[0].version.configBytes), candidate.configBytes);
    assert.deepEqual(loadedCalls[0].version.evaluationReceiptRef, candidate.evaluationReceiptRef);

    const wrongReceipt = await reloadedOwner.rollback({
      ...scope,
      targetVersionRef: deployed.deployedVersionRef,
      deployedVersionRef: deployed.deployedVersionRef,
      rollbackVersionRef: baseline.artifactVersionRef,
      permissionRef: ownerRef('permission:simulator:walking:control-v1', 'b'.repeat(64)),
      writebackReceiptRef: ownerRef(`deploy:sha256:${'e'.repeat(64)}`),
      clientMessageId: 'restore-wrong-receipt',
    });
    assert.deepEqual(wrongReceipt, { status: 'blocked', code: 'rollback_failed' });
    assert.equal((await reloadedSlot.readCurrent()).targetVersionRef.version, candidate.artifactVersionRef.version);

    const restored = await reloadedOwner.rollback({
      ...scope,
      targetVersionRef: deployed.deployedVersionRef,
      deployedVersionRef: deployed.deployedVersionRef,
      rollbackVersionRef: baseline.artifactVersionRef,
      permissionRef: ownerRef('permission:simulator:walking:control-v1', 'b'.repeat(64)),
      writebackReceiptRef: deployed.writebackReceiptRef,
      referenceFreshOutcomeRef: fresh.outcomeReceiptRef,
      clientMessageId: 'restore-baseline',
    });
    assert.equal(restored.status, 'rolled_back');
    assert.deepEqual(Buffer.from((await reloadedSlot.readCurrent()).version.configBytes), baseline.configBytes);
    assert.deepEqual(restored.restoreOutcomeRef, restoreOutcomeRef);
    assert.equal(loadedCalls[1].mode, 'post_rollback');
    assert.deepEqual(loadedCalls[1].operationReceiptRef, restored.rollbackReceiptRef);
    assert.deepEqual(loadedCalls[1].deploymentReceiptRef, deployed.writebackReceiptRef);
    assert.deepEqual(loadedCalls[1].referenceFreshOutcomeRef, fresh.outcomeReceiptRef);
    assert.deepEqual(Buffer.from(loadedCalls[1].version.configBytes), baseline.configBytes);
    assert.deepEqual(loadedCalls[1].version.evaluationReceiptRef, baseline.evaluationReceiptRef);

    const restoredTarget = await reloadedSlot.readCurrent();
    const redeployed = await reloadedOwner.writeback(
      writebackInput(restoredTarget, candidate, contract.verificationReceiptRef, 'redeploy-candidate'),
    );
    assert.equal(redeployed.status, 'deployed');
    assert.notDeepEqual(redeployed.writebackReceiptRef, deployed.writebackReceiptRef);
    assert.deepEqual(
      await reloadedOwner.collectFreshOutcome({
        ...scope,
        deployedVersionRef: redeployed.deployedVersionRef,
        writebackReceiptRef: deployed.writebackReceiptRef,
      }),
      { status: 'blocked', code: 'fresh_outcome_missing' },
    );
    assert.deepEqual(
      await reloadedOwner.rollback({
        ...scope,
        targetVersionRef: redeployed.deployedVersionRef,
        deployedVersionRef: redeployed.deployedVersionRef,
        rollbackVersionRef: baseline.artifactVersionRef,
        permissionRef: ownerRef('permission:simulator:walking:control-v1', 'b'.repeat(64)),
        writebackReceiptRef: deployed.writebackReceiptRef,
        referenceFreshOutcomeRef: fresh.outcomeReceiptRef,
        clientMessageId: 'restore-stale-receipt',
      }),
      { status: 'blocked', code: 'rollback_failed' },
    );
  });

  it('propagates an incomplete holdout without touching owner state', async (t) => {
    const blocked = { status: 'blocked', code: 'holdout_incomplete' };
    const { candidate, contract, owner, slotOwner, statePath } = await fixture(t, {
      resolveCandidate: async () => blocked,
    });
    const current = await slotOwner.readCurrent();
    assert.deepEqual(
      await owner.resolveVerification({
        ...scope,
        candidateVersionRef: candidate.artifactVersionRef,
        evaluationReceiptRef,
        verificationReceiptRef: contract.verificationReceiptRef,
      }),
      blocked,
    );
    assert.deepEqual(
      await owner.writeback(writebackInput(current, candidate, contract.verificationReceiptRef)),
      blocked,
    );
    assert.equal((await slotOwner.readCurrent()).targetVersionRef.version, current.targetVersionRef.version);
    await assert.rejects(stat(statePath), { code: 'ENOENT' });
  });
});
