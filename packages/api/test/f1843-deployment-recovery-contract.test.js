import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeploymentWaitRecoverySweep } from '../dist/domains/runtime-deployment/DeploymentWaitRecoverySweep.js';

test('deployment recovery selects the existing projection index, never the whole work history', async () => {
  let indexedReads = 0,
    repairs = 0;
  const pending = { id: 'pending', deploymentWait: { waitOutcome: { delivery: 'pending' } } };
  const store = {
    listDeploymentWaitAuditCandidates: async () => [],
    finishDeploymentWaitRecovery: async () => {},
    listByKind: async () => assert.fail('periodic recovery must not read all work history'),
    listDueDeploymentWaitRecovery: async () => {
      indexedReads++;
      return [pending];
    },
  };
  const sweep = new DeploymentWaitRecoverySweep(
    store,
    { observe: async () => assert.fail('pending receipt needs no new observation') },
    {
      recoverOutcome: async () => {
        repairs++;
        return { kind: 'notified' };
      },
    },
  );
  assert.deepEqual(await sweep.run(), { checked: 0, recovered: 1 });
  assert.equal(indexedReads, 1);
  assert.equal(repairs, 1);
});

test('a not-applicable deployment outcome remains historical and is not repaired again', async () => {
  let repairs = 0;
  const historical = { id: 'settled', deploymentWait: { waitOutcome: { delivery: 'not_applicable' } } };
  const store = {
    listDeploymentWaitAuditCandidates: async () => [],
    finishDeploymentWaitRecovery: async () => {},
    listByKind: async () => [historical],
    listDueDeploymentWaitRecovery: async () => [historical],
  };
  const sweep = new DeploymentWaitRecoverySweep(
    store,
    { observe: async () => null },
    {
      recoverOutcome: async () => {
        repairs++;
        return { kind: 'not_applicable' };
      },
    },
  );
  await sweep.run();
  await sweep.run();
  assert.equal(repairs, 0);
});
