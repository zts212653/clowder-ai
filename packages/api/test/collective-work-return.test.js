import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { catRegistry } from '@cat-cafe/shared';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { assembleCollectiveContext } from '../dist/domains/cats/services/context/ContextAssembler.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { F232PreparedArtifactReader } from '../dist/domains/growing/F232PreparedArtifactReader.js';
import { CollectiveCurrentContext } from '../dist/domains/plugin/builtin-runtime/collective-current-context.js';
import { CollectiveWorkAuthority } from '../dist/domains/plugin/builtin-runtime/collective-work-authority.js';
import { CollectiveWorkDispatcher } from '../dist/domains/plugin/builtin-runtime/collective-work-dispatcher.js';

catRegistry.register('codex-astra', {
  ...catRegistry.tryGet('codex-sol').config,
  id: 'codex-astra',
  displayName: 'Astra',
  defaultModel: 'gpt-6-astra',
});

function fixture() {
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const operations = new Map();
  const source = {
    serviceInstanceId: 'svc_100000000000',
    collectiveId: 'col_100000000000',
    connectionId: 'con_100000000000',
    eventId: 'evt_100000000000',
    location: { channelId: 'A', rootEventId: 'evt_100000000000' },
    catId: 'codex-astra',
    participationRevision: 1,
    actor: { kind: 'human', humanId: 'human_guest00000', displayName: 'Guest' },
  };
  const event = {
    ...source,
    sequence: 1,
    body: 'Prepare a useful answer',
    acceptedAt: new Date().toISOString(),
    clientEventId: 'request',
    target: { kind: 'agent', humanId: 'human_owner00000', agentId: source.catId },
    recipient: {
      kind: 'agent',
      humanId: 'human_owner00000',
      agentId: source.catId,
      connectionId: source.connectionId,
      participationRevision: 1,
    },
  };
  const message = messages.append({
    userId: 'owner',
    threadId: 'public',
    catId: null,
    content: event.body,
    mentions: [],
    timestamp: 1,
    source: { connector: 'collective', label: 'Collective', meta: { participation: source, workRequest: 'entrust' } },
  });
  const state = {
    revoked: false,
    sends: 0,
    standing: false,
    attentionRevision: 0,
    interests: {},
    preparedArtifact: null,
    artifactReads: [],
    replyArtifactAttempts: [],
    submittedArtifact: undefined,
  };
  const connector = {
    async currentWorkDecision() {
      return { decisionMode: 'automatic', delegationState: 'unavailable', grants: [] };
    },
    async readParticipationContext(actual) {
      if (state.revoked) throw Object.assign(new Error('Revoked'), { code: 'PARTICIPATION_REVOKED' });
      assert.deepEqual(actual, source);
      return { source: event, events: [event] };
    },
    async readWorkSourceContext(actual) {
      await this.readParticipationContext(actual);
      return { sourceEventId: actual.eventId, matters: [], relatedWorkIds: [], hasMore: false };
    },
    async getHostRoute() {
      return {
        localOwnerUserId: 'owner',
        revision: 1,
        attentionRevision: state.attentionRevision,
        standingInterests: state.interests,
        agentRoutes: {
          'human_owner00000:codex-astra': {
            catId: 'codex-astra',
            threadId: 'public',
            participation: { displayName: 'Astra', channelIds: ['A'] },
          },
          'human_owner00000:codex-sol': {
            catId: 'codex-sol',
            threadId: 'public',
            participation: { displayName: 'Host-published Sol', channelIds: ['A'] },
          },
        },
      };
    },
    async getProjection() {
      return { authorizedHumanId: 'human_owner00000' };
    },
    async setStandingInterest(connectionId, input, expectedRevision) {
      assert.equal(connectionId, source.connectionId);
      assert.equal(input.catId, source.catId);
      assert.equal(input.channelId, source.location.channelId);
      if (expectedRevision !== state.attentionRevision)
        throw Object.assign(new Error('Conflict'), { code: 'ATTENTION_REVISION_CONFLICT' });
      state.attentionRevision++;
      state.interests = {
        [input.channelId]: {
          [input.catId]: {
            catId: input.catId,
            kind: 'response_requests',
            status: input.state === 'listen' ? 'active' : 'withdrawn',
            revision: state.attentionRevision,
            updatedAt: new Date().toISOString(),
          },
        },
      };
      return this.getHostRoute();
    },
    async prepareReply(_, ref, key, _workRevision, resultRevision = 1) {
      const id = `${ref}:${key}:${resultRevision}`;
      if (!operations.has(id)) operations.set(id, { outboxId: randomUUID(), resultRevision, status: 'prepared' });
      return operations.get(id);
    },
    async submitReply(actual, ref, key, operationId, body, agent, artifactSnapshot) {
      await this.readParticipationContext(actual);
      state.replyArtifactAttempts.push(artifactSnapshot);
      const operation = [...operations.values()].find((candidate) => candidate.outboxId === operationId);
      assert.ok(operation, `prepared operation ${operationId} must exist for ${ref}:${key}`);
      if (operation.status !== 'prepared') {
        if (operation.body !== body) throw Object.assign(new Error('Conflict'), { code: 'REPLY_OPERATION_CONFLICT' });
        return;
      }
      state.submittedArtifact = artifactSnapshot;
      Object.assign(operation, {
        body,
        agent,
        status: 'accepted',
        acceptedEventId: `evt_result00000${operation.resultRevision}`,
      });
      state.sends++;
    },
    async sync() {},
  };
  const standingGrant = async () =>
    state.standing
      ? {
          threadId: 'private',
          grant: {
            grantRef: 'host:standing',
            revision: 1,
            producerRef: 'host:collective-standing-work',
            grantOwnerRef: 'user:owner',
            grantOwnerRevision: 1,
            allowedSourceScope: [`message:${message.id}`],
            admissionAuthority: 'task_admit_or_resume',
            validity: { state: 'current', expiresAt: null },
            idempotencySource: 'source_ref_and_revision',
          },
        }
      : undefined;
  const work = new CollectiveWorkAuthority({
    messageStore: messages,
    taskStore: tasks,
    standingGrant,
    resolveWorkThread: async () => 'private',
  });
  const restart = () =>
    new CollectiveCurrentContext({
      connector: () => connector,
      messageStore: messages,
      threadStore: { get: () => ({ createdBy: 'owner', participants: ['codex-astra'] }) },
      workAuthority: new CollectiveWorkAuthority({ messageStore: messages, taskStore: tasks, standingGrant }),
      artifactReader: {
        async readPreparedArtifact(input) {
          state.artifactReads.push(structuredClone(input));
          return state.preparedArtifact
            ? structuredClone(state.preparedArtifact)
            : new F232PreparedArtifactReader({ messages }).readPreparedArtifact(input);
        },
      },
    });
  return { messages, tasks, message, source, event, state, work, restart, operations };
}
async function publicAuth(f) {
  const registry = new InvocationRegistry();
  const created = await registry.create(
    'owner',
    f.source.catId,
    'public',
    undefined,
    undefined,
    { mode: 'collective_participation' },
    f.message.id,
    'unknown',
    undefined,
    { kind: 'collective-participation', originTriggerMessageId: f.message.id, source: f.source },
  );
  return (await registry.verify(created.invocationId, created.callbackToken)).record;
}
async function admit(f, overrides = {}) {
  return f.work.admit({
    ownerUserId: 'owner',
    ownerAuthProvenance: 'strict',
    source: f.message,
    catId: 'codex-astra',
    threadId: 'private',
    requestId: randomUUID(),
    title: 'Public request result',
    intendedOutcome: f.message.content,
    closure: { condition: 'A reviewable result answers the request', expectedSignal: 'collective:accepted-result' },
    ...overrides,
  });
}
async function privateAuth(f, result, revision = result.revision, resultRevision = 1) {
  const taskId = result.subjectRef.slice('task:work:'.length);
  const trigger = f.messages.append({
    userId: 'owner',
    threadId: 'private',
    catId: null,
    content: 'Resume current Work',
    mentions: [],
    timestamp: Date.now(),
    extra: { collectiveWorkInvocationV1: { v: 1, taskId, observedRevision: revision, resultRevision } },
  });
  const context = f.restart();
  const input = {
    userId: 'owner',
    threadId: 'private',
    catId: 'codex-astra',
    ownerAuthProvenance: 'strict',
    originTriggerMessageId: trigger.id,
  };
  const binding = await context.resolvePrivate(input, 'admission');
  const registry = new InvocationRegistry();
  const auth = await registry.create(
    'owner',
    'codex-astra',
    'private',
    undefined,
    undefined,
    undefined,
    trigger.id,
    'unknown',
    undefined,
    undefined,
    {
      v: 1,
      taskId,
      observedRevision: revision,
      resultRevision,
      sourceRef: binding.sourceRef,
      authorityRef: binding.work.authorityRef,
    },
  );
  return { context, auth: (await registry.verify(auth.invocationId, auth.callbackToken)).record, trigger, input };
}

test('owner admission uses the canonical Task, and public origin alone never authorizes private Work', async () => {
  const f = fixture();
  await assert.rejects(admit(f, { ownerAuthProvenance: 'unknown' }), { code: 'OWNER_ADMISSION_UNAVAILABLE' });
  assert.equal(f.tasks.listByKind('work').length, 0);
  assert.equal(await f.work.admitStanding(f.message, 'codex-astra'), undefined);
  const result = await admit(f);
  const replay = await admit(f);
  assert.equal(result.subjectRef, replay.subjectRef);
  assert.equal(f.tasks.listByKind('work').length, 1);
  const task = f.tasks.listByKind('work')[0];
  assert.deepEqual(task.entrustedWork.admission.sourceRefs, [`message:${f.message.id}`]);
  assert.equal(JSON.stringify(task).includes(f.source.connectionId), false);
  const { context, auth } = await privateAuth(f, result);
  const current = await context.current(auth);
  assert.equal(current.authority, 'owner_admitted_work');
  assert.deepEqual(current.location, f.source.location);
});

test('the admitted owner can delegate the same private Work to a named home Cat without changing Task ownership', async () => {
  const f = fixture();
  const result = await admit(f);
  const taskId = result.subjectRef.slice('task:work:'.length);
  const delegation = f.messages.append({
    userId: 'owner',
    threadId: 'private',
    catId: 'codex-astra',
    content: '@codex-sol 请沿这个已准入的工作核实现有实现，并把结果回到原处。',
    mentions: ['codex-sol'],
    origin: 'callback',
    timestamp: Date.now(),
    extra: {
      isExplicitPost: true,
      collectiveWorkDelegationV1: {
        v: 1,
        taskId,
        observedRevision: result.revision,
        ownerCatId: 'codex-astra',
        targetCatIds: ['codex-sol'],
      },
    },
  });

  const context = f.restart();
  const delegated = await context.resolvePrivate(
    {
      userId: 'owner',
      threadId: 'private',
      catId: 'codex-sol',
      ownerAuthProvenance: 'strict',
      originTriggerMessageId: delegation.id,
    },
    'admission',
  );

  assert.ok(delegated, 'an explicit owner-authenticated home delegation should preserve the admitted Work binding');
  assert.equal(delegated.work.task.id, taskId);
  assert.equal(delegated.work.task.ownerCatId, 'codex-astra');
  assert.equal(delegated.sourceRef, `message:${f.message.id}`);
  const registry = new InvocationRegistry();
  const created = await registry.create(
    'owner',
    'codex-sol',
    'private',
    undefined,
    undefined,
    undefined,
    delegation.id,
    'unknown',
    undefined,
    undefined,
    {
      v: 1,
      taskId,
      observedRevision: result.revision,
      sourceRef: delegated.sourceRef,
      authorityRef: delegated.work.authorityRef,
    },
  );
  const auth = (await registry.verify(created.invocationId, created.callbackToken)).record;
  const current = await context.current(auth);
  assert.equal(current.authority, 'owner_admitted_work');
  assert.equal(current.participant, 'Host-published Sol');
  const returned = await context.reply(auth, current.returnRef, current.replyOperationRef, 'Result from delegated Cat');
  assert.equal(returned.reply.author.agentId, 'codex-sol');
  assert.equal(f.state.sends, 1);
  await assert.rejects(
    f.restart().resolvePrivate(
      {
        userId: 'owner',
        threadId: 'private',
        catId: 'opus',
        ownerAuthProvenance: 'strict',
        originTriggerMessageId: delegation.id,
      },
      'admission',
    ),
    { code: 'OWNER_ADMISSION_UNAVAILABLE' },
  );
});
test('an authenticated public Cat can persist only its current Channel standing interest', async () => {
  const f = fixture();
  const context = f.restart();
  const auth = await publicAuth(f);
  const current = await context.current(auth);
  assert.deepEqual(current.workSourceContext, {
    sourceEventId: f.source.eventId,
    matters: [],
    relatedWorkIds: [],
    hasMore: false,
  });
  assert.equal((await context.setInterest(auth, current.contextRef, 'listen')).attentionRevision, 1);
  assert.equal(f.state.interests.A['codex-astra'].status, 'active');
  await assert.rejects(context.setInterest(auth, `${current.contextRef}-forged`, 'withdraw'), {
    code: 'RETURN_REF_INVALID',
  });
  assert.equal(f.state.attentionRevision, 1);
});

test('admission response loss and Host restart recover one durable execution instead of queuing another', async () => {
  const f = fixture();
  const result = await admit(f);
  const task = f.tasks.get(result.subjectRef.slice(10));
  let starts = 0;
  const restart = () =>
    new CollectiveWorkDispatcher({
      context: f.restart,
      messageStore: f.messages,
      threadStore: { get: () => ({ createdBy: 'owner', participants: ['codex-astra'] }) },
      invocationQueue: new InvocationQueue(),
      queueProcessor: {
        async processNext() {
          starts++;
        },
      },
    });
  const first = await restart().dispatch(task, 'owner', result.revision, { kind: 'admission' });
  f.messages.getById(first.messageId).deliveryStatus = 'delivered';
  const replay = await restart().dispatch(task, 'owner', result.revision, { kind: 'admission' });
  assert.equal(replay.messageId, first.messageId);
  assert.equal(starts, 1);
  // An explicit owner retry has its own stable request, and retrying that request is also durable.
  const resume = { kind: 'resume', requestId: randomUUID() };
  const next = await restart().dispatch(task, 'owner', result.revision, resume);
  assert.notEqual(next.messageId, first.messageId);
  await restart().dispatch(task, 'owner', result.revision, resume);
  assert.equal(starts, 2);
});

test('Work revision and restart re-sign refs while preserving the same result operation and original author', async () => {
  const f = fixture();
  const result = await admit(f);
  const first = await privateAuth(f, result);
  const current = await first.context.current(first.auth);
  const sent = await first.context.reply(first.auth, current.returnRef, current.replyOperationRef, 'Result A');
  assert.equal(sent.reply.status, 'accepted');
  await f.tasks.updateEntrustedWork(result.subjectRef.slice('task:work:'.length), {
    expectedRevision: 1,
    artifactRefs: ['artifact:result'],
  });
  await assert.rejects(privateAuth(f, result), { code: 'OWNER_ADMISSION_UNAVAILABLE' });
  const next = await privateAuth(f, result, 2);
  const recovered = await next.context.current(next.auth);
  assert.equal(recovered.reply.eventId, sent.reply.eventId);
  assert.notEqual(recovered.returnRef, current.returnRef);
  assert.equal(recovered.reply.author.sessionRef, first.auth.invocationId);
  await assert.rejects(next.context.reply(next.auth, current.returnRef, current.replyOperationRef, 'Result A'), {
    code: 'RETURN_REF_INVALID',
  });
  await assert.rejects(next.context.reply(next.auth, recovered.returnRef, recovered.replyOperationRef, 'Result A'), {
    code: 'WORK_ARTIFACT_UNAVAILABLE',
  });
  const artifactPublication = f.messages.append({
    userId: 'owner',
    threadId: 'private',
    catId: 'codex-astra',
    content: 'Published result A',
    mentions: [],
    timestamp: Date.now(),
    origin: 'callback',
    extra: {
      rich: { v: 1, blocks: [{ kind: 'file', v: 1, id: 'result-a', fileName: 'result-a.md', url: 'artifact:result' }] },
    },
  });
  await next.context.reply(next.auth, recovered.returnRef, recovered.replyOperationRef, 'Result A');
  assert.deepEqual(f.state.replyArtifactAttempts.at(-1), {
    taskRef: result.subjectRef,
    taskRevision: 2,
    artifactRef: 'artifact:result',
    artifactRevision: String(artifactPublication.timestamp),
    completenessRef: `message:private:${artifactPublication.id}#available:${artifactPublication.timestamp}`,
    previewRef: `message:private:${artifactPublication.id}#preview:${artifactPublication.timestamp}`,
    openInWorkspaceRef: `workspace:artifact:private:${artifactPublication.timestamp}:artifact:result`,
  });
  await assert.rejects(next.context.reply(next.auth, recovered.returnRef, recovered.replyOperationRef, 'Result B'), {
    code: 'REPLY_OPERATION_CONFLICT',
  });
  assert.equal(f.state.sends, 1);
  assert.equal(f.operations.size, 1);
});

test('a requested result revision gets a distinct durable return operation on the same Work', async () => {
  const f = fixture();
  const result = await admit(f);
  const first = await privateAuth(f, result, result.revision, 1);
  const v1 = await first.context.current(first.auth);
  const returnedV1 = await first.context.reply(first.auth, v1.returnRef, v1.replyOperationRef, 'Result v1');

  const second = await privateAuth(f, result, result.revision, 2);
  const v2 = await second.context.current(second.auth);
  assert.notEqual(v2.returnRef, v1.returnRef);
  assert.notEqual(v2.replyOperationRef, v1.replyOperationRef);
  await assert.rejects(second.context.reply(second.auth, v1.returnRef, v1.replyOperationRef, 'Result v2'), {
    code: 'RETURN_REF_INVALID',
  });
  const returnedV2 = await second.context.reply(second.auth, v2.returnRef, v2.replyOperationRef, 'Result v2');

  assert.notEqual(returnedV2.reply.eventId, returnedV1.reply.eventId);
  assert.equal(f.tasks.listByKind('work')[0].ownerCatId, 'codex-astra');
  assert.equal(f.state.sends, 2);
  assert.equal(f.operations.size, 2);
});

test('a private Work result seals only the current owner-derived prepared Artifact coordinate', async () => {
  const f = fixture();
  const result = await admit(f);
  const taskId = result.subjectRef.slice('task:work:'.length);
  await f.tasks.updateEntrustedWork(taskId, { expectedRevision: 1, artifactRefs: ['artifact:result'] });
  f.state.preparedArtifact = {
    artifactRef: 'artifact:result',
    artifactRevision: '7',
    completenessRef: 'artifact:result#complete:7',
    previewRef: 'artifact:result#preview:7',
    openInWorkspaceRef: 'workspace:artifact:private:7:artifact:result',
  };
  const { context, auth } = await privateAuth(f, result, 2);
  const current = await context.current(auth);
  await context.reply(auth, current.returnRef, current.replyOperationRef, 'Prepared result');
  assert.deepEqual(f.state.artifactReads, [
    {
      artifactRef: 'artifact:result',
      taskThreadId: 'private',
      taskSubjectRef: result.subjectRef,
      taskOwnerRef: `task:item:${taskId}`,
      taskRevision: 2,
      ownerUserId: 'owner',
      viewer: { surface: 'cat', userId: 'owner', threadId: 'private', catId: 'codex-astra' },
    },
  ]);
  assert.deepEqual(f.state.submittedArtifact, {
    taskRef: result.subjectRef,
    taskRevision: 2,
    ...f.state.preparedArtifact,
  });
});

test('revoke, source loss, owner receipt loss and ambiguous sources preserve Work but cannot send', async () => {
  for (const scenario of ['revoked', 'source', 'owner', 'ambiguous']) {
    const f = fixture();
    const result = await admit(f);
    const { context, auth } = await privateAuth(f, result);
    const current = await context.current(auth);
    const task = f.tasks.listByKind('work')[0];
    if (scenario === 'revoked') f.state.revoked = true;
    if (scenario === 'source') f.message.deletedAt = 2;
    if (scenario === 'owner') f.messages.getById(task.entrustedWork.admission.authorityRef.slice(8)).deletedAt = 2;
    if (scenario === 'ambiguous') task.entrustedWork.admission.sourceRefs.push('message:another-source');
    await assert.rejects(context.reply(auth, current.returnRef, current.replyOperationRef, 'No wrong return'));
    assert.equal(f.state.sends, 0);
    assert.equal(f.tasks.get(task.id).status, 'todo');
  }
});

test('explicit sustained requests can consume current standing grants; revocation blocks later private admission', async () => {
  const f = fixture();
  f.state.standing = true;
  const result = await f.work.admitStanding(f.message, 'codex-astra');
  assert.equal(result.result, 'admitted');
  await privateAuth(f, result);
  f.state.standing = false;
  await assert.rejects(privateAuth(f, result), { code: 'OWNER_ADMISSION_UNAVAILABLE' });
  assert.equal(f.tasks.listByKind('work').length, 1);
});

test('automatic public serialization has only the admitted Channel/root and no deleted/private previews', () => {
  const f = fixture();
  const projected = assembleCollectiveContext(
    [
      f.event,
      { ...f.event, eventId: 'evt_B00000000000', body: 'B_CANARY', location: { channelId: 'B' } },
      {
        ...f.event,
        eventId: 'evt_C00000000000',
        body: 'OTHER_ROOT_CANARY',
        location: { channelId: 'A', rootEventId: 'evt_other0000000' },
      },
    ],
    { kind: 'collective-participation', originTriggerMessageId: f.message.id, source: f.source },
  );
  assert.match(projected, /Prepare a useful answer/);
  assert.doesNotMatch(projected, /CANARY/);
});
