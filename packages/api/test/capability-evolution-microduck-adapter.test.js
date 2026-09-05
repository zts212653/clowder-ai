import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MICRODUCK_OWNER_FEATURE_ID } from '../dist/infrastructure/capability-evolution/adapters/microduck-owner-adapter.js';
import {
  approvalRef,
  candidateVersionRef,
  deployedVersionRef,
  evaluationReceiptRef,
  exactBase,
  interventionRef,
  makeHarness,
  permissionRef,
  rollbackVersionRef,
  shaA,
  shaB,
  showState,
  targetVersionRef,
  verificationReceiptRef,
} from './helpers/microduck-owner-harness.js';

function writebackInput(clientMessageId) {
  return {
    ...exactBase(),
    targetVersionRef,
    candidateVersionRef,
    proposalRef: showState().approvalProposalRef,
    interventionRef,
    permissionRef,
    verificationReceiptRef,
    approvalRef,
    clientMessageId,
  };
}

describe('F311 Microduck external owner adapter', () => {
  it('fails closed on target drift before permission or mutation side effects', async () => {
    const drifted = { ...targetVersionRef, version: 'space-revision-2' };
    const { adapter, calls } = makeHarness({
      owner: {
        async observe() {
          return {
            status: 'observed',
            targetVersionRef: drifted,
            baselineVersionRef: rollbackVersionRef,
            observationRefs: [],
          };
        },
      },
    });

    const result = await adapter.mutate({
      ...exactBase(),
      targetVersionRef,
      permissionRef,
      interventionRef: { ownerFeatureId: 'F267', ownerStateRef: 'intervention:walking-robustness-v1' },
      clientMessageId: 'mutation-1',
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'target_drift');
    assert.equal('blockerRef' in result, false);
    assert.deepEqual(calls, { authorize: 0, launchMutation: 0, writeback: 0, rollback: 0, collectFreshOutcome: 0 });
  });

  it('keeps a missing credential inside the credential boundary and starts no Job', async () => {
    const { adapter, calls } = makeHarness({
      credentialBoundary: {
        async authorize() {
          calls.authorize += 1;
          return {
            status: 'blocked',
            code: 'permission_missing',
            blockerRef: { ownerFeatureId: 'F202', ownerStateRef: 'permission-blocker:huggingface-token-missing' },
          };
        },
      },
    });

    const result = await adapter.mutate({
      ...exactBase(),
      targetVersionRef,
      permissionRef,
      interventionRef: { ownerFeatureId: 'F267', ownerStateRef: 'intervention:walking-robustness-v1' },
      clientMessageId: 'mutation-2',
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'permission_missing');
    assert.equal(JSON.stringify(result).includes('token'), false);
    assert.equal(calls.launchMutation, 0);
  });

  it('rejects credential-bearing or malformed owner responses instead of trusting structural lookalikes', async () => {
    const credentialLeak = makeHarness({
      credentialBoundary: {
        async authorize() {
          return { status: 'authorized', permissionRef, targetVersionRef, secret: 'hf_not_allowed' };
        },
      },
    });
    const mutation = await credentialLeak.adapter.mutate({
      ...exactBase(),
      targetVersionRef,
      permissionRef,
      interventionRef: { ownerFeatureId: 'F267', ownerStateRef: 'intervention:walking-robustness-v1' },
      clientMessageId: 'mutation-secret-lookalike',
    });
    assert.deepEqual(mutation, { status: 'blocked', code: 'permission_missing' });
    assert.equal(credentialLeak.calls.launchMutation, 0);

    const malformedReceipt = makeHarness({
      owner: {
        async resolveVerification() {
          return {
            status: 'verified',
            evaluationReceiptRef,
            verificationReceiptRef,
            candidateVersionRef,
            evaluatedArtifactSha256: shaA,
            publicEvaluationComplete: true,
            holdoutEvaluationComplete: 'false',
            holdoutSealed: true,
            holdoutOptimizerExposed: false,
            singleVariable: true,
          };
        },
      },
    });
    const verification = await malformedReceipt.adapter.verify({
      ...exactBase(),
      candidateVersionRef,
      evaluationReceiptRef,
      artifactSha256: shaA,
    });
    assert.deepEqual(verification, { status: 'blocked', code: 'verification_missing' });
  });

  it('rejects incomplete, leaked or artifact-mismatched holdout receipts', async () => {
    for (const [override, code] of [
      [{ holdoutEvaluationComplete: false }, 'holdout_incomplete'],
      [{ holdoutOptimizerExposed: true }, 'holdout_leakage'],
      [
        {
          holdoutSealedProofRef: {
            ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
            ownerStateRef: 'https://example.invalid/claimed-proof',
          },
        },
        'holdout_leakage',
      ],
      [{ singleVariable: false }, 'multiple_variables'],
      [{ evaluatedArtifactSha256: shaB }, 'artifact_hash_mismatch'],
    ]) {
      const { adapter } = makeHarness({
        owner: {
          async resolveVerification() {
            return {
              status: 'verified',
              evaluationReceiptRef,
              verificationReceiptRef,
              candidateVersionRef,
              evaluatedArtifactSha256: shaA,
              publicEvaluationComplete: true,
              holdoutEvaluationComplete: true,
              holdoutSealed: true,
              holdoutSealedProofRef: {
                ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
                ownerStateRef: `evaluation-proof:sha256:${shaA}`,
              },
              holdoutOptimizerExposed: false,
              optimizerExposureProofRef: {
                ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
                ownerStateRef: `exposure-proof:sha256:${shaB}`,
              },
              singleVariable: true,
              ...override,
            };
          },
        },
      });
      const result = await adapter.verify({
        ...exactBase(),
        candidateVersionRef,
        evaluationReceiptRef,
        artifactSha256: shaA,
      });
      assert.equal(result.status, 'blocked');
      assert.equal(result.code, code);
    }
  });

  it('requires canonical F246 Approval before writeback', async () => {
    const { adapter, calls } = makeHarness();
    const result = await adapter.writeback({
      ...writebackInput('writeback-without-f246'),
      approvalRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'approval:caller-invented' },
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'approval_missing');
    assert.equal(calls.writeback, 0);
  });

  it('compensates a deployed artifact mismatch with owner rollback and never reports adoption', async () => {
    const { adapter, calls } = makeHarness({
      owner: {
        async writeback() {
          calls.writeback += 1;
          return {
            status: 'deployed',
            writebackReceiptRef: {
              ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
              ownerStateRef: `deploy:sha256:${shaB}`,
            },
            deployedVersionRef,
            rollbackVersionRef,
            deployedArtifactSha256: shaB,
            deployedAt: '2026-09-04T01:00:00.000Z',
          };
        },
      },
    });

    const result = await adapter.writeback(writebackInput('writeback-bad-hash'));

    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'artifact_hash_mismatch');
    assert.equal(result.recoveryRef.ownerStateRef, `rollback-receipt:sha256:${shaA}`);
    assert.equal(calls.writeback, 1);
    assert.equal(calls.rollback, 1);
  });

  it('compensates a write to the wrong owner asset surface as target drift', async () => {
    const { adapter, calls } = makeHarness({
      owner: {
        async writeback() {
          calls.writeback += 1;
          return {
            status: 'deployed',
            writebackReceiptRef: {
              ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
              ownerStateRef: `deploy:sha256:${shaA}`,
            },
            deployedVersionRef: { ...deployedVersionRef, assetId: 'another-policy-slot' },
            rollbackVersionRef,
            deployedArtifactSha256: shaA,
            deployedAt: '2026-09-04T01:00:00.000Z',
          };
        },
      },
    });
    const result = await adapter.writeback(writebackInput('writeback-wrong-target'));

    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'target_drift');
    assert.equal(calls.writeback, 1);
    assert.equal(calls.rollback, 1);
  });

  it('does not smuggle writeback authority into rollback when compensation lacks permission', async () => {
    const { adapter, calls } = makeHarness({
      credentialBoundary: {
        async authorize(input) {
          return input.operation === 'rollback'
            ? { status: 'blocked', code: 'permission_missing' }
            : { status: 'authorized', permissionRef, targetVersionRef };
        },
      },
      owner: {
        async writeback() {
          calls.writeback += 1;
          return {
            status: 'deployed',
            writebackReceiptRef: {
              ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
              ownerStateRef: `deploy:sha256:${shaB}`,
            },
            deployedVersionRef,
            rollbackVersionRef,
            deployedArtifactSha256: shaB,
            deployedAt: '2026-09-04T01:00:00.000Z',
          };
        },
      },
    });
    const result = await adapter.writeback(writebackInput('writeback-without-rollback-permission'));

    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'artifact_hash_mismatch');
    assert.equal(result.blockerRef.ownerStateRef, `deploy:sha256:${shaB}`);
    assert.equal(calls.writeback, 1);
    assert.equal(calls.rollback, 0);
  });

  it('preserves the deployment receipt when target-drift compensation is denied', async () => {
    const { adapter, calls } = makeHarness({
      credentialBoundary: {
        async authorize(input) {
          return input.operation === 'rollback'
            ? { status: 'blocked', code: 'permission_missing' }
            : { status: 'authorized', permissionRef, targetVersionRef };
        },
      },
      owner: {
        async writeback() {
          calls.writeback += 1;
          return {
            status: 'deployed',
            writebackReceiptRef: {
              ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
              ownerStateRef: `deploy:sha256:${shaA}`,
            },
            deployedVersionRef: { ...deployedVersionRef, assetId: 'another-policy-slot' },
            rollbackVersionRef,
            deployedArtifactSha256: shaA,
            deployedAt: '2026-09-04T01:00:00.000Z',
          };
        },
      },
    });

    const result = await adapter.writeback(writebackInput('writeback-drift-without-rollback-permission'));

    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'target_drift');
    assert.equal(result.blockerRef.ownerStateRef, `deploy:sha256:${shaA}`);
    assert.equal(calls.writeback, 1);
    assert.equal(calls.rollback, 0);
  });

  it('accepts fresh outcome only for the exact deployed artifact after writeback', async () => {
    const { adapter, calls } = makeHarness();
    const result = await adapter.freshOutcome({
      ...exactBase(),
      deployedVersionRef,
      writebackReceiptRef: { ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID, ownerStateRef: `deploy:sha256:${shaA}` },
      expectedArtifactSha256: shaA,
    });

    assert.equal(result.status, 'fresh');
    assert.equal(result.outcomeReceiptRef.ownerStateRef, `fresh-outcome:sha256:${shaA}`);
    assert.equal(calls.collectFreshOutcome, 1);
  });

  it('rejects rollback receipts that restore a different valid policy revision', async () => {
    const { adapter } = makeHarness({
      owner: {
        async rollback() {
          return {
            status: 'rolled_back',
            rollbackReceiptRef: {
              ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
              ownerStateRef: `rollback-receipt:sha256:${shaA}`,
            },
            restoredVersionRef: candidateVersionRef,
          };
        },
      },
    });

    const result = await adapter.rollback({
      ...exactBase(),
      targetVersionRef,
      deployedVersionRef,
      rollbackVersionRef,
      permissionRef,
      clientMessageId: 'rollback-wrong-revision',
    });

    assert.deepEqual(result, { status: 'blocked', code: 'rollback_failed' });
  });
});
