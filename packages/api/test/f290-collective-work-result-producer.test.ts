import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CollectiveConnector, CollectiveWorkResultPublication } from '@cat-cafe/collective-connector';
import type { CollectiveWorkProjection, TaskItem } from '@cat-cafe/shared';
import { F290CollectiveWorkResultProducerAdapter } from '../src/domains/growing/F290CollectiveWorkResultProducerAdapter.js';

const taskId = 'task-result';
const taskRef = `task:work:${taskId}`;
const sourceMessageId = 'source-message';

function task(): TaskItem {
  return {
    id: taskId,
    threadId: 'thread-private',
    title: 'Prepare the Collective result',
    why: 'Owner admitted Work',
    status: 'doing',
    createdBy: 'user',
    ownerCatId: 'codex-sol',
    userId: 'owner',
    kind: 'work',
    createdAt: 1,
    updatedAt: 2,
    entrustedWork: {
      revision: 3,
      admission: {
        basis: 'authorized_source',
        sourceRefs: [`message:${sourceMessageId}`],
        idempotencyKey: 'collective-result',
        receiptRef: 'task:receipt:collective-result',
        admittedAt: 1,
        authorityRef: 'message:owner-admission',
      },
      intendedOutcome: 'A reviewable result is ready',
      time: {},
      artifactRefs: ['artifact:result'],
      closure: {
        condition: 'The Collective result is accepted',
        expectedSignal: 'collective:accepted-result',
        state: 'open',
        evidenceRefs: [],
      },
    },
  };
}

function work(): CollectiveWorkProjection {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_aaaaaaaa',
    sourceEventId: 'evt_source0000',
    sourceLocation: { channelId: 'general' },
    title: 'Prepared Collective result',
    intendedOutcome: 'A reviewable result is ready',
    proposedBy: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
    accountableHumanId: 'human_aaaaaaaa',
    assignment: {
      humanId: 'human_aaaaaaaa',
      connectionId: 'con_aaaaaaaa',
      catId: 'codex-sol',
      displayName: 'Sol',
      participationRevision: 1,
      assignedAt: '2026-09-19T12:00:00.000Z',
    },
    assignmentEventId: 'evt_assignment0',
    dependencyWorkIds: [],
    lifecycle: 'result_ready',
    status: 'result_ready',
    resultEventId: 'evt_result0000',
    resultRevision: 2,
    revision: 4,
    createdAt: '2026-09-19T12:00:00.000Z',
    updatedAt: '2026-09-19T12:01:00.000Z',
    history: [],
  };
}

function publication(): CollectiveWorkResultPublication {
  return {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_aaaaaaaa',
    authorizedHumanId: 'human_aaaaaaaa',
    localOwnerUserId: 'owner',
    assignmentEventId: 'evt_assignment0',
    channelId: 'general',
    catId: 'codex-sol',
    taskRef,
    taskRevision: 3,
    workId: 'work_aaaaaaaa',
    resultEventId: 'evt_result0000',
    resultRevision: 2,
    artifactSnapshot: {
      taskRef,
      taskRevision: 3,
      artifactRef: 'artifact:result',
      artifactRevision: '7',
      completenessRef: 'artifact:result#complete:7',
      previewRef: 'artifact:result#preview:7',
      openInWorkspaceRef: 'workspace:artifact:thread-private:7:artifact:result',
    },
  };
}

function sourceMessage() {
  return {
    id: sourceMessageId,
    threadId: 'thread-public-source',
    userId: 'owner',
    catId: null,
    content: 'Prepare the Collective result',
    timestamp: 1,
    source: {
      connector: 'collective',
      label: 'Collective',
      meta: {
        participation: {
          serviceInstanceId: 'svc_aaaaaaaa',
          collectiveId: 'col_aaaaaaaa',
          connectionId: 'con_aaaaaaaa',
          eventId: 'evt_assignment0',
          location: { channelId: 'general' },
          catId: 'codex-sol',
          participationRevision: 1,
          actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
        },
      },
    },
  };
}

function fixture() {
  let currentTask = task();
  let currentWork = work();
  let currentPublication = publication();
  let currentSource = sourceMessage();
  let currentArtifact = { ...currentPublication.artifactSnapshot };
  const connector = {
    async listWorkResultPublicationCandidates() {
      return [
        {
          connectionId: currentPublication.connectionId,
          workId: currentPublication.workId,
          taskRef: currentPublication.taskRef,
        },
      ];
    },
    async withAssignedWorkAuthority(connectionId: string, workId: string, consume: (scope: unknown) => unknown) {
      assert.equal(connectionId, currentPublication.connectionId);
      assert.equal(workId, currentPublication.workId);
      return consume({
        connection: {
          serviceInstanceId: currentPublication.serviceInstanceId,
          collectiveId: currentPublication.collectiveId,
          connectionId,
          authorizedHumanId: currentPublication.authorizedHumanId,
          authorityStatus: 'connected',
        },
        hostRoute: { localOwnerUserId: currentPublication.localOwnerUserId },
        inbox: [],
        work: structuredClone(currentWork),
        resultPublications: [
          structuredClone({ ...currentPublication, resultEventId: 'evt_result_old', resultRevision: 1 }),
          structuredClone(currentPublication),
        ],
      });
    },
  } as unknown as CollectiveConnector;
  const adapter = new F290CollectiveWorkResultProducerAdapter({
    connector: () => connector,
    tasks: {
      async get(id) {
        return id === taskId ? structuredClone(currentTask) : null;
      },
      async listByKind() {
        return [structuredClone(currentTask)];
      },
    },
    messages: {
      async getById(id) {
        return id === sourceMessageId ? structuredClone(currentSource) : null;
      },
    },
    artifacts: {
      async readPreparedArtifact() {
        if (!currentArtifact) return null;
        const { taskRef: _taskRef, taskRevision: _taskRevision, ...artifact } = currentArtifact;
        return structuredClone(artifact);
      },
    },
  });
  return {
    adapter,
    mutateTask(mutator: (value: TaskItem) => TaskItem) {
      currentTask = mutator(currentTask);
    },
    mutateWork(mutator: (value: CollectiveWorkProjection) => CollectiveWorkProjection) {
      currentWork = mutator(currentWork);
    },
    mutatePublication(mutator: (value: CollectiveWorkResultPublication) => CollectiveWorkResultPublication) {
      currentPublication = mutator(currentPublication);
    },
    mutateSource(mutator: (value: ReturnType<typeof sourceMessage>) => ReturnType<typeof sourceMessage>) {
      currentSource = mutator(currentSource);
    },
    mutateArtifact(mutator: (value: typeof currentArtifact) => typeof currentArtifact) {
      currentArtifact = mutator(currentArtifact);
    },
  };
}

describe('F290 Collective result Needs Me producer', () => {
  test('projects one current owner-backed result and exposes only public exact-return coordinates', async () => {
    const f = fixture();
    const receipts = await f.adapter.listCurrentReceipts('owner');
    assert.equal(receipts.length, 1);
    assert.deepEqual(receipts[0], {
      eligible: true,
      producer: {
        producerId: 'f290.collective_work_result',
        ownerRef: 'collective-result:con_aaaaaaaa:work_aaaaaaaa',
        subjectRef: 'collective-result:con_aaaaaaaa:work_aaaaaaaa',
        revision: 4,
      },
      taskRef: { subjectRef: taskRef, observedRevision: 3 },
      kind: 'judgment',
      reasonCode: 'collective_result_ready',
      recommendation: 'Review the prepared result in its Collective Work',
      salience: 'normal',
      action: {
        actionRef:
          '/collective?connectionId=con_aaaaaaaa&workId=work_aaaaaaaa&workRevision=4&channelId=general&resultEventId=evt_result0000&resultRevision=2',
        expectedProducerRevision: 4,
      },
      reEvaluateActionRef: 'collective-result:con_aaaaaaaa:work_aaaaaaaa#reevaluate',
    });
    assert.equal(receipts[0]?.eligible && receipts[0].action.actionRef.includes(taskId), false);
    assert.deepEqual(
      await f.adapter.readCurrentReceipt({
        ownerUserId: 'owner',
        producerSubjectRef: 'collective-result:con_aaaaaaaa:work_aaaaaaaa',
      }),
      receipts[0],
    );
  });

  test('fails closed for stale Task, Work, source, authority, or Artifact coordinates', async () => {
    const cases = [
      (f: ReturnType<typeof fixture>) =>
        f.mutateTask((value) => ({
          ...value,
          entrustedWork: value.entrustedWork ? { ...value.entrustedWork, revision: 4 } : value.entrustedWork,
        })),
      (f: ReturnType<typeof fixture>) =>
        f.mutateWork((value) => ({ ...value, lifecycle: 'completed', status: 'completed' })),
      (f: ReturnType<typeof fixture>) =>
        f.mutatePublication((value) => ({ ...value, resultRevision: value.resultRevision + 1 })),
      (f: ReturnType<typeof fixture>) =>
        f.mutateSource((value) => ({
          ...value,
          source: value.source
            ? {
                ...value.source,
                meta: {
                  ...value.source.meta,
                  participation: { ...value.source.meta.participation, connectionId: 'con_bbbbbbbb' },
                },
              }
            : value.source,
        })),
      (f: ReturnType<typeof fixture>) =>
        f.mutatePublication((value) => ({ ...value, localOwnerUserId: 'another-owner' })),
      (f: ReturnType<typeof fixture>) =>
        f.mutateArtifact((value) => (value ? { ...value, artifactRevision: '8' } : value)),
      (f: ReturnType<typeof fixture>) => f.mutatePublication((value) => ({ ...value, artifactSnapshot: undefined })),
    ];
    for (const mutate of cases) {
      const f = fixture();
      mutate(f);
      assert.deepEqual(await f.adapter.listCurrentReceipts('owner'), []);
    }
  });
});
