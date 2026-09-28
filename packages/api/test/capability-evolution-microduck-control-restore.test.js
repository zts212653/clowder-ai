import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { diagnoseMicroduckRestoreAttempt } from '../dist/infrastructure/capability-evolution/adapters/microduck-control-owner-port.js';
import {
  controlOwnerFixture,
  controlWritebackInput,
  ownerRef,
  scope,
} from './helpers/microduck-control-owner-fixture.js';

describe('F311 Microduck physical restore verification', () => {
  it('keeps slot rollback truth while typed attempts distinguish mismatch from execution refusal', async (t) => {
    const cases = [
      {
        namespace: 'restore-outcome-attempt',
        expected: {
          kind: 'measured_mismatch',
          slotState: 'rolled_back',
          nextAction: 'investigate_reference_environment_or_determinism',
        },
      },
      {
        namespace: 'restore-execution-attempt',
        expected: {
          kind: 'execution_refusal',
          slotState: 'rolled_back',
          nextAction: 'retry_physical_restore_verification',
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      let restoreAttempts = 0;
      const referenceFreshOutcomeRef = ownerRef(`fresh-outcome:sha256:${String(index + 6).repeat(64)}`);
      const restoreOutcomeRef = ownerRef(`restore-outcome:sha256:${String(index + 8).repeat(64)}`);
      const { baseline, candidate, contract, owner, slotOwner, statePath } = await controlOwnerFixture(t, {
        loadedOutcomeRunner: {
          async collect(input) {
            assert.equal(input.mode, 'post_rollback');
            assert.deepEqual(input.referenceFreshOutcomeRef, referenceFreshOutcomeRef);
            restoreAttempts += 1;
            if (testCase.namespace === 'restore-execution-attempt' && restoreAttempts === 2) {
              return {
                status: 'restore_verified',
                outcomeReceiptRef: restoreOutcomeRef,
                freshnessProofRef: ownerRef(`freshness-proof:sha256:${'f'.repeat(64)}`),
                restoredVersionRef: input.version.artifactVersionRef,
                restoredArtifactSha256: input.version.artifactVersionRef.version,
                measuredAt: '2026-09-07T06:20:00.000Z',
              };
            }
            return {
              status: 'blocked',
              code: 'rollback_failed',
              blockerRef: ownerRef(`${testCase.namespace}:sha256:${String(index + 4).repeat(64)}`),
            };
          },
        },
      });
      const current = await slotOwner.readCurrent();
      const deployed = await owner.writeback(
        controlWritebackInput(current, candidate, contract.verificationReceiptRef),
      );
      const rollbackInput = {
        ...scope,
        targetVersionRef: deployed.deployedVersionRef,
        deployedVersionRef: deployed.deployedVersionRef,
        rollbackVersionRef: baseline.artifactVersionRef,
        permissionRef: ownerRef('permission:simulator:walking:control-v1', 'b'.repeat(64)),
        writebackReceiptRef: deployed.writebackReceiptRef,
        referenceFreshOutcomeRef,
        clientMessageId: `restore-attempt-${index}`,
      };

      const attempted = await owner.rollback(rollbackInput);
      assert.equal(attempted.status, 'blocked');
      assert.equal(attempted.code, 'rollback_failed');
      assert.match(attempted.blockerRef.ownerStateRef, new RegExp(`^${testCase.namespace}:sha256:`, 'u'));
      assert.match(attempted.recoveryRef.ownerStateRef, /^rollback-receipt:sha256:/u);
      assert.deepEqual(diagnoseMicroduckRestoreAttempt(attempted), testCase.expected);
      assert.deepEqual(Buffer.from((await slotOwner.readCurrent()).version.configBytes), baseline.configBytes);

      if (testCase.namespace === 'restore-execution-attempt') {
        const snapshotAfterAttempt = await readFile(statePath, 'utf8');
        const retried = await owner.rollback(rollbackInput);
        assert.equal(retried.status, 'rolled_back');
        assert.deepEqual(retried.rollbackReceiptRef, attempted.recoveryRef);
        assert.deepEqual(retried.restoreOutcomeRef, restoreOutcomeRef);
        assert.equal(await readFile(statePath, 'utf8'), snapshotAfterAttempt);
      }
    }
  });
});
