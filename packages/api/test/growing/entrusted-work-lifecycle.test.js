import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { CustodyOfferService } = await import('../../dist/domains/growing/CustodyOfferService.js');
const { EntrustedWorkLifecycleService } = await import('../../dist/domains/growing/EntrustedWorkLifecycleService.js');
const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');
const { tasksRoutes } = await import('../../dist/routes/tasks.js');

const now = 1_788_170_000_000;

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

function noOpSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
  };
}

describe('F310 entrusted-work Task owner lifecycle', () => {
  test('one idempotency key creates one Task and replay returns the same owner coordinates', async () => {
    const store = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });

    const admitted = await lifecycle.admitOrResume(admissionCommand());
    const resumed = await lifecycle.admitOrResume(admissionCommand());
    const tasks = store.listByThread('thread-f310');

    assert.equal(admitted.result, 'admitted');
    assert.equal(resumed.result, 'resumed');
    assert.equal(tasks.length, 1);
    assert.equal(resumed.subjectRef, admitted.subjectRef);
    assert.equal(resumed.ownerRef, admitted.ownerRef);
    assert.equal(resumed.receiptRef, admitted.receiptRef);
    assert.equal(resumed.revision, admitted.revision);
    assert.equal(tasks[0].kind, 'work');
    assert.equal(tasks[0].entrustedWork.revision, 1);
  });

  test('authorized_source fails closed for missing or stale registration and starts empty', async () => {
    const provenance = {
      grantRef: 'grant:f310:meeting',
      grantRevision: 2,
      producerRef: 'producer:meeting',
      grantOwnerRef: 'owner:meeting',
      grantOwnerRevision: 4,
      sourceRef: 'meeting:42',
      sourceRevision: 9,
      matchedScope: 'meeting:owner-1',
      admissionAuthority: 'task_admit_or_resume',
      idempotencySource: 'source_ref_and_revision',
    };
    const command = admissionCommand({
      admission: {
        basis: 'authorized_source',
        authorityProvenance: provenance,
        sourceRefs: ['meeting:42'],
        intendedOutcome: 'Meeting follow-up is delivered',
        idempotencyKey: 'entrusted:meeting:42:9',
      },
    });

    const emptyStore = new TaskStore();
    const emptyRegistry = new EntrustedWorkLifecycleService(emptyStore, { now: () => now });
    await assert.rejects(
      emptyRegistry.admitOrResume(command),
      (error) => error?.code === 'ENTRUSTED_WORK_AUTHORIZATION_MISSING',
    );
    assert.equal(emptyStore.listByThread('thread-f310').length, 0);

    const staleStore = new TaskStore();
    const staleRegistry = new EntrustedWorkLifecycleService(staleStore, {
      now: () => now,
      custodyGrantRegistry: {
        [provenance.grantRef]: {
          grantRef: provenance.grantRef,
          revision: provenance.grantRevision + 1,
          producerRef: provenance.producerRef,
          grantOwnerRef: provenance.grantOwnerRef,
          grantOwnerRevision: provenance.grantOwnerRevision,
          allowedSourceScope: [provenance.matchedScope],
          admissionAuthority: 'task_admit_or_resume',
          validity: { state: 'current', expiresAt: null },
          idempotencySource: provenance.idempotencySource,
        },
      },
    });
    await assert.rejects(
      staleRegistry.admitOrResume(command),
      (error) => error?.code === 'ENTRUSTED_WORK_AUTHORIZATION_STALE',
    );
    assert.equal(staleStore.listByThread('thread-f310').length, 0);

    const currentStore = new TaskStore();
    const currentRegistry = new EntrustedWorkLifecycleService(currentStore, {
      now: () => now,
      custodyGrantRegistry: {
        [provenance.grantRef]: {
          grantRef: provenance.grantRef,
          revision: provenance.grantRevision,
          producerRef: provenance.producerRef,
          grantOwnerRef: provenance.grantOwnerRef,
          grantOwnerRevision: provenance.grantOwnerRevision,
          allowedSourceScope: [provenance.matchedScope],
          admissionAuthority: 'task_admit_or_resume',
          validity: { state: 'current', expiresAt: null },
          idempotencySource: provenance.idempotencySource,
        },
      },
    });
    const admitted = await currentRegistry.admitOrResume(command);
    assert.equal(admitted.result, 'admitted');
    assert.equal(currentStore.listByThread('thread-f310').length, 1);
  });

  test('accepted source cannot claim custody until Task returns a typed result', async () => {
    const messageStore = new MessageStore();
    const taskStore = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(taskStore, { now: () => now });
    const source = messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: 'Please prepare tomorrow presentation',
      mentions: [],
      timestamp: now,
      threadId: 'thread-f310',
    });
    const { deriveGrowingSourceMessageRevision } = await import(
      '../../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const sourceMessageRevision = deriveGrowingSourceMessageRevision(source);
    let releaseAdmission;
    const admissionGate = new Promise((resolve) => {
      releaseAdmission = resolve;
    });
    const custody = new CustodyOfferService(messageStore, {
      admitOrResumeAcceptedOffer: async (command) => {
        await admissionGate;
        return lifecycle.admitOrResume(
          admissionCommand({
            admission: {
              basis: 'accepted_offer',
              sourceRefs: [`message:${command.sourceMessageId}`],
              offerId: command.offerId,
              sourceMessageRevision: command.sourceMessageRevision,
              intendedOutcome: 'A reviewable presentation is ready',
              idempotencyKey: command.idempotencyKey,
            },
          }),
        );
      },
    });
    await custody.recordPendingOffer({
      sourceMessageId: source.id,
      sourceMessageRevision,
      offerId: 'offer-1',
      policyVersion: 'recognition-v1',
      reasonCode: 'future_deliverable',
    });

    const acceptance = custody.acceptOffer({
      sourceMessageId: source.id,
      sourceMessageRevision,
      offerId: 'offer-1',
      actorRef: 'user:owner-1',
      dispositionAt: now + 1,
      idempotencyKey: 'entrusted:offer-1',
    });
    await new Promise((resolve) => setImmediate(resolve));

    const pending = messageStore.getById(source.id).extra.custodyOfferV1;
    assert.equal(pending.disposition, 'accepted');
    assert.equal(pending.admission.state, 'pending');
    assert.equal(taskStore.listByThread('thread-f310').length, 0);

    releaseAdmission();
    const accepted = await acceptance;
    assert.equal(accepted.offer.admission.state, 'resulted');
    assert.equal(accepted.offer.admission.result.result, 'admitted');
    assert.equal(taskStore.listByThread('thread-f310').length, 1);
  });

  test('typed closure atomically sets done and increments the entrusted-work revision', async () => {
    const store = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admission = await lifecycle.admitOrResume(admissionCommand());
    const taskId = admission.ownerRef.replace('task:item:', '');

    await assert.rejects(
      async () => store.update(taskId, { status: 'done' }),
      (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
    );

    const closed = await lifecycle.close({
      taskId,
      expectedRevision: 1,
      closure: {
        state: 'satisfied',
        condition: 'The final presentation is reviewable',
        expectedSignal: 'artifact:final-presentation',
        evidenceRefs: ['artifact:presentation:v3'],
      },
    });

    assert.equal(closed.status, 'done');
    assert.equal(closed.entrustedWork.revision, 2);
    assert.equal(closed.entrustedWork.closure.state, 'satisfied');
    assert.deepEqual(closed.entrustedWork.closure.evidenceRefs, ['artifact:presentation:v3']);

    const replay = await lifecycle.admitOrResume(admissionCommand());
    assert.equal(replay.result, 'resumed');
    assert.equal(replay.revision, 2);
    assert.equal(store.listByThread('thread-f310').length, 1);
  });

  test('typed nonterminal update replaces Artifact refs, patches time, and fences revision and terminal state', async () => {
    const store = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admission = await lifecycle.admitOrResume(
      admissionCommand({
        time: {
          businessDeadline: { value: now + 86_400_000, sourceRef: 'message:source-1' },
          reviewBy: { value: now + 43_200_000, sourceRef: 'message:source-1' },
        },
      }),
    );
    const taskId = admission.ownerRef.replace('task:item:', '');

    const updated = await lifecycle.update({
      taskId,
      expectedRevision: 1,
      time: { reviewBy: null },
      artifactRefs: ['artifact:ppt:z', 'artifact:ppt:a', 'artifact:ppt:z'],
    });

    assert.equal(updated.id, taskId);
    assert.equal(updated.threadId, 'thread-f310');
    assert.equal(updated.ownerCatId, 'codex-sol');
    assert.equal(updated.entrustedWork.revision, 2);
    assert.deepEqual(updated.entrustedWork.artifactRefs, ['artifact:ppt:a', 'artifact:ppt:z']);
    assert.deepEqual(updated.entrustedWork.time, {
      businessDeadline: { value: now + 86_400_000, sourceRef: 'message:source-1' },
    });

    await assert.rejects(
      lifecycle.update({ taskId, expectedRevision: 1, artifactRefs: ['artifact:ppt:stale'] }),
      (error) => error?.code === 'ENTRUSTED_WORK_REVISION_CONFLICT',
    );
    await assert.rejects(
      lifecycle.update({ taskId, expectedRevision: 2 }),
      (error) => error?.code === 'ENTRUSTED_WORK_NO_OP',
    );

    await lifecycle.close({
      taskId,
      expectedRevision: 2,
      closure: {
        state: 'satisfied',
        condition: 'The final presentation is reviewable',
        expectedSignal: 'artifact:final-presentation',
        evidenceRefs: ['artifact:ppt:a'],
      },
    });
    await assert.rejects(
      lifecycle.update({ taskId, expectedRevision: 3, time: { reviewBy: null } }),
      (error) => error?.code === 'ENTRUSTED_WORK_ALREADY_CLOSED',
    );
    assert.equal(store.get(taskId).entrustedWork.closure.state, 'satisfied');
  });

  test('generic HTTP and callback/MCP updates reject entrusted work with 409', async () => {
    const taskStore = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(taskStore, { now: () => now });
    const admission = await lifecycle.admitOrResume(admissionCommand());
    const taskId = admission.ownerRef.replace('task:item:', '');
    const socketManager = noOpSocketManager();

    const webApp = Fastify();
    await webApp.register(tasksRoutes, { taskStore, socketManager });
    const webResult = await webApp.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'done' },
    });
    assert.equal(webResult.statusCode, 409);
    const metadataOnlyWebResult = await webApp.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { title: 'Stale generic title' },
    });
    assert.equal(metadataOnlyWebResult.statusCode, 409);

    const callbackApp = Fastify();
    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    await callbackApp.register(callbacksRoutes, { registry, messageStore, socketManager, taskStore });
    const credentials = await registry.create('owner-1', 'codex-sol', 'thread-f310');
    const callbackResult = await callbackApp.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: {
        'x-invocation-id': credentials.invocationId,
        'x-callback-token': credentials.callbackToken,
      },
      payload: { taskId, status: 'done' },
    });
    assert.equal(callbackResult.statusCode, 409);
    const metadataOnlyCallbackResult = await callbackApp.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: {
        'x-invocation-id': credentials.invocationId,
        'x-callback-token': credentials.callbackToken,
      },
      payload: { taskId, why: 'Stale generic rationale' },
    });
    assert.equal(metadataOnlyCallbackResult.statusCode, 409);
    assert.equal(taskStore.get(taskId).status, 'todo');
  });
});
