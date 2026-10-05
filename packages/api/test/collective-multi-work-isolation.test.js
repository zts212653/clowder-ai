import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { catRegistry } from '@cat-cafe/shared';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { F232PreparedArtifactReader } from '../dist/domains/growing/F232PreparedArtifactReader.js';
import { CollectiveCurrentContext } from '../dist/domains/plugin/builtin-runtime/collective-current-context.js';
import { CollectiveWorkAuthority } from '../dist/domains/plugin/builtin-runtime/collective-work-authority.js';

catRegistry.register('codex-astra', {
  ...catRegistry.tryGet('codex-sol').config,
  id: 'codex-astra',
  displayName: 'Astra',
  defaultModel: 'gpt-6-astra',
});

function fixture() {
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const sources = new Map();
  const operations = new Map();
  const accepted = [];

  const connector = {
    async readParticipationContext(actual) {
      const entry = sources.get(actual.eventId);
      assert.ok(entry, `unknown source event ${actual.eventId}`);
      assert.deepEqual(actual, entry.source);
      return { source: entry.event, events: [entry.event] };
    },
    async getHostRoute() {
      return {
        localOwnerUserId: 'owner',
        revision: 1,
        agentRoutes: {
          'human_owner00000:codex-astra': {
            catId: 'codex-astra',
            threadId: 'public-channel',
            participation: { displayName: 'Astra', channelIds: ['shared-channel'] },
          },
        },
      };
    },
    async getProjection() {
      return { authorizedHumanId: 'human_owner00000' };
    },
    async prepareReply(source, sourceRef, resultKey, workRevision, resultRevision = 1) {
      const coordinate = [source.eventId, sourceRef, resultKey, workRevision, resultRevision].join(':');
      if (!operations.has(coordinate)) {
        operations.set(coordinate, {
          outboxId: randomUUID(),
          sourceEventId: source.eventId,
          resultKey,
          resultRevision,
          status: 'prepared',
        });
      }
      return operations.get(coordinate);
    },
    async submitReply(source, sourceRef, resultKey, operationId, body, agent, artifactSnapshot, resultRevision = 1) {
      await this.readParticipationContext(source);
      const operation = [...operations.values()].find((candidate) => candidate.outboxId === operationId);
      assert.ok(operation, `prepared operation ${operationId} must exist for ${sourceRef}:${resultKey}`);
      assert.equal(operation.sourceEventId, source.eventId);
      assert.equal(operation.resultKey, resultKey);
      assert.equal(operation.resultRevision, resultRevision);
      if (operation.status !== 'prepared') {
        if (operation.body !== body) throw Object.assign(new Error('Conflict'), { code: 'REPLY_OPERATION_CONFLICT' });
        return;
      }
      Object.assign(operation, {
        body,
        agent,
        artifactSnapshot,
        status: 'accepted',
        acceptedEventId: `result:${source.eventId}:${resultRevision}`,
      });
      accepted.push({ sourceEventId: source.eventId, resultKey, resultRevision, body });
    },
    async sync() {},
  };

  const work = new CollectiveWorkAuthority({ messageStore: messages, taskStore: tasks });
  const context = () =>
    new CollectiveCurrentContext({
      connector: () => connector,
      messageStore: messages,
      threadStore: {
        get: (threadId) =>
          ['public-channel', 'private-a', 'private-b'].includes(threadId)
            ? { createdBy: 'owner', participants: ['codex-astra'] }
            : null,
      },
      workAuthority: new CollectiveWorkAuthority({ messageStore: messages, taskStore: tasks }),
      artifactReader: new F232PreparedArtifactReader({ messages }),
    });

  function addSource(label) {
    const eventId = `evt_work_${label}0000000`;
    const source = {
      serviceInstanceId: 'svc_100000000000',
      collectiveId: 'col_100000000000',
      connectionId: 'con_100000000000',
      eventId,
      location: { channelId: 'shared-channel', rootEventId: eventId },
      catId: 'codex-astra',
      participationRevision: 1,
      actor: { kind: 'human', humanId: 'human_guest00000', displayName: 'Guest' },
    };
    const event = {
      ...source,
      sequence: label === 'a' ? 1 : 2,
      body: `Prepare result ${label.toUpperCase()}`,
      acceptedAt: new Date().toISOString(),
      clientEventId: `request-${label}`,
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
      threadId: 'public-channel',
      catId: null,
      content: event.body,
      mentions: [],
      timestamp: label === 'a' ? 1 : 2,
      source: { connector: 'collective', label: 'Collective', meta: { participation: source, workRequest: 'entrust' } },
    });
    const entry = { event, message, source, privateThreadId: `private-${label}` };
    sources.set(eventId, entry);
    return entry;
  }

  return { accepted, addSource, context, messages, operations, tasks, work };
}

async function admit(fixture, entry) {
  return fixture.work.admit({
    ownerUserId: 'owner',
    ownerAuthProvenance: 'strict',
    source: entry.message,
    catId: 'codex-astra',
    threadId: entry.privateThreadId,
    requestId: randomUUID(),
    title: entry.event.body,
    intendedOutcome: entry.event.body,
    closure: { condition: 'Return the exact result', expectedSignal: 'collective:accepted-result' },
  });
}

async function privateInvocation(fixture, entry, admission, observedRevision, resultRevision) {
  const taskId = admission.subjectRef.slice('task:work:'.length);
  const trigger = fixture.messages.append({
    userId: 'owner',
    threadId: entry.privateThreadId,
    catId: null,
    content: `Run result ${resultRevision}`,
    mentions: [],
    timestamp: Date.now(),
    extra: { collectiveWorkInvocationV1: { v: 1, taskId, observedRevision, resultRevision } },
  });
  const context = fixture.context();
  const binding = await context.resolvePrivate(
    {
      userId: 'owner',
      threadId: entry.privateThreadId,
      catId: 'codex-astra',
      ownerAuthProvenance: 'strict',
      originTriggerMessageId: trigger.id,
    },
    'admission',
  );
  const registry = new InvocationRegistry();
  const created = await registry.create(
    'owner',
    'codex-astra',
    entry.privateThreadId,
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
      observedRevision,
      resultRevision,
      sourceRef: binding.sourceRef,
      authorityRef: binding.work.authorityRef,
    },
  );
  return { auth: (await registry.verify(created.invocationId, created.callbackToken)).record, context, taskId };
}

test('two Works in one Channel keep private Threads, revisions, and return operations isolated', async () => {
  const f = fixture();
  const sourceA = f.addSource('a');
  const sourceB = f.addSource('b');
  const admittedA = await admit(f, sourceA);
  const admittedB = await admit(f, sourceB);
  const runA1 = await privateInvocation(f, sourceA, admittedA, 1, 1);
  const runB1 = await privateInvocation(f, sourceB, admittedB, 1, 1);
  const currentA1 = await runA1.context.current(runA1.auth);
  const currentB1 = await runB1.context.current(runB1.auth);

  assert.equal(currentA1.request.eventId, sourceA.event.eventId);
  assert.equal(currentB1.request.eventId, sourceB.event.eventId);
  assert.notEqual(currentA1.workRef.subjectRef, currentB1.workRef.subjectRef);
  assert.notEqual(currentA1.returnRef, currentB1.returnRef);
  assert.notEqual(currentA1.replyOperationRef, currentB1.replyOperationRef);
  await assert.rejects(
    runA1.context.reply(runA1.auth, currentB1.returnRef, currentB1.replyOperationRef, 'crossed result'),
    { code: 'RETURN_REF_INVALID' },
  );

  const returnedB1 = await runB1.context.reply(
    runB1.auth,
    currentB1.returnRef,
    currentB1.replyOperationRef,
    'Result B v1',
  );
  const returnedA1 = await runA1.context.reply(
    runA1.auth,
    currentA1.returnRef,
    currentA1.replyOperationRef,
    'Result A v1',
  );
  assert.notEqual(returnedA1.reply.eventId, returnedB1.reply.eventId);

  await f.tasks.updateEntrustedWork(runA1.taskId, { expectedRevision: 1, artifactRefs: ['artifact:a'] });
  const refreshedA1 = await runA1.context.current(runA1.auth);
  assert.notEqual(refreshedA1.returnRef, currentA1.returnRef);
  await assert.rejects(
    runA1.context.reply(runA1.auth, refreshedA1.returnRef, refreshedA1.replyOperationRef, 'Result A v1'),
    { code: 'WORK_ARTIFACT_UNAVAILABLE' },
  );
  await assert.rejects(
    runA1.context.reply(runA1.auth, currentA1.returnRef, currentA1.replyOperationRef, 'stale A result'),
    { code: 'RETURN_REF_INVALID' },
  );
  assert.equal((await runB1.context.current(runB1.auth)).reply.body, 'Result B v1');

  const artifactPublication = f.messages.append({
    userId: 'owner',
    threadId: 'private-a',
    catId: 'codex-astra',
    content: 'Published result A',
    mentions: [],
    timestamp: Date.now(),
    origin: 'callback',
    extra: {
      rich: { v: 1, blocks: [{ kind: 'file', v: 1, id: 'result-a', fileName: 'result-a.md', url: 'artifact:a' }] },
    },
  });
  const runA2 = await privateInvocation(f, sourceA, admittedA, 2, 2);
  const currentA2 = await runA2.context.current(runA2.auth);
  assert.notEqual(currentA2.returnRef, currentA1.returnRef);
  await runA2.context.reply(runA2.auth, currentA2.returnRef, currentA2.replyOperationRef, 'Result A v2');
  const a2Operation = [...f.operations.values()].find(
    (operation) => operation.sourceEventId === sourceA.event.eventId && operation.resultRevision === 2,
  );
  assert.deepEqual(a2Operation.artifactSnapshot, {
    taskRef: admittedA.subjectRef,
    taskRevision: 2,
    artifactRef: 'artifact:a',
    artifactRevision: String(artifactPublication.timestamp),
    completenessRef: `message:private-a:${artifactPublication.id}#available:${artifactPublication.timestamp}`,
    previewRef: `message:private-a:${artifactPublication.id}#preview:${artifactPublication.timestamp}`,
    openInWorkspaceRef: `workspace:artifact:private-a:${artifactPublication.timestamp}:artifact:a`,
  });
  assert.equal(
    [...f.operations.values()].find((operation) => operation.sourceEventId === sourceB.event.eventId).artifactSnapshot,
    undefined,
  );

  assert.deepEqual(f.accepted, [
    { sourceEventId: sourceB.event.eventId, resultKey: `work:${runB1.taskId}`, resultRevision: 1, body: 'Result B v1' },
    { sourceEventId: sourceA.event.eventId, resultKey: `work:${runA1.taskId}`, resultRevision: 1, body: 'Result A v1' },
    { sourceEventId: sourceA.event.eventId, resultKey: `work:${runA1.taskId}`, resultRevision: 2, body: 'Result A v2' },
  ]);
  assert.equal((await f.tasks.get(runA1.taskId)).threadId, 'private-a');
  assert.equal((await f.tasks.get(runB1.taskId)).threadId, 'private-b');
  assert.equal((await f.tasks.get(runB1.taskId)).entrustedWork.revision, 1);
});
