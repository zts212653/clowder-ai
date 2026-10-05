import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './f290-communication-current-execution.fixture.js';
import { workOf } from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

test('REVIEW: a persisted unsent admission becomes a visible rejection after revocation without conflicting with its own outbox', async () => {
  const f = await fixture();
  try {
    const continued = await f.continueWork('Continue A before the Host admission write is interrupted');
    f.world.injectFault({ path: '/api/collaboration/work/host-admission', when: 'before' });
    await assert.rejects(f.admission.admit(continued.source, CAT));
    assert.equal((await f.tasks.listByKind('work')).length, 1);
    const firstTask = (await f.tasks.listByKind('work'))[0];
    assert.equal(workOf(f.world, f.work.workId).executionAuthority?.hostAdmission, undefined);
    await f.cafe.connector.revokeWorkGrants(f.cafe.connectionId, f.cafe.ownerUserId, ['grant-guides']);
    await f.world.restartConnector(f.cafe);
    await f.cafe.connector.sync(f.cafe.connectionId);
    await f.admission.admit(continued.source, CAT);
    assert.equal(workOf(f.world, f.work.workId).executionAuthority?.hostAdmission?.state, 'rejected');
    assert.equal((await f.tasks.listByKind('work')).length, 1);
    assert.equal((await f.tasks.listByKind('work'))[0]?.id, firstTask?.id);
    assert.equal(workOf(f.world, f.work.workId).status, 'blocked');
    await f.admission.admit(continued.source, CAT);
    await f.cafe.connector.sync(f.cafe.connectionId);
    assert.equal(workOf(f.world, f.work.workId).executionAuthority?.hostAdmission?.state, 'rejected');
  } finally {
    await f.world.close();
  }
});

test('a lost confirmed admission response can contract after revocation while retaining its historical fact', async () => {
  const f = await fixture();
  try {
    const continued = await f.continueWork('Continue A with the admission response lost after Service commit');
    f.world.injectFault({ path: '/api/collaboration/work/host-admission', when: 'after' });
    await assert.rejects(f.admission.admit(continued.source, CAT));
    const admitted = workOf(f.world, f.work.workId).executionAuthority?.hostAdmission;
    assert.equal(admitted?.state, 'admitted');
    await f.cafe.connector.revokeWorkGrants(f.cafe.connectionId, f.cafe.ownerUserId, ['grant-guides']);
    await f.world.restartConnector(f.cafe);
    await f.cafe.connector.sync(f.cafe.connectionId);
    await f.admission.admit(continued.source, CAT);
    const current = workOf(f.world, f.work.workId);
    assert.equal(current.executionAuthority?.hostAdmission?.state, 'rejected');
    assert.deepEqual(current.executionAuthority?.hostAdmissionHistory, [admitted]);
    assert.equal(current.acceptance?.hostAdmission?.state, 'admitted');
    assert.equal((await f.tasks.listByKind('work')).length, 1);
    await f.cafe.connector.sync(f.cafe.connectionId);
    await f.admission.admit(continued.source, CAT);
    assert.deepEqual(workOf(f.world, f.work.workId).executionAuthority?.hostAdmissionHistory, [admitted]);
  } finally {
    await f.world.close();
  }
});
