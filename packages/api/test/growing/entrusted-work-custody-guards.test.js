import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore, deriveGrowingSourceMessageRevision } = await import(
  '../../dist/domains/cats/services/stores/ports/MessageStore.js'
);
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { CustodyOfferService } = await import('../../dist/domains/growing/CustodyOfferService.js');
const { EntrustedWorkLifecycleService } = await import('../../dist/domains/growing/EntrustedWorkLifecycleService.js');
const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');
const { tasksRoutes } = await import('../../dist/routes/tasks.js');

const now = 1_788_170_000_000;

function noOpSocketManager() {
  return { broadcastAgentMessage() {}, broadcastToRoom() {} };
}

function admissionCommand(overrides = {}) {
  return {
    task: {
      threadId: 'thread-f310',
      title: 'Prepare tomorrow presentation',
      why: 'Explicitly entrusted in the source conversation',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: 'owner-1',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source-1'],
      intendedOutcome: 'A reviewable presentation is ready',
      idempotencyKey: 'entrusted:source-1',
    },
    closure: {
      condition: 'The final presentation is reviewable',
      expectedSignal: 'artifact:final-presentation',
    },
    ...overrides,
  };
}

function appendUserMessage(messageStore, { content, threadId = 'thread-f310', timestamp = now }) {
  return messageStore.append({
    userId: 'owner-1',
    catId: null,
    content,
    mentions: ['codex-sol'],
    timestamp,
    threadId,
  });
}

function admissionPayload(admission) {
  return {
    title: 'Held work from canonical source custody',
    admission: {
      ...admission,
      intendedOutcome: 'A reviewable result',
      idempotencyKey: admission.idempotencyKey ?? 'entrusted:forged',
    },
    closure: { condition: 'The result is reviewable', expectedSignal: 'artifact:final' },
  };
}

async function callbackHarness() {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  threadStore.ensureThread('thread-f310', 'F310 entrusted-work test');
  const registry = new InvocationRegistry();
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    socketManager: noOpSocketManager(),
    taskStore,
    threadStore,
  });
  const credentials = await registry.create('owner-1', 'codex-sol', 'thread-f310');
  return {
    app,
    messageStore,
    taskStore,
    threadStore,
    headers: {
      'x-invocation-id': credentials.invocationId,
      'x-callback-token': credentials.callbackToken,
    },
  };
}

async function postAdmission(app, headers, admission) {
  return app.inject({
    method: 'POST',
    url: '/api/callbacks/admit-entrusted-work',
    headers,
    payload: admissionPayload(admission),
  });
}

async function recordOffer(messageStore, source, disposition) {
  const sourceMessageRevision = deriveGrowingSourceMessageRevision(source);
  const offerId = `custody-offer:${source.id}`;
  const idempotencyKey = `entrusted:${offerId}`;
  const custody = new CustodyOfferService(messageStore);
  await custody.recordPendingOffer({
    sourceMessageId: source.id,
    sourceMessageRevision,
    offerId,
    policyVersion: 'f310.phase-b.v1',
    reasonCode: 'future_deliverable',
  });
  if (disposition === 'accepted') {
    await custody.acceptOffer({
      sourceMessageId: source.id,
      sourceMessageRevision,
      offerId,
      actorRef: 'user:owner-1',
      dispositionAt: now + 1,
      idempotencyKey,
    });
  } else {
    await custody.refuseOffer({
      sourceMessageId: source.id,
      sourceMessageRevision,
      offerId,
      disposition,
      actorRef: 'user:owner-1',
      dispositionAt: now + 1,
    });
  }
  return { sourceMessageRevision, offerId, idempotencyKey };
}

describe('F310 entrusted-work custody guards', () => {
  test('generic delete and thread cleanup cannot erase or replay entrusted-work custody', async () => {
    const taskStore = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(taskStore, { now: () => now });
    const admission = await lifecycle.admitOrResume(admissionCommand());
    const taskId = admission.ownerRef.replace('task:item:', '');
    const app = Fastify();
    await app.register(tasksRoutes, { taskStore, socketManager: noOpSocketManager() });

    const deleted = await app.inject({ method: 'DELETE', url: `/api/tasks/${taskId}` });
    assert.equal(deleted.statusCode, 409);
    assert.equal(deleted.json().code, 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED');
    const reassigned = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { ownerCatId: 'opus' },
    });
    assert.equal(reassigned.statusCode, 409);
    assert.equal(taskStore.get(taskId).ownerCatId, 'codex-sol');
    assert.throws(
      () => taskStore.update(taskId, { threadId: 'thread-detached' }),
      (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
    );
    assert.throws(
      () => taskStore.deleteByThread('thread-f310'),
      (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
    );
    const canonical = taskStore.get(taskId);
    for (const mutation of [
      { threadId: canonical.threadId, ownerCatId: 'codex-terra' },
      { threadId: 'thread-detached', ownerCatId: canonical.ownerCatId },
    ]) {
      assert.throws(
        () =>
          taskStore.upsertBySubject({
            subjectKey: canonical.subjectKey,
            threadId: mutation.threadId,
            ownerCatId: mutation.ownerCatId,
            title: 'Generic subject upsert must not move custody',
            why: 'Attempted lifecycle bypass',
            createdBy: 'codex-sol',
            userId: 'owner-1',
          }),
        (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
      );
      assert.equal(taskStore.get(taskId).threadId, 'thread-f310');
      assert.equal(taskStore.get(taskId).ownerCatId, 'codex-sol');
      assert.equal(taskStore.get(taskId).entrustedWork.revision, 1);
    }

    const replay = await lifecycle.admitOrResume(admissionCommand());
    assert.equal(replay.result, 'resumed');
    assert.equal(replay.ownerRef, admission.ownerRef);
    assert.equal(taskStore.listByThread('thread-f310').length, 1);
    await app.close();
  });

  test('direct admission resolves exact same-thread source custody and rejects forged coordinates', async () => {
    const { app, headers, messageStore, taskStore } = await callbackHarness();
    const foreign = appendUserMessage(messageStore, {
      content: 'Foreign responsibility',
      threadId: 'thread-foreign',
    });
    const declinedSource = appendUserMessage(messageStore, {
      content: 'Would you track this?',
      timestamp: now + 2,
    });
    const declinedOffer = await recordOffer(messageStore, declinedSource, 'declined');

    const rejected = [
      await postAdmission(app, headers, { basis: 'explicit_entrustment', sourceRefs: ['message:not-found'] }),
      await postAdmission(app, headers, {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:${foreign.id}`],
      }),
      await postAdmission(app, headers, {
        basis: 'accepted_offer',
        sourceRefs: [`message:${declinedSource.id}`],
        ...declinedOffer,
      }),
    ];
    assert.deepEqual(
      rejected.map((response) => [response.statusCode, response.json().code]),
      [
        [409, 'ENTRUSTED_WORK_SOURCE_NOT_FOUND'],
        [409, 'ENTRUSTED_WORK_SOURCE_SCOPE_MISMATCH'],
        [409, 'ENTRUSTED_WORK_SOURCE_CUSTODY_MISMATCH'],
      ],
    );

    const acceptedSource = appendUserMessage(messageStore, {
      content: 'Yes, please hold this responsibility',
      timestamp: now + 3,
    });
    const acceptedOffer = await recordOffer(messageStore, acceptedSource, 'accepted');
    const acceptedAdmission = {
      basis: 'accepted_offer',
      sourceRefs: [`message:${acceptedSource.id}`],
      ...acceptedOffer,
    };
    for (const mismatch of [
      { ...acceptedAdmission, offerId: `${acceptedOffer.offerId}:forged` },
      { ...acceptedAdmission, sourceMessageRevision: declinedOffer.sourceMessageRevision },
      { ...acceptedAdmission, idempotencyKey: `${acceptedOffer.idempotencyKey}:forged` },
    ]) {
      const response = await postAdmission(app, headers, mismatch);
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, 'ENTRUSTED_WORK_SOURCE_CUSTODY_MISMATCH');
    }
    assert.equal(taskStore.listByThread('thread-f310').length, 0);

    const admitted = await postAdmission(app, headers, acceptedAdmission);
    const resumed = await postAdmission(app, headers, acceptedAdmission);
    assert.equal(admitted.statusCode, 200);
    assert.equal(admitted.json().status, 'admitted');
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json().status, 'resumed');
    assert.equal(resumed.json().task.id, admitted.json().task.id);
    assert.equal(taskStore.listByThread('thread-f310').length, 1);
    await app.close();
  });

  test('Web and callback projections close through the same typed Task owner action', async () => {
    const webStore = new TaskStore();
    const webLifecycle = new EntrustedWorkLifecycleService(webStore, { now: () => now });
    const webAdmission = await webLifecycle.admitOrResume(admissionCommand());
    const webTaskId = webAdmission.ownerRef.replace('task:item:', '');
    const socketManager = noOpSocketManager();
    const webApp = Fastify();
    await webApp.register(tasksRoutes, { taskStore: webStore, socketManager });
    const webClose = await webApp.inject({
      method: 'POST',
      url: `/api/tasks/${webTaskId}/entrusted-work/close`,
      headers: { 'x-cat-cafe-user': 'owner-1' },
      payload: {
        expectedRevision: 1,
        closure: {
          state: 'satisfied',
          condition: 'The final presentation is reviewable',
          expectedSignal: 'artifact:final-presentation',
          evidenceRefs: ['artifact:presentation:web'],
        },
      },
    });
    assert.equal(webClose.statusCode, 200);
    assert.equal(webClose.json().task.entrustedWork.revision, 2);

    const { app, headers, messageStore } = await callbackHarness();
    const source = appendUserMessage(messageStore, { content: 'Please prepare tomorrow presentation' });
    const callbackAdmission = await postAdmission(app, headers, {
      ...admissionCommand().admission,
      sourceRefs: [`message:${source.id}`],
      idempotencyKey: `entrusted:${source.id}`,
    });
    assert.equal(callbackAdmission.statusCode, 200);
    assert.equal(callbackAdmission.json().status, 'admitted');
    const callbackTask = callbackAdmission.json().task;
    const callbackClose = await app.inject({
      method: 'POST',
      url: '/api/callbacks/close-entrusted-work',
      headers,
      payload: {
        taskId: callbackTask.id,
        expectedRevision: callbackTask.entrustedWork.revision,
        closure: {
          state: 'satisfied',
          condition: 'The final presentation is reviewable',
          expectedSignal: 'artifact:final-presentation',
          evidenceRefs: ['artifact:presentation:callback'],
        },
      },
    });
    assert.equal(callbackClose.statusCode, 200);
    assert.equal(callbackClose.json().task.entrustedWork.revision, 2);
    await Promise.all([webApp.close(), app.close()]);
  });

  test('callback owner can typed-update open entrusted work while foreign and stale actors fail closed', async () => {
    const { app, headers, messageStore, taskStore } = await callbackHarness();
    const source = appendUserMessage(messageStore, { content: 'Please prepare tomorrow presentation' });
    const admission = await postAdmission(app, headers, {
      ...admissionCommand().admission,
      sourceRefs: [`message:${source.id}`],
      idempotencyKey: `entrusted:${source.id}`,
    });
    const task = admission.json().task;

    const foreignRegistry = new InvocationRegistry();
    const foreignCredentials = await foreignRegistry.create('owner-1', 'codex-terra', 'thread-f310');
    const foreignApp = Fastify();
    await foreignApp.register(callbacksRoutes, {
      registry: foreignRegistry,
      messageStore,
      socketManager: noOpSocketManager(),
      taskStore,
    });
    const foreign = await foreignApp.inject({
      method: 'POST',
      url: '/api/callbacks/update-entrusted-work',
      headers: {
        'x-invocation-id': foreignCredentials.invocationId,
        'x-callback-token': foreignCredentials.callbackToken,
      },
      payload: { taskId: task.id, expectedRevision: 1, artifactRefs: ['artifact:ppt:foreign'] },
    });
    assert.equal(foreign.statusCode, 403);

    const updated = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-entrusted-work',
      headers,
      payload: {
        taskId: task.id,
        expectedRevision: 1,
        time: { reviewBy: null },
        artifactRefs: ['artifact:ppt:z', 'artifact:ppt:a', 'artifact:ppt:z'],
      },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().status, 'updated');
    assert.equal(updated.json().task.entrustedWork.revision, 2);
    assert.deepEqual(updated.json().task.entrustedWork.artifactRefs, ['artifact:ppt:a', 'artifact:ppt:z']);

    const stale = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-entrusted-work',
      headers,
      payload: { taskId: task.id, expectedRevision: 1, artifactRefs: ['artifact:ppt:stale'] },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, 'ENTRUSTED_WORK_REVISION_CONFLICT');

    const noOp = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-entrusted-work',
      headers,
      payload: { taskId: task.id, expectedRevision: 2 },
    });
    assert.equal(noOp.statusCode, 409);
    assert.equal(noOp.json().code, 'ENTRUSTED_WORK_NO_OP');
    assert.equal(taskStore.get(task.id).entrustedWork.revision, 2);
    await Promise.all([app.close(), foreignApp.close()]);
  });

  test('soft-deleted invocation Thread blocks typed update and close with zero Task mutation', async () => {
    const { app, headers, messageStore, taskStore, threadStore } = await callbackHarness();
    const source = appendUserMessage(messageStore, { content: 'Please prepare tomorrow presentation' });
    const admission = await postAdmission(app, headers, {
      ...admissionCommand().admission,
      sourceRefs: [`message:${source.id}`],
      idempotencyKey: `entrusted:${source.id}`,
    });
    assert.equal(admission.statusCode, 200);
    const task = admission.json().task;
    assert.equal(threadStore.softDelete('thread-f310'), true);

    const update = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-entrusted-work',
      headers,
      payload: { taskId: task.id, expectedRevision: 1, artifactRefs: ['artifact:deleted-thread-write'] },
    });
    assert.equal(update.statusCode, 410);
    assert.equal(update.json().code, 'THREAD_DELETED');

    const close = await app.inject({
      method: 'POST',
      url: '/api/callbacks/close-entrusted-work',
      headers,
      payload: {
        taskId: task.id,
        expectedRevision: 1,
        closure: {
          state: 'satisfied',
          condition: 'The final presentation is reviewable',
          expectedSignal: 'artifact:final-presentation',
          evidenceRefs: ['artifact:deleted-thread-write'],
        },
      },
    });
    assert.equal(close.statusCode, 410);
    assert.equal(close.json().code, 'THREAD_DELETED');

    const unchanged = taskStore.get(task.id);
    assert.equal(unchanged.entrustedWork.revision, 1);
    assert.deepEqual(unchanged.entrustedWork.artifactRefs, []);
    assert.equal(unchanged.entrustedWork.closure.state, 'open');
    await app.close();
  });
});
