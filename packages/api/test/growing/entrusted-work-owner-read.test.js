import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { EntrustedWorkLifecycleService } = await import('../../dist/domains/growing/EntrustedWorkLifecycleService.js');
const { EntrustedWorkOwnerReadService } = await import('../../dist/domains/growing/EntrustedWorkOwnerReadService.js');
const { F232PreparedArtifactReader } = await import('../../dist/domains/growing/F232PreparedArtifactReader.js');
const { F246NeedsMeProducerAdapter, F292NeedsMeProducerAdapter, F306NeedsMeProducerAdapter } = await import(
  '../../dist/domains/growing/NeedsMeProducerAdapter.js'
);
const { NeedsMeProducerCatalog } = await import('../../dist/domains/growing/NeedsMeProducerCatalog.js');
const { registerEntrustedWorkReadRoutes } = await import('../../dist/routes/entrusted-work-read-routes.js');

const now = 1_788_180_000_000;

function admissionCommand() {
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
    time: {
      businessDeadline: { value: now + 86_400_000, sourceRef: 'message:source-1' },
      reviewBy: { value: now + 43_200_000, sourceRef: 'message:source-1' },
    },
    artifactRefs: ['artifact:ppt:tomorrows-ppt'],
  };
}

function ineligibleAdapter(producerId) {
  return {
    producerId,
    async listCurrentReceipts() {
      return [];
    },
    async readCurrentReceipt() {
      return null;
    },
  };
}

function catalogWith(primary) {
  const byId = {
    'f246.approval': ineligibleAdapter('f246.approval'),
    'f292.repair': ineligibleAdapter('f292.repair'),
    'f306.runtime_interaction': ineligibleAdapter('f306.runtime_interaction'),
    [primary.producerId]: primary,
  };
  return new NeedsMeProducerCatalog(Object.values(byId));
}

function artifactReader() {
  return {
    async readPreparedArtifact({ artifactRef, taskRevision }) {
      return {
        artifactRef,
        artifactRevision: '7',
        completenessRef: `${artifactRef}#completeness:7`,
        previewRef: `${artifactRef}#preview:7`,
        openInWorkspaceRef: `workspace:${artifactRef}:${taskRevision}`,
      };
    },
  };
}

describe('F310 entrusted-work owner-read backbone', () => {
  test('F232 adapter resolves one exact existing Artifact snapshot without copying its payload', async () => {
    const reader = new F232PreparedArtifactReader({
      messages: {
        async getByThread() {
          return [];
        },
        async getByThreadBefore() {
          return [];
        },
      },
      tasks: {
        async listByThread() {
          return [];
        },
      },
      threads: {
        async getThreadMemory() {
          return {
            v: 1,
            summary: '',
            keyDecisions: [],
            unresolved: [],
            recentArtifacts: [
              {
                type: 'file',
                ref: 'artifact:ppt:tomorrows-ppt',
                label: 'Tomorrow presentation',
                updatedAt: now + 7,
                updatedBy: 'codex-sol',
              },
            ],
            updatedAt: now + 7,
          };
        },
      },
    });

    const prepared = await reader.readPreparedArtifact({
      artifactRef: 'artifact:ppt:tomorrows-ppt',
      taskThreadId: 'thread-f310',
      taskSubjectRef: 'task:work:ppt',
      taskOwnerRef: 'task:item:ppt',
      taskRevision: 3,
      ownerUserId: 'owner-1',
    });

    assert.deepEqual(prepared, {
      artifactRef: 'artifact:ppt:tomorrows-ppt',
      artifactRevision: String(now + 7),
      completenessRef: `artifact:ppt:tomorrows-ppt#available:${now + 7}`,
      previewRef: `artifact:ppt:tomorrows-ppt#preview:${now + 7}`,
      openInWorkspaceRef: `workspace:artifact:thread-f310:${now + 7}:artifact:ppt:tomorrows-ppt`,
    });
  });

  test('global Schedule read lists only the owner current admitted work with business time', async () => {
    const taskStore = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(taskStore, { now: () => now });
    const quiet = await lifecycle.admitOrResume(admissionCommand());
    await lifecycle.admitOrResume({
      ...admissionCommand(),
      task: { ...admissionCommand().task, title: 'Other owner work', userId: 'owner-2' },
      admission: { ...admissionCommand().admission, idempotencyKey: 'entrusted:other-owner' },
    });
    await lifecycle.admitOrResume({
      ...admissionCommand(),
      task: { ...admissionCommand().task, title: 'No business time' },
      admission: { ...admissionCommand().admission, idempotencyKey: 'entrusted:no-time' },
      time: {},
    });
    taskStore.create({
      threadId: 'thread-f310',
      title: 'Unadmitted conversation candidate',
      why: 'A normal Task must not masquerade as admitted custody',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: 'owner-1',
    });
    const service = new EntrustedWorkOwnerReadService({
      tasks: taskStore,
      producerCatalog: catalogWith(ineligibleAdapter('f246.approval')),
      artifactReader: artifactReader(),
    });
    const registry = new InvocationRegistry();
    const app = Fastify();
    registerEntrustedWorkReadRoutes(app, { service, callbackRegistry: registry });

    const response = await app.inject({
      method: 'GET',
      url: '/api/entrusted-work/owner-reads',
      headers: { 'x-cat-cafe-user': 'owner-1' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ownerReads.length, 1);
    assert.equal(response.json().ownerReads[0].envelope.ownerRef, quiet.ownerRef);
    assert.deepEqual(
      response.json().ownerReads[0].timeRefs.map(({ role }) => role),
      ['business_deadline', 'review_by'],
    );
    assert.equal(
      response.json().ownerReads[0].preparedArtifact.openInWorkspaceRef,
      'workspace:artifact:ppt:tomorrows-ppt:1',
    );
  });

  test('Web JSON and cat callback return the same owner refs, Artifact, and time semantics', async () => {
    const taskStore = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(taskStore, { now: () => now });
    const admission = await lifecycle.admitOrResume(admissionCommand());
    const taskId = admission.ownerRef.replace('task:item:', '');
    const canonicalBefore = await taskStore.get(taskId);
    let taskReads = 0;
    const service = new EntrustedWorkOwnerReadService({
      tasks: {
        async get(id) {
          taskReads += 1;
          return taskStore.get(id);
        },
      },
      producerCatalog: catalogWith(ineligibleAdapter('f246.approval')),
      artifactReader: artifactReader(),
    });
    const registry = new InvocationRegistry();
    const app = Fastify();
    registerEntrustedWorkReadRoutes(app, { service, callbackRegistry: registry });

    const web = await app.inject({
      method: 'GET',
      url: `/api/entrusted-work/${taskId}/owner-read`,
      headers: { 'x-cat-cafe-user': 'owner-1' },
    });
    assert.equal(web.statusCode, 200);

    const credentials = await registry.create('owner-1', 'codex-sol', 'thread-f310', undefined, undefined, {
      mode: 'read_only',
      replayDeniedToolNames: [],
    });
    const cat = await app.inject({
      method: 'POST',
      url: '/api/callbacks/read-entrusted-work',
      headers: {
        'x-invocation-id': credentials.invocationId,
        'x-callback-token': credentials.callbackToken,
      },
      payload: { taskId },
    });
    assert.equal(cat.statusCode, 200);
    assert.deepEqual(cat.json(), web.json());
    assert.deepEqual(
      web.json().ownerRead.timeRefs.map(({ role }) => role),
      ['business_deadline', 'review_by'],
    );
    assert.equal(web.json().ownerRead.preparedArtifact.artifactRevision, '7');
    assert.equal(taskReads, 2);
    assert.deepEqual(await taskStore.get(taskId), canonicalBefore, 'owner-read must not write Task truth');
  });

  test('a typed Artifact attachment refreshes the same owner read with the F232 Workspace coordinate', async () => {
    const taskStore = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(taskStore, { now: () => now });
    const admission = await lifecycle.admitOrResume({ ...admissionCommand(), artifactRefs: [] });
    const taskId = admission.ownerRef.replace('task:item:', '');
    const service = new EntrustedWorkOwnerReadService({
      tasks: taskStore,
      producerCatalog: catalogWith(ineligibleAdapter('f246.approval')),
      artifactReader: new F232PreparedArtifactReader({
        messages: {
          async getByThread() {
            return [];
          },
          async getByThreadBefore() {
            return [];
          },
        },
        tasks: taskStore,
        threads: {
          async getThreadMemory() {
            return {
              v: 1,
              summary: '',
              keyDecisions: [],
              unresolved: [],
              recentArtifacts: [
                {
                  type: 'file',
                  ref: 'artifact:ppt:tomorrows-ppt',
                  label: 'Tomorrow presentation',
                  updatedAt: now + 7,
                  updatedBy: 'codex-sol',
                },
              ],
              updatedAt: now + 7,
            };
          },
        },
      }),
    });

    const before = await service.read({ taskId, viewer: { surface: 'human', userId: 'owner-1' } });
    assert.equal(before.preparedArtifact, undefined);

    await lifecycle.update({
      taskId,
      expectedRevision: 1,
      artifactRefs: ['artifact:ppt:tomorrows-ppt'],
    });
    const after = await service.read({ taskId, viewer: { surface: 'human', userId: 'owner-1' } });
    assert.equal(after.envelope.ownerRef, before.envelope.ownerRef);
    assert.equal(after.envelope.revision, 2);
    assert.equal(after.preparedArtifact.artifactRef, 'artifact:ppt:tomorrows-ppt');
    assert.equal(
      after.preparedArtifact.openInWorkspaceRef,
      `workspace:artifact:thread-f310:${now + 7}:artifact:ppt:tomorrows-ppt`,
    );
  });

  test('stale reads are inert and mismatched or stale producer actions fail closed', async () => {
    const task = {
      id: 'task-7',
      threadId: 'thread-f310',
      title: 'Prepare tomorrow presentation',
      why: '',
      status: 'doing',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: 'owner-1',
      kind: 'work',
      subjectKey: 'entrusted:fixture',
      createdAt: now,
      updatedAt: now,
      entrustedWork: {
        revision: 7,
        admission: {
          basis: 'explicit_entrustment',
          sourceRefs: ['message:source-1'],
          idempotencyKey: 'entrusted:fixture',
          receiptRef: 'task:receipt:fixture',
          admittedAt: now,
        },
        intendedOutcome: 'A reviewable presentation is ready',
        time: {},
        artifactRefs: [],
        closure: {
          condition: 'The final presentation is reviewable',
          expectedSignal: 'artifact:final-presentation',
          state: 'open',
          evidenceRefs: [],
        },
      },
    };
    const tasks = {
      async get() {
        return structuredClone(task);
      },
    };
    const actionable = {
      producerId: 'f246.approval',
      async listCurrentReceipts() {
        return [this.receipt('approval:F246:ppt-direction')];
      },
      receipt(producerSubjectRef) {
        return {
          eligible: true,
          producer: {
            producerId: 'f246.approval',
            ownerRef: producerSubjectRef,
            subjectRef: producerSubjectRef,
            revision: 12,
          },
          taskRef: { subjectRef: 'task:work:task-7', observedRevision: 7 },
          kind: 'judgment',
          reasonCode: 'artifact_direction_choice',
          recommendation: 'Use the evidence-first narrative',
          salience: 'normal',
          action: { actionRef: `${producerSubjectRef}#decide`, expectedProducerRevision: 12 },
          reEvaluateActionRef: `${producerSubjectRef}#reevaluate`,
        };
      },
      async readCurrentReceipt({ producerSubjectRef }) {
        return this.receipt(producerSubjectRef);
      },
    };
    const service = new EntrustedWorkOwnerReadService({
      tasks,
      producerCatalog: catalogWith(actionable),
    });
    const stale = await service.read({
      taskId: task.id,
      observedRevision: 6,
      viewer: { surface: 'human', userId: 'owner-1' },
    });
    assert.equal(stale.envelope.freshness.state, 'stale');
    assert.deepEqual(stale.attentionReceipts, []);

    const mismatched = {
      ...actionable,
      async listCurrentReceipts() {
        const receipt = actionable.receipt('approval:F246:ppt-direction');
        return [{ ...receipt, taskRef: { ...receipt.taskRef, subjectRef: 'task:work:wrong' } }];
      },
    };
    const invalid = new EntrustedWorkOwnerReadService({ tasks, producerCatalog: catalogWith(mismatched) });
    const withoutMismatchedAction = await invalid.read({
      taskId: task.id,
      viewer: { surface: 'human', userId: 'owner-1' },
    });
    assert.deepEqual(withoutMismatchedAction.attentionReceipts, []);
  });

  test('closed producer adapters preserve owner identity, revision, and exact action coordinates', async () => {
    const taskRef = { subjectRef: 'task:work:ppt', observedRevision: 7 };
    const f292 = new F292NeedsMeProducerAdapter({
      async get() {
        return {
          intakeId: 'meeting-1',
          ownerId: 'owner-1',
          sourceState: 'auth_required',
          judgmentState: 'unresolved',
          executionState: 'idle',
          healthState: 'degraded',
          unresolved: ['destination'],
          repair: { code: 'auth_required', action: 'regrant', observedAt: now },
          entrustedWorkTaskRef: taskRef,
          revision: 4,
        };
      },
    });
    const meeting = await f292.readCurrentReceipt({
      ownerUserId: 'owner-1',
      producerSubjectRef: 'meeting-1',
    });
    const meetingAgain = await f292.readCurrentReceipt({
      ownerUserId: 'owner-1',
      producerSubjectRef: 'meeting-1',
    });
    assert.deepEqual(meetingAgain, meeting, 'a repeated owner read preserves the producer revision');
    assert.equal(meeting.producer.revision, 4);
    assert.match(meeting.action.actionRef, /meeting-intakes\/meeting-1\/regrant$/);

    const f306 = new F306NeedsMeProducerAdapter({
      async get() {
        return {
          request: {
            interactionId: 'interaction-1',
            kind: 'question',
            title: 'Choose the visual direction',
            createdAt: now,
            owner: { userId: 'owner-1', catId: 'codex-sol', threadId: 'thread-f310', invocationId: 'inv-1' },
            entrustedWorkTaskRef: taskRef,
          },
          status: 'pending',
          updatedAt: now + 1,
          cardRef: { threadId: 'thread-f310', messageId: 'message-1', blockId: 'block-1' },
        };
      },
    });
    const interaction = await f306.readCurrentReceipt({
      ownerUserId: 'owner-1',
      producerSubjectRef: 'interaction-1',
    });
    const interactionAgain = await f306.readCurrentReceipt({
      ownerUserId: 'owner-1',
      producerSubjectRef: 'interaction-1',
    });
    assert.deepEqual(interactionAgain, interaction, 'a repeated owner read preserves the producer revision');
    assert.equal(interaction.producer.revision, now + 1);
    assert.equal(interaction.action.actionRef, 'message:thread-f310:message-1#block-1');

    const approvalAdapter = {
      featureId: 'F128',
      async listPending() {
        return [
          {
            proposalId: 'ppt-direction',
            sourceFeatureId: 'F128',
            requesterCatId: 'codex-sol',
            ownerUserId: 'owner-1',
            status: 'pending',
            summary: 'Use the evidence-first narrative',
            detail: {},
            navigation: {
              state: 'anchored',
              originRef: { kind: 'message', threadId: 'thread-f310', messageId: 'message-2' },
              approvalCardRef: { threadId: 'thread-f310', messageId: 'message-2' },
            },
            inlineApprovable: true,
            createdAt: now + 2,
            entrustedWorkTaskRef: taskRef,
          },
        ];
      },
    };
    const f246 = new F246NeedsMeProducerAdapter({
      get() {
        return { adapter: approvalAdapter };
      },
    });
    const approval = await f246.readCurrentReceipt({
      ownerUserId: 'owner-1',
      producerSubjectRef: 'approval:F128:ppt-direction',
    });
    const approvalAgain = await f246.readCurrentReceipt({
      ownerUserId: 'owner-1',
      producerSubjectRef: 'approval:F128:ppt-direction',
    });
    assert.deepEqual(approvalAgain, approval, 'a repeated owner read preserves the producer revision');
    assert.equal(approval.producer.revision, now + 2);
    assert.equal(approval.action.expectedProducerRevision, now + 2);
  });
});
