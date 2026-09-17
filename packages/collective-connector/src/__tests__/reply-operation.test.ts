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
