import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectiveEventSourceIdentity } from '@cat-cafe/shared';
import type { InvocationRecord } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { collectiveSource } from '../src/domains/plugin/builtin-runtime/collective-ingress-routing.js';
import { fixture } from './f290-communication-current-execution.fixture.js';
import { grantAndAdopt, workOf } from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

test('current execution continues the same Task, keeps birth facts, and invalidates old carriers even under the same grant', async () => {
  const f = await fixture();
  try {
    const birth = structuredClone(f.task);
    const continued = await f.continueWork('Add a short example to Matter A');
    const dispatch = await f.admission.admit(continued.source, CAT);
    assert.ok(dispatch, 'the Service continuation notice must enter Host execution');
    const replay = await f.admission.admit(continued.source, CAT);
    assert.equal(replay?.messageId, dispatch.messageId);
    assert.equal((await f.tasks.listByKind('work')).length, 1);
    assert.deepEqual(
      await f.tasks.get(f.task.id),
      birth,
      'continuation does not rewrite Task owner, birth or first admission',
    );
    await assert.rejects(f.context.resolvePrivate(f.firstAuth, 'callback'), /current|changed|authority/i);
    const auth = await f.authFor(dispatch.messageId);
    assert.equal(auth.collectiveWorkBinding?.executionRevision, 2);
    assert.ok(auth.collectiveWorkBinding?.executionRef);
    const current = await f.context.current(auth);
    assert.equal(current.request.eventId, continued.work.executionAuthority?.eventId);
    await f.context.reply(auth, current.returnRef, current.replyOperationRef, 'Result for the current continuation');
    assert.equal(workOf(f.world, continued.work.workId).resultRevision, 1);
    assert.equal(workOf(f.world, continued.work.workId).lifecycle, 'result_ready');
  } finally {
    await f.world.close();
  }
});

test('a queued old result is durably blocked after current execution changes, and a fresh result can publish', async () => {
  const f = await fixture();
  try {
    const current = await f.context.current(f.firstAuth);
    const binding = await f.context.resolvePrivate(f.firstAuth, 'callback');
    assert.ok(binding);
    const operation = await f.cafe.connector.prepareReply(
      binding.source,
      binding.sourceRef,
      binding.work.resultKey,
      binding.work.revision,
      1,
    );
    await f.cafe.connector.submitReply(
      binding.source,
      binding.sourceRef,
      binding.work.resultKey,
      operation.outboxId,
      'stale queued result',
      f.world.agent(CAT, f.firstAuth.invocationId),
      undefined,
      1,
    );
    const continued = await f.continueWork('Continue A before the old queued result publishes');
    await f.cafe.connector.sync(f.cafe.connectionId);
    const old = await f.cafe.connector.prepareReply(
      binding.source,
      binding.sourceRef,
      binding.work.resultKey,
      binding.work.revision,
      1,
    );
    assert.equal(old?.status, 'blocked');
    assert.equal(old?.failureCode, 'WORK_EXECUTION_NOT_CURRENT');
    await assert.rejects(
      f.context.reply(f.firstAuth, current.returnRef, current.replyOperationRef, 'stale callback'),
      /current|changed|authority/i,
    );
    const dispatch = await f.admission.admit(continued.source, CAT);
    assert.ok(dispatch);
    const auth = await f.authFor(dispatch.messageId);
    const fresh = await f.context.current(auth);
    await f.context.reply(auth, fresh.returnRef, fresh.replyOperationRef, 'current result');
    assert.equal(workOf(f.world, continued.work.workId).lifecycle, 'result_ready');
  } finally {
    await f.world.close();
  }
});

test('raw Human entrust has no Host Task without a committed Service assignment', async () => {
  const f = await fixture();
  try {
    await f.world.declareCats(f.cafe, [CAT], {
      threadId: f.endpoint.id,
      standingWork: { requestingHumanIds: [f.world.wulang.humanId], channelIds: ['general'], expiresAt: null },
    });
    const event = await f.world.store.postHumanMessage(f.world.wulang.sessionToken, {
      ...f.world.coordinates,
      clientEventId: 'raw-entrust',
      workRequest: 'entrust',
      location: { channelId: 'general' },
      recipient: {
        kind: 'agent',
        humanId: f.cafe.humanId,
        connectionId: f.cafe.connectionId,
        agentId: CAT,
        participationRevision: 1,
      },
      body: 'uncommitted natural request',
    });
    const raw = f.messages.append({
      userId: f.cafe.ownerUserId,
      threadId: f.endpoint.id,
      catId: null,
      mentions: [],
      timestamp: Date.now(),
      content: event.body,
      source: collectiveSource(event),
    });
    await f.admission.admit(raw, CAT);
    assert.equal((await f.tasks.listByKind('work')).length, 1, 'only the existing committed Work has a Task');
  } finally {
    await f.world.close();
  }
});

test('regrant after remove/rejoin continues the same Task while ordinary old public sources stay revoked', async () => {
  const f = await fixture();
  try {
    const birthRef = f.task.entrustedWork!.admission.sourceRefs[0]!;
    const birth = await f.messages.getById(birthRef.slice('message:'.length));
    assert.ok(birth);
    const old = { userId: f.cafe.ownerUserId, threadId: f.endpoint.id, catId: CAT, originTriggerMessageId: birth.id };
    await f.world.declareCats(f.cafe, [], { threadId: f.endpoint.id });
    await f.cafe.connector.revokeWorkGrants(f.cafe.connectionId, f.cafe.ownerUserId, ['grant-guides']);
    const revision = await f.world.declareCats(f.cafe, [CAT], { threadId: f.endpoint.id });
    await grantAndAdopt(f.world, f.cafe);
    await assert.rejects(f.context.resolvePublic(old), /participation|revoked|current/i);
    const continued = await f.continueWork('Resume A under the fresh permission and participation', revision);
    const dispatch = await f.admission.admit(continued.source, CAT);
    assert.ok(dispatch);
    const fresh = await f.authFor(dispatch.messageId);
    assert.equal(fresh.collectiveWorkBinding?.taskId, f.task.id);
    const current = await f.context.current(fresh);
    await f.context.reply(fresh, current.returnRef, current.replyOperationRef, 'result under fresh authority');
    assert.equal(workOf(f.world, continued.work.workId).lifecycle, 'result_ready');
    assert.deepEqual((await f.tasks.get(f.task.id))?.entrustedWork?.admission, f.task.entrustedWork?.admission);
  } finally {
    await f.world.close();
  }
});

test('public Work refs bind invocation/source/current versions and continue the exact referenced matter', async () => {
  const f = await fixture();
  try {
    const work = workOf(f.world, f.work.workId);
    const event = await f.world.store.postHumanMessage(f.world.wulang.sessionToken, {
      ...f.world.coordinates,
      clientEventId: 'public-feedback',
      replyToEventId: work.assignmentEventId!,
      location: { channelId: 'general', rootEventId: work.sourceEventId },
      recipient: {
        kind: 'agent',
        humanId: f.cafe.humanId,
        connectionId: f.cafe.connectionId,
        agentId: CAT,
        participationRevision: 1,
      },
      body: 'Please continue A with an example',
    });
    const message = f.messages.append({
      userId: f.cafe.ownerUserId,
      threadId: f.endpoint.id,
      catId: null,
      mentions: [CAT],
      timestamp: Date.now(),
      content: event.body,
      source: collectiveSource(event),
    });
    const source = collectiveEventSourceIdentity(event);
    assert.ok(source);
    const auth = {
      userId: f.cafe.ownerUserId,
      threadId: f.endpoint.id,
      catId: CAT,
      originTriggerMessageId: message.id,
      ownerAuthProvenance: 'unknown',
      invocationId: f.world.startTurn(CAT),
      callbackToken: 'public-fixture-secret',
      toolExecutionPolicy: { mode: 'collective_participation' },
      executionGrant: { kind: 'collective-participation', originTriggerMessageId: message.id, source },
    } as InvocationRecord;
    const current = await f.context.current(auth);
    assert.deepEqual(current.workSourceContext?.relatedWorkIds, [work.workId]);
    const candidate = current.workSourceContext?.matters.find((matter) => matter.workId === work.workId);
    assert.ok(candidate);
    const input = {
      workRef: candidate.workRef,
      kind: 'resume' as const,
      grantRef: 'grant-guides',
      grantRevision: 1,
      requestKind: 'guide',
    };
    await assert.rejects(
      f.context.continueWork({ ...auth, invocationId: 'another-invocation' }, current.contextRef, input),
      /reference|invocation/i,
    );
    const continued = await f.context.continueWork(auth, current.contextRef, input);
    assert.equal(continued.workId, work.workId);
    assert.equal(continued.executionAuthority?.revision, 2);
    await assert.rejects(f.context.continueWork(auth, current.contextRef, input), /changed|current/i);
    assert.equal((await f.tasks.listByKind('work')).length, 1);
  } finally {
    await f.world.close();
  }
});

test('named progress retries restore one event, new progress publishes, and neither creates a result', async () => {
  const f = await fixture();
  try {
    const current = await f.context.current(f.firstAuth);
    assert.ok(current.progressOperationRef);
    f.world.injectFault({ path: '/api/events/agent', when: 'after' });
    await f.context.progress(
      f.firstAuth,
      current.returnRef,
      current.progressOperationRef,
      'I have checked the sources',
    );
    await f.world.restartConnector(f.cafe);
    await f.context.progress(
      f.firstAuth,
      current.returnRef,
      current.progressOperationRef,
      'I have checked the sources',
    );
    await f.context.progress(
      f.firstAuth,
      current.returnRef,
      current.progressOperationRef,
      'The draft is ready for a final pass',
    );
    const work = workOf(f.world, f.work.workId);
    assert.equal(work.lifecycle, 'in_progress');
    assert.equal(work.resultEventId, undefined);
    assert.equal(work.history.filter((entry) => entry.action === 'progress_reported').length, 2);
    const publications = await f.cafe.connector.listWorkResultPublicationCandidates();
    assert.equal(publications.length, 0, 'progress cannot be consumed as an accepted result or Task close');
    const continued = await f.continueWork('Continue A after progress');
    await f.admission.admit(continued.source, CAT);
    await assert.rejects(
      f.context.progress(f.firstAuth, current.returnRef, current.progressOperationRef, 'stale progress'),
      /current|changed|authority/i,
    );
  } finally {
    await f.world.close();
  }
});
