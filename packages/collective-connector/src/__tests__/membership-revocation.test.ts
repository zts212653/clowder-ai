import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

it('retires local endpoint authority when the Service rejects a connection after its member leaves', async () => {
  const serviceDirectory = await temporaryDirectory('collective-membership-revoke-service-');
  const connectorDirectory = await temporaryDirectory('collective-membership-revoke-connector-');
  const opened = await CollectiveServiceStore.open({
    dataDirectory: serviceDirectory,
    humanAuthProvider: {
      id: 'github',
      readiness: { ready: true },
      authorizationUrl: ({ state }) => `https://github.test/authorize?state=${encodeURIComponent(state)}`,
      authenticate: async ({ code }) => ({
        providerSubject: code === 'member' ? 'member-subject' : 'owner-subject',
        handle: code,
        displayName: code === 'member' ? 'Member' : 'Owner',
      }),
    },
  });
  if (!opened.bootstrapSecret) throw new Error('Expected a fresh Service bootstrap secret');
  const owner = await opened.store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'Owner' });
  const collective = await opened.store.createCollective({
    sessionToken: owner.sessionToken,
    name: 'Membership revocation Collective',
  });
  const ownerAttempt = await opened.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: owner.sessionToken,
  });
  await opened.store.completeHumanAuth({ provider: 'github', state: ownerAttempt.state, code: 'owner' });
  const invite = await opened.store.createInvite({
    sessionToken: owner.sessionToken,
    collectiveId: collective.collectiveId,
  });
  const memberAttempt = await opened.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const memberCompletion = await opened.store.completeHumanAuth({
    provider: 'github',
    state: memberAttempt.state,
    code: 'member',
  });
  const member = await opened.store.exchangeHumanAuthCompletion(memberCompletion.completionToken);
  const pairing = await opened.store.createPairingIntent({
    sessionToken: member.sessionToken,
    collectiveId: collective.collectiveId,
    hostOrigin: 'http://localhost:5192',
    nonce: 'membership-revocation-connector-pairing',
  });
  const server = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: ['http://localhost:5192'],
  });
  servers.push(server);
  const connector = await CollectiveConnector.open({
    dataDirectory: connectorDirectory,
    verifyAgent: async (agent) => agent.catId === 'codex-sol' && agent.sessionRef === 'invocation:verified',
  });
  const connection = await connector.pair({
    serviceUrl: server.url,
    intent: pairing,
    endpointLabel: 'Member Café',
  });
  await expect(connector.sync(connection.connectionId)).resolves.toMatchObject({
    authorityStatus: 'connected',
    liveStatus: 'online',
  });

  await opened.store.leaveCollective({
    sessionToken: member.sessionToken,
    collectiveId: collective.collectiveId,
  });

  await expect(connector.sync(connection.connectionId)).resolves.toMatchObject({
    authorityStatus: 'revoked',
    liveStatus: 'offline',
    revocationReason: 'service_revoked',
  });
  const persisted = JSON.parse(await readFile(join(connectorDirectory, 'collective-connector.json'), 'utf8'));
  expect(persisted.connections[connection.connectionId]).not.toHaveProperty('endpointCredential');
  const reopened = await CollectiveConnector.open({
    dataDirectory: connectorDirectory,
    verifyAgent: async () => true,
  });
  await expect(reopened.sync(connection.connectionId)).resolves.toMatchObject({
    authorityStatus: 'revoked',
    liveStatus: 'offline',
    revocationReason: 'service_revoked',
  });
  await expect(
    connector.queueAgentMessage(connection.connectionId, {
      clientEventId: 'after-membership-revocation',
      agent: {
        agentId: 'codex-sol',
        displayName: 'Sol',
        catId: 'codex-sol',
        sessionRef: 'invocation:verified',
      },
      target: { kind: 'channel', channelId: 'general' },
      body: 'This must stay local after revocation.',
    }),
  ).rejects.toThrow(/not authorized|revoked/i);
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
