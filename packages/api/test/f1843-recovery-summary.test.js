import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBallCustodyProbeTaskSpec } from '../dist/domains/ball-custody/BallCustodyProbeTaskSpec.js';
import { DeploymentWaitRecoverySweep } from '../dist/domains/runtime-deployment/DeploymentWaitRecoverySweep.js';

test('each idle ball-probe round produces one numeric summary instead of going silent', async () => {
  const observations = [];
  const spec = createBallCustodyProbeTaskSpec({
    scheduler: {
      tick: async () => ({
        checked: 0,
        completed: 0,
        woken: 0,
        idleMarked: 0,
        cooldownSkipped: 0,
        skipped: 0,
        failed: 0,
      }),
    },
    log: { info: (...args) => observations.push(args), warn: (...args) => observations.push(args) },
  });
  await spec.run.execute();
  await spec.run.execute();
  assert.equal(observations.length, 2);
  for (const [entry] of observations) {
    assert.equal(entry.loopId, 'ball-custody-probe');
    assert.ok(entry.elapsedMs >= 0);
    assert.equal(entry.result.checked, 0);
  }
});

test('each idle deployment recovery round has one summary for both live and audit lanes', async () => {
  const observations = [];
  const sweep = new DeploymentWaitRecoverySweep(
    { listDueDeploymentWaitRecovery: async () => [], listDeploymentWaitAuditCandidates: async () => [] },
    { observe: async () => assert.fail('no due business work') },
    { recoverAudit: async () => assert.fail('no due audit work') },
    { info: (...args) => observations.push(args), warn: (...args) => observations.push(args) },
  );
  await sweep.run();
  await sweep.run();
  assert.equal(observations.length, 2);
  for (const [entry] of observations) {
    assert.equal(entry.loopId, 'deployment-wait');
    assert.ok(entry.elapsedMs >= 0);
    assert.equal(entry.checked, 0);
    assert.equal(entry.auditSelected, 0);
  }
});
