import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectiveSourceIdentity } from '@cat-cafe/shared';
import { afterEach, expect, it } from 'vitest';
import * as outbox from '../outbox-custody.js';
import { ConnectorPersistence } from '../persistence.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});
const source: CollectiveSourceIdentity = {
  serviceInstanceId: 'svc_aaaaaaaa',
  collectiveId: 'col_aaaaaaaa',
  connectionId: 'con_aaaaaaaa',
  eventId: 'evt_aaaaaaaa',
  catId: 'opus',
  participationRevision: 1,
  location: { channelId: 'a' },
  actor: { kind: 'human', humanId: 'human_bbbbbbbb', displayName: 'Member' },
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'collective-reply-operation-'));
  dirs.push(dir);
  const persistence = await ConnectorPersistence.open(dir);
  await persistence.transaction((state) => {
    state.connections[source.connectionId] = {
      ...source,
      serviceUrl: 'http://localhost:5192',
      clientBuildId: 'test',
      endpointId: 'ep_aaaaaaaa',
      authorizedHumanId: 'human_aaaaaaaa',
      endpointLabel: 'Owner',
      endpointCredential: 'private-credential',
      authorityStatus: 'connected',
      liveStatus: 'online',
      lastAckedSequence: 0,
      outbox: [],
      inbox: [],
      createdAt: new Date().toISOString(),
    };
    // Store schemas reject fields not owned by a connection.
    const connection = state.connections[source.connectionId];
    for (const key of ['eventId', 'catId', 'participationRevision', 'location', 'actor'])
      Reflect.deleteProperty(connection, key);
    state.hostRoutes[source.connectionId] = {
      connectionId: source.connectionId,
      localOwnerUserId: 'owner',
      defaultIngressThreadId: 'ingress',
      humanNotificationThreadId: 'ingress',
      revision: 1,
      updatedAt: new Date().toISOString(),
      agentRoutes: {
        'human_aaaaaaaa:opus': {
          catId: 'opus',
          threadId: 'ingress',
          participation: { displayName: 'Opus', channelIds: ['a'] },
        },
      },
    };
  });
  return { dir, persistence, now: () => Date.now(), source, sourceRef: 'message:request', resultKey: 'immediate' };
}

it('allocates one durable reply slot across concurrent resolvers and process restart', async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([outbox.prepareReplyOperation(f), outbox.prepareReplyOperation(f)]);
  expect(first.outboxId).toBe(second.outboxId);
  expect(first.status).toBe('prepared');
  expect(first.operationKey).toBe(JSON.stringify([f.sourceRef, source.catId, f.resultKey]));
  const reopened = await ConnectorPersistence.open(f.dir);
  expect(await outbox.prepareReplyOperation({ ...f, persistence: reopened })).toEqual(first);
  expect(reopened.snapshot().connections[source.connectionId]?.outbox).toHaveLength(1);
});

it('freezes body and original named author; a later invocation recovers instead of creating another event', async () => {
  const f = await fixture();
  const operation = await outbox.prepareReplyOperation(f);
  const agent = { catId: 'opus', agentId: 'opus', displayName: 'Opus', sessionRef: 'invocation-one' };
  const input = { ...f, operationId: operation.outboxId, body: 'The answer', agent, verifyAgent: async () => true };
  const queued = await outbox.submitReplyOperation(input);
  expect(queued.status).toBe('queued');
  const recovered = await outbox.submitReplyOperation({ ...input, agent: { ...agent, sessionRef: 'invocation-two' } });
  expect(recovered.clientEventId).toBe(queued.clientEventId);
  expect(recovered.agent?.sessionRef).toBe('invocation-one');
  await expect(outbox.submitReplyOperation({ ...input, body: 'Different answer' })).rejects.toMatchObject({
    code: 'REPLY_PAYLOAD_CONFLICT',
  });
  await f.persistence.transaction((state) => {
    state.hostRoutes[source.connectionId]!.revision = 2;
  });
  await expect(outbox.submitReplyOperation(input)).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
  expect(f.persistence.snapshot().connections[source.connectionId]?.outbox).toHaveLength(1);
});

it('seals one owner-derived prepared Artifact on the current private Task revision', async () => {
  const f = { ...(await fixture()), resultKey: 'work:canonical-task', workRevision: 2 };
  const first = await outbox.prepareReplyOperation(f);
  const operation = await outbox.prepareReplyOperation({ ...f, workRevision: 3 });
  expect(operation).toMatchObject({
    outboxId: first.outboxId,
    workPurpose: { taskRef: 'task:work:canonical-task', admittedRevision: 3, resultRevision: 1 },
  });
  const artifactSnapshot = {
    taskRef: 'task:work:canonical-task',
    taskRevision: 3,
    artifactRef: 'artifact:result',
    artifactRevision: '7',
    completenessRef: 'artifact:result#complete:7',
    previewRef: 'artifact:result#preview:7',
    openInWorkspaceRef: 'workspace:artifact:thread-result:7:artifact:result',
  };
  const agent = { catId: 'opus', agentId: 'opus', displayName: 'Opus', sessionRef: 'invocation-result' };
  const queued = await outbox.submitReplyOperation({
    ...f,
    workRevision: 3,
    operationId: operation.outboxId,
    body: 'Prepared result',
    agent,
    verifyAgent: async () => true,
    artifactSnapshot,
  });
  expect(queued.workPurpose).toEqual({
    taskRef: 'task:work:canonical-task',
    admittedRevision: 3,
    resultRevision: 1,
    artifactSnapshot,
  });
  await expect(
    outbox.submitReplyOperation({
      ...f,
      workRevision: 3,
      operationId: operation.outboxId,
      body: 'Prepared result',
      agent,
      verifyAgent: async () => true,
      artifactSnapshot: { ...artifactSnapshot, artifactRevision: '8' },
    }),
  ).rejects.toMatchObject({ code: 'REPLY_PAYLOAD_CONFLICT' });
});

it('allocates a distinct durable reply operation for each result revision of the same Work', async () => {
  const firstRound = { ...(await fixture()), resultKey: 'work:canonical-task', workRevision: 2, resultRevision: 1 };
  const first = await outbox.prepareReplyOperation(firstRound);
  const second = await outbox.prepareReplyOperation({ ...firstRound, resultRevision: 2 });

  expect(second.outboxId).not.toBe(first.outboxId);
  expect(first.workPurpose?.resultRevision).toBe(1);
  expect(second.workPurpose?.resultRevision).toBe(2);
  expect(firstRound.persistence.snapshot().connections[source.connectionId]?.outbox).toHaveLength(2);
});

it('keeps the assigned source while a verified current home Cat returns the admitted Work result', async () => {
  const f = { ...(await fixture()), resultKey: 'work:canonical-task', workRevision: 2 };
  await f.persistence.transaction((state) => {
    const route = state.hostRoutes[source.connectionId];
    if (!route) throw new Error('fixture Host route missing');
    route.agentRoutes['human_aaaaaaaa:codex-sol'] = {
      catId: 'codex-sol',
      threadId: 'private-work',
      participation: { displayName: 'Sol', channelIds: ['a'] },
    };
  });
  const operation = await outbox.prepareReplyOperation(f);
  const agent = {
    catId: 'codex-sol',
    agentId: 'codex-sol',
    displayName: 'Sol',
    sessionRef: 'invocation-home-delegate',
  };

  const queued = await outbox.submitReplyOperation({
    ...f,
    operationId: operation.outboxId,
    body: 'Result from the delegated home Cat',
    agent,
    verifyAgent: async () => true,
  });

  expect(queued).toMatchObject({
    status: 'queued',
    replySource: { catId: 'opus', eventId: source.eventId },
    agent: { catId: 'codex-sol', agentId: 'codex-sol', displayName: 'Sol' },
    workPurpose: { taskRef: 'task:work:canonical-task', admittedRevision: 2 },
  });

  const ordinary = { ...(await fixture()), sourceRef: 'message:ordinary', resultKey: 'request' };
  await ordinary.persistence.transaction((state) => {
    const route = state.hostRoutes[source.connectionId];
    if (!route) throw new Error('fixture Host route missing');
    route.agentRoutes['human_aaaaaaaa:codex-sol'] = {
      catId: 'codex-sol',
      threadId: 'private-work',
      participation: { displayName: 'Sol', channelIds: ['a'] },
    };
  });
  const ordinaryOperation = await outbox.prepareReplyOperation(ordinary);
  await expect(
    outbox.submitReplyOperation({
      ...ordinary,
      operationId: ordinaryOperation.outboxId,
      body: 'A delegated Cat cannot take over an ordinary public reply',
      agent,
      verifyAgent: async () => true,
    }),
  ).rejects.toMatchObject({ code: 'AGENT_PROVENANCE_UNVERIFIED' });
});
