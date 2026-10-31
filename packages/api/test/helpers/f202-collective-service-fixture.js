import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Production Service and Connector; OAuth and running-Cat attestations are explicit test fixtures. */
export async function collectiveServiceFixture(modules, threadId) {
  const { CollectiveServiceStore, startCollectiveServer, CollectiveConnector, collectiveEventSourceIdentity } = modules;
  const root = await mkdtemp(join(tmpdir(), 'f290-work-custody-'));
  const opened = await CollectiveServiceStore.open({
    dataDirectory: join(root, 'service'),
    humanAuthProvider: {
      id: 'github',
      readiness: { ready: true },
      authorizationUrl: ({ state }) => `https://github.test/${state}`,
      authenticate: async () => ({ providerSubject: '1001', handle: 'owner', displayName: 'Owner' }),
    },
  });
  if (!opened.bootstrapSecret) throw new Error('Expected fresh Service');
  const owner = await opened.store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'Owner' });
  const collective = await opened.store.createCollective({ sessionToken: owner.sessionToken, name: 'Custody' });
  const auth = await opened.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: owner.sessionToken,
  });
  await opened.store.completeHumanAuth({ provider: 'github', state: auth.state, code: 'fixture-owner' });
  const server = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: ['http://localhost:5172'],
  });
  const pairing = await opened.store.createPairingIntent({
    sessionToken: owner.sessionToken,
    collectiveId: collective.collectiveId,
    hostOrigin: 'http://localhost:5172',
    nonce: 'f290-custody-pairing-1234',
  });
  let loseAcceptResponse = false;
  let loseRevokeResponse = false;
  const fetchImpl = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith('/work-policy/revoke') && loseRevokeResponse) {
      loseRevokeResponse = false;
      throw new Error('fixture: revoked response lost');
    }
    if (String(input).endsWith('/work/accept-agent') && loseAcceptResponse) {
      loseAcceptResponse = false;
      throw new Error('fixture: committed response lost');
    }
    return response;
  };
  const open = () =>
    CollectiveConnector.open({
      dataDirectory: join(root, 'connector'),
      fetchImpl,
      verifyAgent: async (agent) => agent.catId === 'codex' && agent.sessionRef === 'fixture-running-turn',
    });
  const connector = await open();
  const connection = await connector.pair({ serviceUrl: server.url, intent: pairing, endpointLabel: 'Owner Café' });
  await connector.setHostRoute(
    connection.connectionId,
    {
      localOwnerUserId: 'local-owner',
      defaultIngressThreadId: threadId,
      humanNotificationThreadId: threadId,
      agentRoutes: {
        [`${owner.human.humanId}:codex`]: {
          catId: 'codex',
          threadId: threadId,
          participation: { displayName: 'Sol', channelIds: ['general'] },
        },
      },
    },
    0,
  );
  await connector.publishParticipation(connection.connectionId);
  const coordinates = {
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    connectionId: connection.connectionId,
  };
  const policy = await opened.store.registerCollectiveWorkPolicy(owner.sessionToken, {
    ...coordinates,
    expectedRevision: 0,
    requestId: 'owner-policy',
    grants: [
      {
        grantRef: 'owner-grant',
        catIds: ['codex'],
        channelIds: ['general'],
        requestingHumanIds: 'channel_members',
        requestKinds: ['implementation'],
        expiresAt: null,
      },
    ],
  });
  const event = await opened.store.postHumanMessage(owner.sessionToken, {
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    clientEventId: 'natural-A',
    location: { channelId: 'general' },
    recipient: {
      kind: 'agent',
      humanId: owner.human.humanId,
      connectionId: connection.connectionId,
      agentId: 'codex',
      participationRevision: 1,
    },
    body: 'Implement A and return the result here.',
  });
  const source = collectiveEventSourceIdentity(event);
  if (!source) throw new Error('Expected exact source');
  const agent = { agentId: 'codex', catId: 'codex', displayName: 'Sol', sessionRef: 'fixture-running-turn' };
  const input = {
    requestKind: 'implementation',
    title: 'A',
    intendedOutcome: event.body,
    grantRef: 'owner-grant',
    grantRevision: 1,
  };
  return {
    root,
    store: opened.store,
    owner,
    connector,
    connection,
    source,
    agent,
    input,
    policy,
    open,
    loseResponse: () => {
      loseAcceptResponse = true;
    },
    loseRevokeResponse: () => {
      loseRevokeResponse = true;
    },
    close: async () => {
      await server.close();
      // Keep the isolated service/connector data as failure evidence.
    },
  };
}
