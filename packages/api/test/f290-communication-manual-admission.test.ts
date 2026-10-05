import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { EntrustedWorkLifecycleService } from '../src/domains/growing/EntrustedWorkLifecycleService.js';
import { fixture } from './f290-communication-manual-admission.fixture.js';
import { catAccepts, grantAndAdopt, postNaturalRequest, workOf } from './f290-communication-validation.harness.js';
import { CAT, createHost, until } from './f290-communication-validation.host.js';

test('uncommitted requests, proposals and a participation revoked after preflight create no private Thread/Task', async () => {
  const f = await fixture();
  try {
    const before = (await f.host.threads.list(f.host.userId)).length;
    await f.post(f.source.id);
    assert.equal((await f.host.tasks.listByKind('work')).length, 0, 'a raw external source has no Service commitment');
    assert.equal(
      (await f.host.threads.list(f.host.userId)).length,
      before,
      'validate assignment before private Thread creation',
    );
    await f.world.store.proposeCollectiveWork(f.world.operator.sessionToken, {
      ...f.world.coordinates,
      sourceEventId: f.request.eventId,
      requestId: `proposal-${randomUUID()}`,
    });
    await f.post(f.source.id);
    assert.equal((await f.host.tasks.listByKind('work')).length, 0, 'proposal is not a current assignment');
    assert.equal((await f.host.threads.list(f.host.userId)).length, before);
    const { source } = await f.committedSource();
    f.revokeAfterPreflight();
    assert.equal((await f.post(source.id)).statusCode, 409);
    assert.equal(
      (await f.host.tasks.listByKind('work')).length,
      0,
      'fresh fence checks revoked Host participation before birth',
    );
    assert.equal((await f.host.threads.list(f.host.userId)).length, before);
  } finally {
    await f.close();
  }
});

test('a foreign assignment and superseded Service execution cannot birth Work in this owner home', async () => {
  const f = await fixture();
  try {
    const foreignHost = await createHost(f.world, f.world.wulang);
    const foreignRequest = await postNaturalRequest(
      f.world,
      f.world.wulang,
      f.world.wulang,
      CAT,
      'Foreign home guide.',
      foreignHost.participationRevision,
    );
    const proposal = await f.world.store.proposeCollectiveWork(f.world.wulang.sessionToken, {
      ...f.world.coordinates,
      sourceEventId: foreignRequest.eventId,
      requestId: randomUUID(),
    });
    const foreign = await f.world.store.commitCollectiveWork(f.world.wulang.sessionToken, {
      ...f.world.coordinates,
      workId: proposal.workId,
      expectedRevision: proposal.revision,
      requestId: randomUUID(),
      assignment: {
        connectionId: f.world.wulang.connectionId,
        catId: CAT,
        participationRevision: foreignHost.participationRevision,
      },
    });
    await foreignHost.tick();
    const foreignSource = (await foreignHost.messages.getByThread(foreignHost.endpoint.id)).find(
      (message) => message.source?.meta?.participation?.eventId === foreign.assignmentEventId,
    );
    assert.ok(foreignSource?.source);
    const copy = f.host.messages.append({
      userId: f.host.userId,
      threadId: f.host.endpoint.id,
      catId: null,
      content: foreignSource.content,
      mentions: [],
      timestamp: Date.now(),
      source: foreignSource.source,
    });
    const before = (await f.host.threads.list(f.host.userId)).length;
    assert.equal((await f.post(copy.id)).statusCode, 409);
    await grantAndAdopt(f.world, f.world.operator);
    const accepted = await catAccepts(f.world, f.world.operator, f.request);
    await f.world.operator.connector.sync(f.world.operator.connectionId);
    await f.routeWithoutAdmission.dispatchConnection(f.world.operator.connectionId);
    const source = (await f.host.messages.getByThread(f.host.endpoint.id)).find(
      (message) => message.source?.meta?.participation?.eventId === accepted.assignmentEventId,
    );
    assert.ok(source);
    const { work: continued } = await f.continueWork(accepted.workId, 'Continue the same guide under fresh execution.');
    assert.equal(continued.executionAuthority?.revision, 2);
    assert.equal((await f.post(source.id)).statusCode, 409, 'first assignment cannot execute after g2');
    assert.equal((await f.host.tasks.listByKind('work')).length, 0);
    assert.equal((await f.host.threads.list(f.host.userId)).length, before);
  } finally {
    await f.close();
  }
});

test('an actual Agent commitment cannot be humanized or manually born without its production Host admission fact', async () => {
  const f = await fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.host.hooks.holdPrivateRun = () => held;
  try {
    await grantAndAdopt(f.world, f.world.operator);
    const accepted = await catAccepts(f.world, f.world.operator, f.request);
    await f.world.operator.connector.sync(f.world.operator.connectionId);
    await f.routeWithoutAdmission.dispatchConnection(f.world.operator.connectionId);
    const source = (await f.host.messages.getByThread(f.host.endpoint.id)).find(
      (message) => message.source?.meta?.participation?.eventId === accepted.assignmentEventId,
    );
    assert.ok(source?.source?.meta?.participation);
    assert.equal(source.source.meta.participation.actor.kind, 'agent');
    const before = (await f.host.threads.list(f.host.userId)).length;
    assert.equal((await f.post(source.id)).statusCode, 409);
    const tampered = f.host.messages.append({
      userId: f.host.userId,
      threadId: source.threadId,
      catId: null,
      timestamp: Date.now(),
      content: source.content,
      mentions: [],
      source: {
        ...source.source,
        meta: {
          ...source.source?.meta,
          participation: {
            ...source.source.meta.participation,
            actor: { kind: 'human', humanId: f.world.operator.humanId, displayName: 'You' },
          },
        },
      },
    });
    assert.equal(
      (await f.post(tampered.id)).statusCode,
      409,
      'Service actor and exact route receipt reject a Human view',
    );
    assert.equal((await f.host.tasks.listByKind('work')).length, 0);
    assert.equal((await f.host.threads.list(f.host.userId)).length, before);
    await f.host.admission.admit(source, CAT);
    const current = workOf(f.world, accepted.workId);
    assert.equal(current.acceptance?.hostAdmission?.state, 'admitted');
    assert.equal((await f.post(source.id)).statusCode, 200, 'manual action reuses the actual producer fact');
    assert.equal((await f.host.tasks.listByKind('work')).length, 1);
    release();
    await f.host.settle();
    const feedback = 'Revise the actual guide with a newcomer example.';
    const next = await f.continueWork(accepted.workId, feedback);
    const nextHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.host.hooks.holdPrivateRun = () => nextHeld;
    await f.host.admission.admit(next.source, CAT);
    const task = (await f.host.tasks.listByKind('work'))[0];
    assert.ok(task?.entrustedWork);
    assert.equal((await f.post(source.id)).statusCode, 409, 'stale admission cannot revive execution one');
    const resumed = await f.resume(task.id, task.entrustedWork.revision);
    assert.equal(resumed.statusCode, 200, resumed.body);
    const carrier = await f.host.messages.getById(resumed.json().messageId);
    assert.equal(carrier?.extra?.collectiveWorkInvocationV1?.executionRevision, 2);
    assert.ok(carrier?.extra?.collectiveWorkInvocationV1?.executionRef);
    assert.ok(
      carrier?.content.includes(JSON.stringify(feedback)),
      'current authority feedback reaches the queued prompt',
    );
    assert.deepEqual(
      task.entrustedWork.admission.sourceRefs,
      [`message:${source.id}`],
      'immutable first admission stays exact',
    );
    assert.equal((await f.host.tasks.listByKind('work')).length, 1);
  } finally {
    release();
    await f.host.settle();
    await f.close();
  }
});

test('an actual Service Human commitment enters the owner lane once and keeps its canonical Work title and outcome', async () => {
  const f = await fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.host.hooks.holdPrivateRun = () => held;
  try {
    const { committed, source } = await f.committedSource();
    assert.equal((await f.host.tasks.listByKind('work')).length, 0);
    assert.equal(source.content, committed.intendedOutcome, 'legacy Human assignment carries the actual outcome');
    const first = await f.post(source.id);
    assert.equal(first.statusCode, 200, first.body);
    const replay = await f.post(source.id);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(first.json().messageId, replay.json().messageId);
    const tasks = await f.host.tasks.listByKind('work');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.title, committed.title);
    assert.equal(tasks[0]?.entrustedWork?.intendedOutcome, committed.intendedOutcome);
    release();
    await f.host.settle();
    await until(
      () => workOf(f.world, committed.workId).lifecycle === 'result_ready',
      'real Host result returns to the assigned Service Work',
    );
    const before = (await f.host.threads.list(f.host.userId)).length;
    assert.equal((await f.post(source.id)).statusCode, 409, 'returned result requires the current continuation lane');
    const ready = workOf(f.world, committed.workId);
    await f.world.store.acceptCollectiveWorkResult(f.world.operator.sessionToken, {
      ...f.world.coordinates,
      workId: ready.workId,
      expectedRevision: ready.revision,
      resultEventId: ready.resultEventId,
      resultRevision: ready.resultRevision ?? 1,
      requestId: randomUUID(),
    });
    assert.equal((await f.post(source.id)).statusCode, 409, 'closed Work cannot be reborn from the retained source');
    assert.equal((await f.host.tasks.listByKind('work')).length, 1);
    assert.equal((await f.host.threads.list(f.host.userId)).length, before);
  } finally {
    release();
    await f.close();
  }
});

test('manual Human v2 resume dispatches outside the fence with exact feedback, and callback consumers keep only its Task and v1 Artifact', async () => {
  const f = await fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const { committed, source } = await f.committedSource();
    const admitted = await f.post(source.id);
    assert.equal(admitted.statusCode, 200, admitted.body);
    await f.host.settle();
    const task = (await f.host.tasks.listByKind('work'))[0];
    assert.ok(task?.entrustedWork);
    const artifactRef = 'artifact:guide:version-one';
    const publication = f.host.messages.append({
      userId: f.host.userId,
      threadId: task.threadId,
      catId: CAT,
      mentions: [],
      timestamp: Date.now(),
      content: 'v1 reviewable guide publication',
      extra: { rich: { blocks: [{ kind: 'file', v: 1, id: 'guide-v1', fileName: 'guide.md', url: artifactRef }] } },
    });
    const updated = await new EntrustedWorkLifecycleService(f.host.tasks).update({
      taskId: task.id,
      expectedRevision: task.entrustedWork.revision,
      artifactRefs: [artifactRef],
    });
    assert.ok(updated.entrustedWork);
    const feedback = 'Keep the authorized v1 guide and add recovery evidence.';
    const ready = workOf(f.world, committed.workId);
    await f.world.store.requestCollectiveWorkRevision(f.world.operator.sessionToken, {
      ...f.world.coordinates,
      workId: ready.workId,
      expectedRevision: ready.revision,
      resultEventId: ready.resultEventId,
      resultRevision: ready.resultRevision ?? 1,
      feedback,
      requestId: randomUUID(),
    });
    f.host.hooks.holdPrivateRun = () => held;
    const resumed = await f.resume(task.id, updated.entrustedWork.revision);
    assert.equal(resumed.statusCode, 200, resumed.body);
    const trigger = await f.host.messages.getById(resumed.json().messageId);
    assert.ok(trigger?.extra?.collectiveWorkInvocationV1);
    assert.ok(
      trigger.content.includes(JSON.stringify(feedback)),
      'exact verified feedback reaches the actual queued prompt',
    );
    const input = {
      userId: f.host.userId,
      threadId: task.threadId,
      catId: CAT,
      ownerAuthProvenance: 'unknown' as const,
      originTriggerMessageId: trigger.id,
    };
    const binding = await f.host.context.resolvePrivate(input, 'admission');
    assert.ok(binding);
    const auth = await f.registry.create(
      f.host.userId,
      CAT,
      task.threadId,
      undefined,
      undefined,
      undefined,
      trigger.id,
      'unknown',
      undefined,
      undefined,
      {
        ...trigger.extra.collectiveWorkInvocationV1,
        sourceRef: binding.sourceRef,
        authorityRef: binding.work.authorityRef,
      },
    );
    const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
    const sibling = f.host.tasks.create({
      userId: f.host.userId,
      threadId: task.threadId,
      title: 'Unrelated same-thread Task',
      why: 'scope canary',
      createdBy: CAT,
      ownerCatId: CAT,
    });
    const list = await f.app.inject({ method: 'GET', url: '/api/callbacks/list-tasks', headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(
      list.json().tasks.map((item: { id: string }) => item.id),
      [task.id],
    );
    const read = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/read-entrusted-work',
      headers,
      payload: { taskId: task.id, observedRevision: updated.entrustedWork.revision },
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().ownerRead.preparedArtifact.artifactRef, artifactRef);
    assert.ok(read.json().ownerRead.preparedArtifact.previewRef.includes(publication.id));
    const other = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/read-entrusted-work',
      headers,
      payload: { taskId: sibling.id },
    });
    assert.equal(other.statusCode, 403, other.body);
  } finally {
    release();
    await f.host.settle();
    await f.close();
  }
});
