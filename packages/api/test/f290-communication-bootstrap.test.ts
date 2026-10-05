import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskItem } from '@cat-cafe/shared';
import { resolveCollectiveStandingGrant } from '../src/domains/plugin/builtin-runtime/collective-standing-grant.js';
import { standingProvenance } from '../src/domains/plugin/builtin-runtime/collective-work/collective-work-execution-receipt.js';
import { bootstrapFixture } from './f290-communication-bootstrap.fixture.js';
import { workOf } from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

async function refuseOldAdmission(f: Awaited<ReturnType<typeof bootstrapFixture>>) {
  assert.ok(f.birth);
  await f.cafe.connector.revokeWorkGrants(f.cafe.connectionId, f.cafe.ownerUserId, ['grant-guides']);
  assert.equal(await f.admission.admit(f.birth, CAT), undefined);
  assert.equal((await f.tasks.listByKind('work')).length, 0);
  assert.equal(workOf(f.world, f.work.workId).acceptance?.hostAdmission?.state, 'rejected');
  await f.regrant();
}
async function firstReceipt(f: Awaited<ReturnType<typeof bootstrapFixture>>, task: TaskItem) {
  const admission = task.entrustedWork?.admission;
  assert.ok(admission && admission.basis === 'authorized_source');
  const message = await f.messages.getById(admission.authorityRef.slice('message:'.length));
  assert.ok(message?.extra?.collectiveOwnerAdmissionV1);
  return message;
}

test('first Host Task is born under current g2 execution after g1 was revoked before admission, with immutable g1 lineage', async () => {
  const f = await bootstrapFixture();
  try {
    await refuseOldAdmission(f);
    assert.ok(f.birth);
    const first = structuredClone(workOf(f.world, f.work.workId));
    const continued = await f.continueWork('Continue Matter A with the new permission');
    const dispatch = await f.admission.admit(continued.source, CAT);
    assert.ok(dispatch, 'a legitimate current continuation must be able to create its first actual Host Task');
    const tasks = await f.tasks.listByKind('work');
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.ok(task?.entrustedWork);
    assert.deepEqual(task.entrustedWork.admission.sourceRefs, [`message:${f.birth.id}`]);
    assert.ok(task.createdAt >= continued.source.timestamp, 'Task DOB is its actual current admission');
    const receipt = await firstReceipt(f, task);
    assert.deepEqual(receipt.extra?.collectiveOwnerAdmissionV1?.bootstrapExecution, {
      sourceRef: `message:${continued.source.id}`,
      workId: f.work.workId,
      assignmentEventId: f.work.assignmentEventId,
      revision: 2,
    });
    assert.equal(receipt.extra?.collectiveOwnerAdmissionV1?.standingGrant?.sourceRef, `message:${continued.source.id}`);
    const auth = await f.authFor(dispatch.messageId);
    assert.equal(auth.ownerAuthProvenance, 'unknown');
    assert.equal(auth.collectiveWorkBinding?.executionRevision, 2);
    const privateBinding = await f.context.resolvePrivate(auth, 'callback');
    assert.ok(privateBinding?.work.executionRef);
    assert.equal(privateBinding.sourceRef, `message:${continued.source.id}`);
    const actual = workOf(f.world, f.work.workId);
    assert.deepEqual(
      actual.acceptance,
      first.acceptance,
      'first Service acceptance is not rewritten as a g2 acceptance',
    );
    assert.deepEqual(actual.assignment, first.assignment);
    assert.equal(actual.assignmentEventId, first.assignmentEventId);
    assert.equal(actual.executionAuthority?.hostAdmission?.state, 'admitted');
    await assert.rejects(f.admission.admit(f.birth, CAT), /current|admission/i);
    await assert.rejects(
      f.context.resolvePublic({
        userId: f.cafe.ownerUserId,
        threadId: f.endpoint.id,
        catId: CAT,
        originTriggerMessageId: f.birth.id,
      }),
      /current|participation|revoked/i,
    );
    const current = await f.context.current(auth);
    assert.equal((await f.context.read(auth, current.contextRef)).previousResultArtifact, undefined);
    const oldCarrier = (
      await f.messages.appendIdempotent({
        userId: f.cafe.ownerUserId,
        threadId: task.threadId,
        catId: null,
        mentions: [CAT],
        content: 'obsolete g1 carrier',
        timestamp: Date.now(),
        idempotencyKey: 'obsolete-g1',
        extra: {
          collectiveWorkInvocationV1: {
            v: 1,
            taskId: task.id,
            observedRevision: task.entrustedWork.revision,
            resultRevision: 1,
            executionRevision: 1,
          },
        },
      })
    ).message;
    await assert.rejects(
      f.context.resolvePrivate(
        {
          userId: f.cafe.ownerUserId,
          threadId: task.threadId,
          catId: CAT,
          ownerAuthProvenance: 'unknown',
          originTriggerMessageId: oldCarrier.id,
        },
        'callback',
      ),
      { code: 'PARTICIPATION_REVOKED' },
    );
    await f.context.reply(
      auth,
      current.returnRef,
      current.replyOperationRef,
      'Current g2 result from the first real Task',
    );
    assert.equal(workOf(f.world, f.work.workId).resultRevision, 1);
    assert.equal(workOf(f.world, f.work.workId).lifecycle, 'result_ready');
  } finally {
    await f.world.close();
  }
});

test('a crash after current first admission retains the actual Task and recovers one current receipt, then g3 reuses it', async () => {
  const f = await bootstrapFixture();
  try {
    await refuseOldAdmission(f);
    const continued = await f.continueWork('Continue A after revocation');
    let crashed = false;
    f.hooks.beforeAppend = async (input) => {
      if (!crashed && input.extra?.collectiveOwnerAdmissionV1?.execution?.revision === 2) {
        crashed = true;
        throw new Error('fixture crash after actual first Task before execution receipt');
      }
    };
    await assert.rejects(f.admission.admit(continued.source, CAT), /fixture crash/i);
    const tasks = await f.tasks.listByKind('work');
    assert.equal(tasks.length, 1, 'an actual created Task must not be reported as noTask');
    const task = tasks[0];
    assert.ok(task);
    const birth = structuredClone(task);
    const initialReceipt = await firstReceipt(f, task);
    assert.equal(workOf(f.world, f.work.workId).executionAuthority?.hostAdmission, undefined);
    await f.world.restartConnector(f.cafe);
    const dispatch = await f.admission.admit(continued.source, CAT);
    assert.ok(dispatch);
    const replay = await f.admission.admit(continued.source, CAT);
    assert.equal(replay?.messageId, dispatch.messageId);
    const auth2 = await f.authFor(dispatch.messageId);
    assert.deepEqual(await f.tasks.get(task.id), birth);
    assert.equal((await firstReceipt(f, task)).id, initialReceipt.id);
    const next = await f.continueWork('Continue A once more under current g3');
    assert.ok(f.birth && task.entrustedWork);
    const scope = await resolveCollectiveStandingGrant(f.cafe.connector, next.source, CAT);
    assert.ok(scope);
    await assert.rejects(
      f.authority.admit({
        ownerUserId: f.cafe.ownerUserId,
        ownerAuthProvenance: 'strict',
        source: f.birth,
        catId: CAT,
        threadId: task.threadId,
        requestId: 'attempt-new-bootstrap-for-existing-Task',
        title: task.title,
        intendedOutcome: task.entrustedWork.intendedOutcome,
        closure: {
          condition: task.entrustedWork.closure.condition,
          expectedSignal: task.entrustedWork.closure.expectedSignal,
        },
        standingGrant: standingProvenance(next.source, scope.grant),
        bootstrapExecution: {
          sourceRef: `message:${next.source.id}`,
          workId: f.work.workId,
          assignmentEventId: f.work.assignmentEventId!,
          revision: 3,
        },
      }),
      { code: 'WORK_TASK_UNAVAILABLE' },
    );
    const dispatch3 = await f.admission.admit(next.source, CAT);
    assert.ok(dispatch3);
    const auth3 = await f.authFor(dispatch3.messageId);
    assert.equal(auth3.collectiveWorkBinding?.taskId, task.id);
    assert.equal(auth3.collectiveWorkBinding?.executionRevision, 3);
    await assert.rejects(f.context.resolvePrivate(auth2, 'callback'), /current|changed|authority/i);
    assert.deepEqual(await f.tasks.get(task.id), birth, 'g3 changes execution receipt, not Task birth');
    assert.equal((await f.tasks.listByKind('work')).length, 1);
  } finally {
    await f.world.close();
  }
});

for (const state of ['closed', 'multiple'] as const) {
  test(`current continuation refuses ${state} actual Task facts instead of bootstrapping another Task`, async () => {
    const f = await bootstrapFixture();
    try {
      await refuseOldAdmission(f);
      const continued = await f.continueWork('Create the first Task under g2');
      assert.ok(await f.admission.admit(continued.source, CAT));
      const task = (await f.tasks.listByKind('work'))[0];
      assert.ok(task?.entrustedWork);
      if (state === 'closed') {
        const closed = await f.tasks.closeEntrustedWork(task.id, {
          expectedRevision: task.entrustedWork.revision,
          closure: { ...task.entrustedWork.closure, state: 'satisfied', evidenceRefs: ['fixture:owner-closed'] },
        });
        assert.equal(closed.kind, 'closed');
      } else {
        f.tasks.admitEntrustedWork({
          subjectKey: 'entrusted:fixture-duplicate-fact',
          task: {
            userId: task.userId,
            threadId: task.threadId,
            title: task.title,
            why: task.why,
            createdBy: task.createdBy,
            ownerCatId: task.ownerCatId,
          },
          entrustedWork: task.entrustedWork,
        });
      }
      const count = (await f.tasks.listByKind('work')).length;
      const next = await f.continueWork('Current g3 must respect existing Host facts');
      await assert.rejects(
        f.cafe.connector.withAssignedWorkAuthority(f.cafe.connectionId, f.work.workId, (scope) =>
          f.authority.admitStanding(next.source, CAT, scope),
        ),
        { code: 'WORK_TASK_UNAVAILABLE' },
      );
      assert.equal(await f.admission.admit(next.source, CAT), undefined);
      assert.equal(workOf(f.world, f.work.workId).executionAuthority?.hostAdmission?.state, 'rejected');
      assert.equal((await f.tasks.listByKind('work')).length, count);
    } finally {
      await f.world.close();
    }
  });
}

test('a cold Host uses the actual inbox first assignment only as lineage when g1 never produced a Message or Task', async () => {
  const f = await bootstrapFixture({ persistBirth: false });
  try {
    assert.equal(f.birth, undefined);
    assert.equal((await f.tasks.listByKind('work')).length, 0);
    assert.equal((await f.messages.getByThread(f.endpoint.id)).length, 0);
    await f.cafe.connector.revokeWorkGrants(f.cafe.connectionId, f.cafe.ownerUserId, ['grant-guides']);
    await f.regrant();
    const continued = await f.continueWork('Continue the matter after late Host startup');
    await assert.rejects(
      f.cafe.connector.withAssignedWorkAuthority(f.cafe.connectionId, f.work.workId, (scope) =>
        f.authority.admitStanding({ ...continued.source, content: 'forged current notice body' }, CAT, scope),
      ),
      { code: 'WORK_EXECUTION_NOT_CURRENT' },
    );
    assert.equal((await f.tasks.listByKind('work')).length, 0);
    const dispatch = await f.admission.admit(continued.source, CAT);
    assert.ok(dispatch);
    const task = (await f.tasks.listByKind('work'))[0];
    assert.ok(task?.entrustedWork);
    const lineageRef = task.entrustedWork.admission.sourceRefs[0];
    assert.ok(lineageRef?.startsWith('message:'));
    const lineage = await f.messages.getById(lineageRef.slice('message:'.length));
    assert.equal(lineage?.source?.meta?.eventId, f.work.assignmentEventId);
    assert.equal(lineage?.source?.meta?.participation?.participationRevision, 1);
    assert.equal(workOf(f.world, f.work.workId).acceptance?.hostAdmission, undefined);
    assert.equal(workOf(f.world, f.work.workId).executionAuthority?.hostAdmission?.state, 'admitted');
    assert.ok(lineage);
    await assert.rejects(
      f.context.resolvePublic({
        userId: f.cafe.ownerUserId,
        threadId: lineage.threadId,
        catId: CAT,
        originTriggerMessageId: lineage.id,
      }),
      { code: 'PARTICIPATION_REVOKED' },
    );
    const auth = await f.authFor(dispatch.messageId);
    const current = await f.context.current(auth);
    assert.equal((await f.context.read(auth, current.contextRef)).previousResultArtifact, undefined);
  } finally {
    await f.world.close();
  }
});

test('a refused current admission is durably skipped without birth, and a fresh execution can create the first Task', async () => {
  const f = await bootstrapFixture();
  try {
    await refuseOldAdmission(f);
    const continued = await f.continueWork('A g2 admission that is refused before Task birth');
    f.hooks.beforeAppend = async (input) => {
      if (input.extra?.collectiveOwnerAdmissionV1?.bootstrapExecution?.revision === 2)
        throw Object.assign(new Error('fixture admission refused before Task birth'), {
          code: 'WORK_TASK_UNAVAILABLE',
        });
    };
    assert.equal(await f.admission.admit(continued.source, CAT), undefined);
    assert.equal(workOf(f.world, f.work.workId).executionAuthority?.hostAdmission?.state, 'rejected');
    f.hooks.beforeAppend = undefined;
    assert.equal(await f.admission.admit(continued.source, CAT), undefined, 'same refused operation stays disposed');
    assert.equal((await f.tasks.listByKind('work')).length, 0);
    const next = await f.continueWork('Fresh g3 continuation after the refused Host operation');
    const dispatch = await f.admission.admit(next.source, CAT);
    assert.ok(dispatch);
    const task = (await f.tasks.listByKind('work'))[0];
    assert.ok(task?.entrustedWork);
    assert.equal((await firstReceipt(f, task)).extra?.collectiveOwnerAdmissionV1?.bootstrapExecution?.revision, 3);
    assert.equal((await f.tasks.listByKind('work')).length, 1);
  } finally {
    await f.world.close();
  }
});
