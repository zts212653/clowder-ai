import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { CollectiveWorkAuthority } from '../dist/domains/plugin/builtin-runtime/collective-work-authority.js';
import { CollectiveWorkRevisionReconciler } from '../dist/domains/plugin/builtin-runtime/collective-work-revision-reconciler.js';

async function fixture() {
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const sourceIdentity = {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_aaaaaaaa',
    eventId: 'evt_assignment00',
    location: { channelId: 'general', rootEventId: 'evt_source00000' },
    catId: 'codex-sol',
    participationRevision: 1,
    actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'You' },
  };
  const source = messages.append({
    userId: 'owner',
    threadId: 'thread_public',
    catId: null,
    content: '完成第一版并沿同一 Work 接住反馈。',
    mentions: ['codex-sol'],
    timestamp: 1,
    source: {
      connector: 'collective',
      label: 'Collective',
      meta: { participation: sourceIdentity, workRequest: 'entrust' },
    },
  });
  const authority = new CollectiveWorkAuthority({ messageStore: messages, taskStore: tasks });
  const admission = await authority.admit({
    ownerUserId: 'owner',
    source,
    catId: 'codex-sol',
    threadId: 'thread_private',
    ownerAuthProvenance: 'strict',
    requestId: 'admit-revision-work',
    title: '接住结果反馈',
    intendedOutcome: source.content,
    closure: {
      condition: 'Accountable Human accepts the current result',
      expectedSignal: 'collective:accepted-result',
    },
  });
  const task = tasks.get(admission.subjectRef.slice('task:work:'.length));
  const assignment = {
    humanId: 'human_aaaaaaaa',
    connectionId: 'con_aaaaaaaa',
    catId: 'codex-sol',
    displayName: '小太阳 · 砚砚',
    participationRevision: 1,
    assignedAt: '2026-09-28T00:00:00.000Z',
  };
  const work = {
    v: 1,
    serviceInstanceId: sourceIdentity.serviceInstanceId,
    collectiveId: sourceIdentity.collectiveId,
    workId: 'work_aaaaaaaa',
    sourceEventId: 'evt_source00000',
    sourceLocation: sourceIdentity.location,
    title: '接住结果反馈',
    intendedOutcome: source.content,
    proposedBy: { kind: 'human', humanId: assignment.humanId, displayName: 'You' },
    accountableHumanId: assignment.humanId,
    assignment,
    assignmentEventId: sourceIdentity.eventId,
    dependencyWorkIds: [],
    lifecycle: 'in_progress',
    status: 'in_progress',
    resultEventId: 'evt_result000000',
    resultRevision: 1,
    revision: 4,
    createdAt: assignment.assignedAt,
    updatedAt: assignment.assignedAt,
    history: [
      {
        revision: 4,
        action: 'revision_requested',
        actor: { kind: 'human', humanId: assignment.humanId, displayName: 'You' },
        at: assignment.assignedAt,
        eventId: 'evt_result000000',
        resultRevision: 1,
        note: '请补上重启后的恢复证据。',
      },
    ],
  };
  const revisionEvent = {
    eventId: 'evt_revision00000',
    clientEventId: 'work-revision:work_aaaaaaaa:request-v2',
    sequence: 4,
    serviceInstanceId: sourceIdentity.serviceInstanceId,
    collectiveId: sourceIdentity.collectiveId,
    actor: { kind: 'human', humanId: assignment.humanId, displayName: 'You' },
    target: { kind: 'agent', humanId: assignment.humanId, agentId: assignment.catId },
    location: sourceIdentity.location,
    recipient: {
      kind: 'agent',
      humanId: assignment.humanId,
      connectionId: assignment.connectionId,
      agentId: assignment.catId,
      participationRevision: 1,
    },
    replyToEventId: work.resultEventId,
    workRequest: 'revise',
    workRevisionNotice: {
      v: 1,
      workId: work.workId,
      workRevision: work.revision,
      assignmentEventId: work.assignmentEventId,
      resultEventId: work.resultEventId,
      resultRevision: 1,
    },
    body: '请补上重启后的恢复证据。',
    acceptedAt: '2026-09-28T00:01:00.000Z',
  };
  const inbox = [
    {
      event: {
        ...revisionEvent,
        eventId: work.assignmentEventId,
        clientEventId: 'assignment',
        sequence: 1,
        replyToEventId: work.sourceEventId,
        workRequest: 'entrust',
        workRevisionNotice: undefined,
        body: work.intendedOutcome,
      },
      disposition: 'routed',
      persistedAt: assignment.assignedAt,
      routeReceipt: {
        kind: 'thread_message',
        threadId: source.threadId,
        messageId: source.id,
        catId: assignment.catId,
      },
    },
  ];
  return { messages, tasks, task, work, revisionEvent, inbox };
}

test('resumes the unique admitted Task at the next result revision and rejects stale Service truth', async () => {
  const f = await fixture();
  const calls = [];
  const reconciler = new CollectiveWorkRevisionReconciler({
    messages: f.messages,
    tasks: f.tasks,
    dispatcher: { dispatch: async (...args) => calls.push(args) },
  });

  const resumed = await reconciler.reconcile({
    ownerUserId: 'owner',
    event: f.revisionEvent,
    inbox: f.inbox,
    work: f.work,
  });
  assert.equal(resumed.taskId, f.task.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].id, f.task.id);
  assert.equal(calls[0][1], 'owner');
  assert.equal(calls[0][2], f.task.entrustedWork.revision);
  assert.deepEqual(calls[0][3], {
    kind: 'revision',
    executionRevision: 1,
    sourceRef: f.task.entrustedWork.admission.sourceRefs[0],
    requestId: `collective-work-revision:${f.revisionEvent.eventId}`,
    resultRevision: 2,
    feedbackEventId: f.revisionEvent.eventId,
    feedbackText: f.revisionEvent.body,
  });

  await assert.rejects(
    reconciler.reconcile({
      ownerUserId: 'owner',
      event: f.revisionEvent,
      inbox: f.inbox,
      work: { ...f.work, revision: f.work.revision + 1 },
    }),
    { code: 'COLLECTIVE_REVISION_NOT_CURRENT' },
  );
  assert.equal(calls.length, 1);
});

test('treats a persisted pre-round result without resultRevision as v1 when feedback resumes v2', async () => {
  const f = await fixture();
  const calls = [];
  const reconciler = new CollectiveWorkRevisionReconciler({
    messages: f.messages,
    tasks: f.tasks,
    dispatcher: { dispatch: async (...args) => calls.push(args) },
  });

  await reconciler.reconcile({
    ownerUserId: 'owner',
    event: f.revisionEvent,
    inbox: f.inbox,
    work: { ...f.work, resultRevision: undefined },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3].resultRevision, 2);
});

test('rejects forged feedback authority, mismatched result coordinates, and missing Host truth', async () => {
  const cases = [
    {
      code: 'COLLECTIVE_REVISION_NOT_CURRENT',
      mutate: (f) => ({
        ...f,
        revisionEvent: {
          ...f.revisionEvent,
          actor: { kind: 'human', humanId: 'human_bbbbbbbb', displayName: 'Other member' },
        },
      }),
    },
    {
      code: 'COLLECTIVE_REVISION_NOT_CURRENT',
      mutate: (f) => ({ ...f, revisionEvent: { ...f.revisionEvent, body: 'Forged feedback outside Service history' } }),
    },
    {
      code: 'COLLECTIVE_REVISION_NOT_CURRENT',
      mutate: (f) => ({
        ...f,
        revisionEvent: {
          ...f.revisionEvent,
          workRevisionNotice: { ...f.revisionEvent.workRevisionNotice, resultRevision: 2 },
        },
      }),
    },
    {
      code: 'COLLECTIVE_REVISION_SOURCE_UNAVAILABLE',
      mutate: (f) => ({ ...f, inbox: [] }),
    },
  ];
  for (const { code, mutate } of cases) {
    const f = mutate(await fixture());
    let dispatches = 0;
    const reconciler = new CollectiveWorkRevisionReconciler({
      messages: f.messages,
      tasks: f.tasks,
      dispatcher: {
        dispatch: async () => {
          dispatches++;
        },
      },
    });
    await assert.rejects(
      reconciler.reconcile({ ownerUserId: 'owner', event: f.revisionEvent, inbox: f.inbox, work: f.work }),
      { code },
    );
    assert.equal(dispatches, 0);
  }

  const f = await fixture();
  const reconciler = new CollectiveWorkRevisionReconciler({
    messages: f.messages,
    tasks: new TaskStore(),
    dispatcher: { dispatch: async () => assert.fail('missing Task must not dispatch') },
  });
  await assert.rejects(
    reconciler.reconcile({ ownerUserId: 'owner', event: f.revisionEvent, inbox: f.inbox, work: f.work }),
    { code: 'COLLECTIVE_REVISION_TASK_UNAVAILABLE' },
  );
});
