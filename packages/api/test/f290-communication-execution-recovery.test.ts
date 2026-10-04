import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollectiveWorkRevisionReconciler } from '../src/domains/plugin/builtin-runtime/collective-work-revision-reconciler.js';
import { fixture } from './f290-communication-current-execution.fixture.js';
import { catAccepts, postNaturalRequest, workOf } from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

test('lost continuation Host receipt recovers the same operation and Task after Connector restart', async () => {
  const f = await fixture();
  try {
    const continued = await f.continueWork('Continue A across the lost Host receipt response');
    f.world.injectFault({ path: '/api/collaboration/work/host-admission', when: 'after' });
    await assert.rejects(f.admission.admit(continued.source, CAT), /lost|Service|request|fetch/i);
    const receipt = workOf(f.world, f.work.workId).executionAuthority?.hostAdmission?.receiptRef;
    assert.ok(receipt, 'the Service committed the actual Host Task fact before the response was lost');
    assert.equal((await f.tasks.listByKind('work')).length, 1);
    await f.world.restartConnector(f.cafe);
    await f.cafe.connector.sync(f.cafe.connectionId);
    const dispatch = await f.admission.admit(continued.source, CAT);
    assert.ok(dispatch);
    assert.equal((await f.admission.admit(continued.source, CAT))?.messageId, dispatch.messageId);
    assert.equal(workOf(f.world, f.work.workId).executionAuthority?.hostAdmission?.receiptRef, receipt);
    assert.equal((await f.tasks.listByKind('work')).length, 1);
  } finally {
    await f.world.close();
  }
});

test('one stale pending Host admission does not strand an unrelated matter during durable recovery', async () => {
  const f = await fixture();
  try {
    const stale = await f.continueWork('Continue A with a receipt queued while offline');
    f.world.injectFault({ path: '/api/collaboration/work/host-admission', when: 'before' });
    await assert.rejects(f.admission.admit(stale.source, CAT));
    await f.continueWork('New authority supersedes the offline A receipt');
    const requestB = await postNaturalRequest(f.world, f.world.wulang, f.cafe, CAT, 'Matter B: separate guide', 1);
    const workB = await catAccepts(f.world, f.cafe, requestB);
    assert.ok(workB.assignmentEventId);
    await f.world.restartConnector(f.cafe);
    const sourceB = await f.persist(workB.assignmentEventId);
    const dispatchB = await f.admission.admit(sourceB, CAT);
    assert.ok(dispatchB);
    assert.equal(workOf(f.world, workB.workId).executionAuthority?.hostAdmission?.state, 'admitted');
    assert.equal((await f.tasks.listByKind('work')).length, 2);
    const taskB = (await f.tasks.listByKind('work')).find((task) => task.id !== f.task.id);
    assert.ok(taskB && taskB.threadId !== f.task.threadId);
  } finally {
    await f.world.close();
  }
});

test('execution 2 result followed by a structured Human revision pins the current receipt and blocks the old round', async () => {
  const f = await fixture();
  try {
    const continued = await f.continueWork('Continue A under execution two');
    const dispatch = await f.admission.admit(continued.source, CAT);
    assert.ok(dispatch);
    const auth = await f.authFor(dispatch.messageId);
    const current = await f.context.current(auth);
    await f.context.reply(auth, current.returnRef, current.replyOperationRef, 'Execution two result one');
    const ready = workOf(f.world, f.work.workId);
    await f.world.store.requestCollectiveWorkRevision(f.cafe.sessionToken, {
      ...f.world.coordinates,
      requestId: 'structured-after-execution-two',
      workId: ready.workId,
      expectedRevision: ready.revision,
      resultEventId: ready.resultEventId,
      resultRevision: ready.resultRevision,
      feedback: 'Make the current result shorter',
    });
    await f.cafe.connector.sync(f.cafe.connectionId);
    const inbox = await f.cafe.connector.listInbox(f.cafe.connectionId);
    const event = inbox.find((item) => item.event.workRevisionNotice?.workId === f.work.workId)?.event;
    assert.ok(event);
    const birthId = f.task.entrustedWork!.admission.sourceRefs[0]!.slice('message:'.length);
    const routedInbox = inbox.map((item) =>
      item.event.eventId === f.work.assignmentEventId
        ? {
            ...item,
            disposition: 'routed' as const,
            routedAt: new Date().toISOString(),
            routeReceipt: { kind: 'thread_message' as const, threadId: f.endpoint.id, messageId: birthId },
          }
        : item,
    );
    const next = await new CollectiveWorkRevisionReconciler({
      messages: f.messages,
      tasks: f.tasks,
      dispatcher: f.dispatcher,
    }).reconcile({
      ownerUserId: f.cafe.ownerUserId,
      event,
      inbox: routedInbox,
      work: workOf(f.world, f.work.workId),
    });
    await assert.rejects(f.context.resolvePrivate(auth, 'callback'), /older|current|round/i);
    const nextAuth = await f.authFor(next.dispatch.messageId);
    assert.equal(nextAuth.collectiveWorkBinding?.executionRevision, 2);
    assert.equal(nextAuth.collectiveWorkBinding?.resultRevision, 2);
    assert.ok(
      (await f.messages.getById(next.dispatch.messageId))?.content.includes('Make the current result shorter'),
      'the private carrier includes the exact authenticated Human feedback without relying on Channel pagination',
    );
    const nextContext = await f.context.current(nextAuth);
    await f.context.reply(nextAuth, nextContext.returnRef, nextContext.replyOperationRef, 'Execution two result two');
    assert.equal(workOf(f.world, f.work.workId).resultRevision, 2);
  } finally {
    await f.world.close();
  }
});

test('Service completion stops callbacks before the Host terminal projection catches up', async () => {
  const f = await fixture();
  try {
    const current = await f.context.current(f.firstAuth);
    await f.context.reply(f.firstAuth, current.returnRef, current.replyOperationRef, 'completed result');
    const ready = workOf(f.world, f.work.workId);
    await f.world.store.acceptCollectiveWorkResult(f.cafe.sessionToken, {
      ...f.world.coordinates,
      requestId: 'complete-before-host-close',
      workId: ready.workId,
      expectedRevision: ready.revision,
      resultEventId: ready.resultEventId,
      resultRevision: ready.resultRevision,
    });
    assert.equal(
      (await f.tasks.get(f.task.id))?.entrustedWork?.closure.state,
      'open',
      'the Host projection has not caught up',
    );
    await assert.rejects(f.context.resolvePrivate(f.firstAuth, 'callback'), /current|terminal|completed/i);
  } finally {
    await f.world.close();
  }
});

test('a genuine legacy Human revision gathers current proof under the fence and dispatches after releasing it', async () => {
  const f = await fixture();
  try {
    const revision = await f.world.declareCats(f.cafe, [CAT], {
      threadId: f.endpoint.id,
      standingWork: { requestingHumanIds: [f.cafe.humanId], channelIds: ['general'], expiresAt: null },
    });
    const request = await postNaturalRequest(f.world, f.world.wulang, f.cafe, CAT, 'Legacy Human FAQ', revision);
    const proposed = await f.world.store.proposeCollectiveWork(f.cafe.sessionToken, {
      ...f.world.coordinates,
      requestId: 'legacy-prepare',
      sourceEventId: request.eventId,
      title: 'Legacy FAQ',
      intendedOutcome: request.body,
    });
    const committed = await f.world.store.commitCollectiveWork(f.cafe.sessionToken, {
      ...f.world.coordinates,
      requestId: 'legacy-assign',
      workId: proposed.workId,
      expectedRevision: proposed.revision,
      assignment: { connectionId: f.cafe.connectionId, catId: CAT, participationRevision: revision },
    });
    assert.ok(committed.assignmentEventId);
    const birth = await f.persist(committed.assignmentEventId);
    const first = await f.admission.admit(birth, CAT);
    assert.ok(first);
    const task = (await f.tasks.listByKind('work')).find((candidate) => candidate.id !== f.task.id);
    assert.ok(task?.entrustedWork);
    const trigger = {
      userId: f.cafe.ownerUserId,
      threadId: task.threadId,
      catId: CAT,
      ownerAuthProvenance: 'unknown' as const,
      originTriggerMessageId: first.messageId,
    };
    const binding = await f.context.resolvePrivate(trigger, 'admission');
    assert.ok(binding);
    const carrier = (await f.messages.getById(first.messageId))?.extra?.collectiveWorkInvocationV1;
    assert.ok(carrier);
    const auth = {
      ...trigger,
      invocationId: f.world.startTurn(CAT),
      callbackToken: 'legacy-fixture',
      collectiveWorkBinding: { ...carrier, sourceRef: binding.sourceRef, authorityRef: binding.work.authorityRef },
    };
    const current = await f.context.current(auth as Parameters<typeof f.context.current>[0]);
    await f.context.reply(
      auth as Parameters<typeof f.context.reply>[0],
      current.returnRef,
      current.replyOperationRef,
      'Legacy first result',
    );
    const ready = workOf(f.world, committed.workId);
    await f.world.store.requestCollectiveWorkRevision(f.cafe.sessionToken, {
      ...f.world.coordinates,
      requestId: 'legacy-revision',
      workId: ready.workId,
      expectedRevision: ready.revision,
      resultEventId: ready.resultEventId,
      resultRevision: ready.resultRevision,
      feedback: 'Shorten this legacy answer',
    });
    await f.cafe.connector.sync(f.cafe.connectionId);
    const reconciler = new CollectiveWorkRevisionReconciler({
      messages: f.messages,
      tasks: f.tasks,
      dispatcher: f.dispatcher,
    });
    const prepared = await f.cafe.connector.withAssignedWorkAuthority(
      f.cafe.connectionId,
      committed.workId,
      async (scope) => {
        const event = scope.inbox.find((item) => item.event.workRevisionNotice?.workId === committed.workId)?.event;
        assert.ok(event);
        return reconciler.prepare({
          ownerUserId: f.cafe.ownerUserId,
          event,
          work: scope.work,
          inbox: scope.inbox.map((item) =>
            item.event.eventId === committed.assignmentEventId
              ? {
                  ...item,
                  disposition: 'routed' as const,
                  routedAt: new Date().toISOString(),
                  routeReceipt: { kind: 'thread_message' as const, threadId: f.endpoint.id, messageId: birth.id },
                }
              : item,
          ),
        });
      },
    );
    const dispatched = await reconciler.dispatchPrepared(prepared);
    assert.equal(dispatched.taskId, task.id);
    assert.equal(
      (await f.messages.getById(dispatched.dispatch.messageId))?.extra?.collectiveWorkInvocationV1?.resultRevision,
      2,
    );
  } finally {
    await f.world.close();
  }
});
