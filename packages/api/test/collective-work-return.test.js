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
import { CollectiveCurrentContext } from '../dist/domains/plugin/builtin-runtime/collective-current-context.js';
import { CollectiveWorkAuthority } from '../dist/domains/plugin/builtin-runtime/collective-work-authority.js';
import { CollectiveWorkDispatcher } from '../dist/domains/plugin/builtin-runtime/collective-work-dispatcher.js';
import { adaptMessageStore } from './helpers/message-from-fixtures.js';

catRegistry.register('codex-astra', {
  ...catRegistry.tryGet('codex-sol').config,
  id: 'codex-astra',
  displayName: 'Astra',
  defaultModel: 'gpt-6-astra',
});

function fixture() {
  const messages = adaptMessageStore(new MessageStore());
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
  const state = { revoked: false, sends: 0, standing: false };
  const connector = {
    async readParticipationContext(actual) {
      if (state.revoked) throw Object.assign(new Error('Revoked'), { code: 'PARTICIPATION_REVOKED' });
      assert.deepEqual(actual, source);
      return { source: event, events: [event] };
    },
    async getHostRoute() {
      return {
        localOwnerUserId: 'owner',
        revision: 1,
        agentRoutes: {
          'human_owner00000:codex-astra': {
            catId: 'codex-astra',
            threadId: 'public',
            participation: { displayName: 'Astra', channelIds: ['A'] },
          },
        },
      };
    },
    async getProjection() {
      return { authorizedHumanId: 'human_owner00000' };
    },
    async prepareReply(_, ref, key) {
      const id = `${ref}:${key}`;
      if (!operations.has(id)) operations.set(id, { outboxId: randomUUID(), status: 'prepared' });
      return operations.get(id);
    },
    async submitReply(actual, ref, key, operationId, body, agent) {
      await this.readParticipationContext(actual);
      const operation = await this.prepareReply(actual, ref, key);
      assert.equal(operation.outboxId, operationId);
      if (operation.status !== 'prepared') {
        if (operation.body !== body) throw Object.assign(new Error('Conflict'), { code: 'REPLY_OPERATION_CONFLICT' });
        return;
      }
      Object.assign(operation, { body, agent, status: 'accepted', acceptedEventId: 'evt_result000000' });
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
  const work = new CollectiveWorkAuthority({ messageStore: messages, taskStore: tasks, standingGrant });
  const restart = () =>
    new CollectiveCurrentContext({
      connector: () => connector,
      messageStore: messages,
      threadStore: { get: () => ({ createdBy: 'owner', participants: ['codex-astra'] }) },
      workAuthority: new CollectiveWorkAuthority({ messageStore: messages, taskStore: tasks, standingGrant }),
    });
  return { messages, tasks, message, source, event, state, work, restart, operations };
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
async function privateAuth(f, result, revision = result.revision) {
  const taskId = result.subjectRef.slice('task:work:'.length);
  const trigger = f.messages.append({
    userId: 'owner',
    threadId: 'private',
    from: { kind: 'system', service: 'collective-work' },
    content: 'Resume current Work',
    mentions: [],
    timestamp: Date.now(),
    extra: { collectiveWorkInvocationV1: { v: 1, taskId, observedRevision: revision } },
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
    'strict',
    undefined,
    undefined,
    { v: 1, taskId, observedRevision: revision, sourceRef: binding.sourceRef, authorityRef: binding.work.authorityRef },
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
  await next.context.reply(next.auth, recovered.returnRef, recovered.replyOperationRef, 'Result A');
  await assert.rejects(next.context.reply(next.auth, recovered.returnRef, recovered.replyOperationRef, 'Result B'), {
    code: 'REPLY_OPERATION_CONFLICT',
  });
  assert.equal(f.state.sends, 1);
  assert.equal(f.operations.size, 1);
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
