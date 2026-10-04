import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from './f290-communication-current-execution.fixture.js';
import { catAccepts, grantAndAdopt, postNaturalRequest, workOf } from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

test('a confirmed admission is historical after owner revocation; public progress must stop without redelivering old admission', async () => {
  const f = await fixture();
  try {
    const current = await f.context.current(f.firstAuth);
    assert.ok(current.progressOperationRef);
    await f.context.progress(
      f.firstAuth,
      current.returnRef,
      current.progressOperationRef,
      'Started the accepted guide',
    );
    assert.equal(workOf(f.world, f.work.workId).status, 'in_progress');
    const before = workOf(f.world, f.work.workId);
    await f.cafe.connector.revokeWorkGrants(f.cafe.connectionId, f.cafe.ownerUserId, ['grant-guides']);
    await f.cafe.connector.sync(f.cafe.connectionId);
    await assert.rejects(f.context.current(f.firstAuth), /current|delegation|permission|cover/i);
    const stopped = workOf(f.world, f.work.workId);
    await writeFile(
      '/tmp/f290-r2-current-availability-work.json',
      JSON.stringify(
        {
          work: stopped,
          before,
          policy: await f.cafe.connector.readWorkPolicy(f.cafe.connectionId),
        },
        null,
        2,
      ),
    );
    assert.equal(
      stopped.executionAuthority?.hostAdmission?.state,
      'admitted',
      'the successful historical admission must be retained',
    );
    assert.notEqual(
      stopped.status,
      'in_progress',
      'public Work cannot keep claiming current progress after both sides confirm revocation',
    );
    assert.deepEqual(stopped.executionStatus, {
      issuer: 'service',
      revision: 1,
      state: 'unavailable',
      reason: 'WORK_DELEGATION_UNAVAILABLE',
    });
    assert.deepEqual(stopped.acceptance, before.acceptance);
    await grantAndAdopt(f.world, f.cafe);
    assert.equal(
      workOf(f.world, f.work.workId).executionStatus?.state,
      'unavailable',
      'new g2 cannot authorize the old g1 execution',
    );
    const continued = await f.continueWork('A valid g2 continuation after revocation');
    const dispatched = await f.admission.admit(continued.source, CAT);
    assert.ok(dispatched);
    assert.equal(workOf(f.world, f.work.workId).executionStatus?.state, 'permitted');
    assert.equal((await f.tasks.listByKind('work')).length, 1);
    assert.equal((await f.tasks.listByKind('work'))[0]?.id, f.task.id);
  } finally {
    await f.world.close();
  }
});

test('expiration converges the live public state with the Service clock, without writing over admission', async () => {
  let now = Date.now();
  const f = await fixture({ now: () => now, expiresAt: new Date(now + 60000).toISOString() });
  try {
    const context = await f.context.current(f.firstAuth);
    assert.ok(context.progressOperationRef);
    await f.context.progress(f.firstAuth, context.returnRef, context.progressOperationRef, 'Working before expiry');
    const before = workOf(f.world, f.work.workId);
    assert.equal(before.status, 'in_progress');
    now += 60001;
    const after = workOf(f.world, f.work.workId);
    assert.equal(after.status, 'blocked');
    assert.equal(after.executionStatus?.reason, 'WORK_DELEGATION_UNAVAILABLE');
    assert.deepEqual(after.executionAuthority?.hostAdmission, before.executionAuthority?.hostAdmission);
    assert.equal(after.revision, before.revision, 'time-based projection does not invent a Work revision');
    await assert.rejects(f.context.current(f.firstAuth));
  } finally {
    await f.world.close();
  }
});

test('participant removal and re-entry stop the old scope without falsifying its admitted fact', async () => {
  const f = await fixture();
  try {
    const context = await f.context.current(f.firstAuth);
    assert.ok(context.progressOperationRef);
    await f.context.progress(f.firstAuth, context.returnRef, context.progressOperationRef, 'Working before removal');
    const before = workOf(f.world, f.work.workId);
    await f.world.declareCats(f.cafe, [], { threadId: f.endpoint.id });
    const removed = workOf(f.world, f.work.workId);
    assert.equal(removed.status, 'blocked');
    assert.equal(removed.executionStatus?.reason, 'PARTICIPATION_REVOKED');
    assert.deepEqual(removed.executionAuthority?.hostAdmission, before.executionAuthority?.hostAdmission);
    await f.world.declareCats(f.cafe, [CAT], { threadId: f.endpoint.id });
    assert.equal(workOf(f.world, f.work.workId).executionStatus?.reason, 'PARTICIPATION_REVOKED');
    await assert.rejects(f.context.current(f.firstAuth));
  } finally {
    await f.world.close();
  }
});

test('revoking A does not stop the same Cat B admitted under its independent exact grant', async () => {
  const f = await fixture();
  try {
    const scope = {
      catIds: [CAT],
      channelIds: ['general'],
      requestingHumanIds: 'channel_members',
      requestKinds: ['guide'],
      expiresAt: null,
    };
    await grantAndAdopt(f.world, f.cafe, {
      grants: [
        { ...scope, grantRef: 'grant-guides' },
        { ...scope, grantRef: 'grant-B' },
      ],
    });
    const request = await postNaturalRequest(f.world, f.world.wulang, f.cafe, CAT, 'Independent B', 1);
    const workB = await catAccepts(f.world, f.cafe, request, {
      grantRef: 'grant-B',
      grantRevision: 1,
      title: 'Independent B',
    });
    assert.ok(workB.assignmentEventId);
    const dispatchB = await f.admission.admit(await f.persist(workB.assignmentEventId), CAT);
    assert.ok(dispatchB);
    const authB = await f.authFor(dispatchB.messageId);
    const contextB = await f.context.current(authB);
    assert.ok(contextB.progressOperationRef);
    await f.context.progress(authB, contextB.returnRef, contextB.progressOperationRef, 'B still progressing');
    const beforeB = workOf(f.world, workB.workId);
    const contextA = await f.context.current(f.firstAuth);
    assert.ok(contextA.progressOperationRef);
    await f.context.progress(
      f.firstAuth,
      contextA.returnRef,
      contextA.progressOperationRef,
      'A progressing before revocation',
    );
    const beforeA = workOf(f.world, f.work.workId);
    await f.cafe.connector.revokeWorkGrants(f.cafe.connectionId, f.cafe.ownerUserId, ['grant-guides']);
    await f.cafe.connector.sync(f.cafe.connectionId);
    assert.equal(workOf(f.world, f.work.workId).executionStatus?.state, 'unavailable');
    const afterB = workOf(f.world, workB.workId);
    assert.equal(afterB.status, 'in_progress');
    assert.equal(afterB.executionStatus?.state, 'permitted');
    assert.deepEqual(afterB.executionAuthority, beforeB.executionAuthority);
    await f.context.current(authB);
    assert.equal((await f.tasks.listByKind('work')).length, 2);
    await writeFile(
      '/tmp/f290-r2-current-availability-B.json',
      JSON.stringify({ work: afterB, before: beforeB }, null, 2),
    );
    await writeFile(
      '/tmp/f290-r2-current-availability-work.json',
      JSON.stringify({ work: workOf(f.world, f.work.workId), before: beforeA, B: afterB, beforeB }, null, 2),
    );
  } finally {
    await f.world.close();
  }
});
