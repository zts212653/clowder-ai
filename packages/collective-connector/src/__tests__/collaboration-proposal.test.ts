import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CollectiveServiceStore,
  type RunningCollectiveServer,
  startCollectiveServer,
} from '@cat-cafe/collective-service';
import { afterEach, expect, it } from 'vitest';
import { CollectiveConnector } from '../connector.js';

const directories: string[] = [];
const servers: RunningCollectiveServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

it('submits one Cat-authored Work proposal through exact current participation and rejects stale authority', async () => {
  const serviceDirectory = await temporaryDirectory('collective-proposal-service-');
  const connectorDirectory = await temporaryDirectory('collective-proposal-host-');
  const opened = await CollectiveServiceStore.open({
    dataDirectory: serviceDirectory,
    humanAuthProvider: {
      id: 'github',
      readiness: { ready: true },
      authorizationUrl: ({ state }) => `https://github.test/authorize?state=${state}`,
      authenticate: async () => ({ providerSubject: 'owner', handle: 'owner', displayName: 'You' }),
    },
  });
  if (!opened.bootstrapSecret) throw new Error('Expected fresh Service');
  const owner = await opened.store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'You' });
  const auth = await opened.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: owner.sessionToken,
  });
  const completion = await opened.store.completeHumanAuth({ provider: 'github', state: auth.state, code: 'owner' });
  await opened.store.exchangeHumanAuthCompletion(completion.completionToken);
  const collective = await opened.store.createCollective({ sessionToken: owner.sessionToken, name: 'Together' });
  const pairing = await opened.store.createPairingIntent({
    sessionToken: owner.sessionToken,
    collectiveId: collective.collectiveId,
    hostOrigin: 'http://localhost:5172',
    nonce: 'collaboration-proposal-nonce',
  });
  const server = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: ['http://localhost:5172'],
  });
  servers.push(server);
  const connector = await CollectiveConnector.open({
    dataDirectory: connectorDirectory,
    verifyAgent: async (agent) => agent.catId === 'codex-sol' && agent.sessionRef === 'invocation:proposal',
  });
  const connection = await connector.pair({ serviceUrl: server.url, intent: pairing, endpointLabel: 'You 的 Café' });
  await connector.setHostRoute(
    connection.connectionId,
    {
      localOwnerUserId: 'owner',
      defaultIngressThreadId: 'public',
      humanNotificationThreadId: 'public',
      agentRoutes: {
        [`${owner.human.humanId}:codex-sol`]: {
          catId: 'codex-sol',
          threadId: 'public',
          participation: { displayName: '小太阳 · 砚砚', channelIds: ['general'] },
        },
      },
    },
    0,
  );
  await connector.publishParticipation(connection.connectionId);
  const request = await opened.store.postHumanMessage(owner.sessionToken, {
    serviceInstanceId: opened.store.serviceInstanceId,
    collectiveId: collective.collectiveId,
    clientEventId: 'proposal-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    attentionRequest: 'response_requested',
    body: '把这段讨论整理成可继续推进的工作。',
  });
  const source = {
    serviceInstanceId: opened.store.serviceInstanceId,
    collectiveId: collective.collectiveId,
    connectionId: connection.connectionId,
    eventId: request.eventId,
    location: request.location,
    catId: 'codex-sol',
    participationRevision: 1,
    actor: request.actor,
  };
  const agent = {
    agentId: 'codex-sol',
    catId: 'codex-sol',
    displayName: '小太阳 · 砚砚',
    sessionRef: 'invocation:proposal',
  };
  const proposed = await connector.proposeWork(source, 'proposal-operation', agent, {
    title: '继续推进',
    requestKind: 'guide',
    intendedOutcome: 'reviewable exact outcome '.repeat(80),
  });
  expect(proposed).toMatchObject({
    sourceEventId: request.eventId,
    status: 'proposed',
    proposedBy: { kind: 'agent', connectionId: connection.connectionId, catId: 'codex-sol' },
  });
  expect(
    await connector.proposeWork(source, 'proposal-operation', agent, {
      title: '继续推进',
      requestKind: 'guide',
      intendedOutcome: 'reviewable exact outcome '.repeat(80),
    }),
  ).toEqual(proposed);
  const replayInAnotherTurn = await connector.proposeWork(source, 'proposal-next-invocation', agent, {
    title: '继续推进',
    requestKind: 'guide',
    intendedOutcome: 'reviewable exact outcome '.repeat(80),
  });
  expect(replayInAnotherTurn.workId).toBe(proposed.workId);
  expect(opened.store.listCollectiveCollaboration(owner.sessionToken, collective.collectiveId).works).toHaveLength(1);

  const pendingContext = await connector.readWorkSourceContext(source);
  expect(pendingContext.relatedWorkIds).toEqual([proposed.workId]);
  expect(pendingContext.matters[0].proposedOutcome).toBe('reviewable exact outcome '.repeat(80).trim());
  expect(pendingContext.matters[0].intendedOutcomePreview.length).toBe(500);
  expect(pendingContext.matters[0]).toMatchObject({
    workId: proposed.workId,
    lifecycle: 'proposed',
    requestKind: 'guide',
  });

  const committed = await opened.store.commitCollectiveWork(owner.sessionToken, {
    serviceInstanceId: opened.store.serviceInstanceId,
    collectiveId: collective.collectiveId,
    workId: proposed.workId,
    expectedRevision: proposed.revision,
    requestId: 'commit-proposed-work',
    assignment: {
      connectionId: connection.connectionId,
      catId: 'codex-sol',
      participationRevision: 1,
    },
  });
  await expect(connector.readAssignedWork(connection.connectionId, committed.workId)).resolves.toEqual(committed);

  await connector.setHostRoute(
    connection.connectionId,
    {
      localOwnerUserId: 'owner',
      defaultIngressThreadId: 'public',
      humanNotificationThreadId: 'public',
      agentRoutes: {},
    },
    1,
  );
  await expect(connector.proposeWork(source, 'stale-proposal', agent)).rejects.toMatchObject({
    code: 'PARTICIPATION_REVOKED',
  });

  let releaseConsumption!: () => void;
  let markConsumptionStarted!: () => void;
  const consumptionStarted = new Promise<void>((resolve) => {
    markConsumptionStarted = resolve;
  });
  const holdConsumption = new Promise<void>((resolve) => {
    releaseConsumption = resolve;
  });
  const consumed = connector.withAssignedWorkAuthority(connection.connectionId, committed.workId, async (scope) => {
    expect(scope.work).toEqual(committed);
    expect(scope.connection.authorityStatus).toBe('connected');
    markConsumptionStarted();
    await holdConsumption;
    return 'closed-under-current-authority';
  });
  await consumptionStarted;
  let revokeSettled = false;
  const revoke = connector.revoke(connection.connectionId).then((projection) => {
    revokeSettled = true;
    return projection;
  });
  await new Promise(setImmediate);
  expect(revokeSettled).toBe(false);
  releaseConsumption();
  await expect(consumed).resolves.toBe('closed-under-current-authority');
  await expect(revoke).resolves.toMatchObject({ authorityStatus: 'revoked' });
  let consumedAfterRevoke = false;
  await expect(
    connector.withAssignedWorkAuthority(connection.connectionId, committed.workId, async () => {
      consumedAfterRevoke = true;
    }),
  ).rejects.toBeDefined();
  expect(consumedAfterRevoke).toBe(false);
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
