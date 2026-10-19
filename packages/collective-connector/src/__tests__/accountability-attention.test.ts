import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CollectiveServiceStore,
  type RunningCollectiveServer,
  startCollectiveServer,
} from '@cat-cafe/collective-service';
import type { HumanAuthProvider } from '@cat-cafe/collective-service/human-auth-provider';
import { afterEach, expect, it } from 'vitest';
import { CollectiveConnector } from '../connector.js';

const directories: string[] = [];
const servers: RunningCollectiveServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function fixture() {
  const serviceDirectory = await temporaryDirectory('collective-accountability-service-');
  const ownerConnectorDirectory = await temporaryDirectory('collective-accountability-owner-');
  const memberConnectorDirectory = await temporaryDirectory('collective-accountability-member-');
  const humanAuthProvider: HumanAuthProvider = {
    id: 'github',
    readiness: { ready: true },
    authorizationUrl: ({ state }) => `https://github.test/authorize?state=${state}`,
    authenticate: async ({ code }) => ({ providerSubject: code, handle: code, displayName: code }),
  };
  const opened = await CollectiveServiceStore.open({ dataDirectory: serviceDirectory, humanAuthProvider });
  if (!opened.bootstrapSecret) throw new Error('Expected a fresh Service');
  const owner = await opened.store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'Owner' });
  const ownerAttempt = await opened.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: owner.sessionToken,
  });
  const ownerCompletion = await opened.store.completeHumanAuth({
    provider: 'github',
    state: ownerAttempt.state,
    code: 'accountability-owner',
  });
  await opened.store.exchangeHumanAuthCompletion(ownerCompletion.completionToken);
  const collective = await opened.store.createCollective({ sessionToken: owner.sessionToken, name: 'Attention' });
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
    code: 'accountability-member',
  });
  const member = await opened.store.exchangeHumanAuthCompletion(memberCompletion.completionToken);
  const server = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: ['http://localhost:5184'],
  });
  servers.push(server);
  const pair = async (sessionToken: string, nonce: string) =>
    opened.store.createPairingIntent({
      sessionToken,
      collectiveId: collective.collectiveId,
      hostOrigin: 'http://localhost:5184',
      nonce,
    });
  const ownerConnector = await CollectiveConnector.open({
    dataDirectory: ownerConnectorDirectory,
    verifyAgent: async () => false,
  });
  const memberConnector = await CollectiveConnector.open({
    dataDirectory: memberConnectorDirectory,
    verifyAgent: async () => false,
  });
  const ownerConnection = await ownerConnector.pair({
    serviceUrl: server.url,
    intent: await pair(owner.sessionToken, 'accountability-owner-pairing'),
    endpointLabel: 'Owner Café',
  });
  const memberConnection = await memberConnector.pair({
    serviceUrl: server.url,
    intent: await pair(member.sessionToken, 'accountability-member-pairing'),
    endpointLabel: 'Member Café',
  });
  const route = (localOwnerUserId: string) => ({
    localOwnerUserId,
    defaultIngressThreadId: 'public',
    humanNotificationThreadId: 'public',
    agentRoutes: {},
  });
  await ownerConnector.setHostRoute(ownerConnection.connectionId, route('host-owner'), 0);
  await memberConnector.setHostRoute(memberConnection.connectionId, route('host-member'), 0);
  const coordinates = { serviceInstanceId: opened.store.serviceInstanceId, collectiveId: collective.collectiveId };
  const project = await opened.store.createCollectiveProject(owner.sessionToken, {
    ...coordinates,
    requestId: 'connector-attention-project',
    channelId: 'general',
    title: 'Connector attention Project',
    purpose: 'Only the named Human Host may see the pending request.',
  });
  const created = await opened.store.createCollectiveProjectTask(owner.sessionToken, {
    ...coordinates,
    requestId: 'connector-attention-task',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: project.revision,
    channelId: 'general',
    title: 'Accept the responsibility request',
    intendedOutcome: 'The member decides from either truthful entry point.',
    accountability: 'unassigned',
    requestedAccountableHumanId: member.human.humanId,
  });
  return {
    store: opened.store,
    owner,
    member,
    ownerConnector,
    memberConnector,
    ownerConnection,
    memberConnection,
    coordinates,
    created,
  };
}

it('keeps pending accountability reads isolated to the current Host owner and endpoint Human', async () => {
  const f = await fixture();
  const memberRead = await f.memberConnector.readPendingAccountabilityRequests(
    f.memberConnection.connectionId,
    'host-member',
    { offset: 0, limit: 50 },
  );
  expect(memberRead.identity.authorizedHumanId).toBe(f.member.human.humanId);
  expect(memberRead.items).toHaveLength(1);
  expect(memberRead.page).toMatchObject({ totalCount: 1, snapshot: expect.stringMatching(/^sha256:/) });
  expect(memberRead.items[0]).toMatchObject({
    workId: f.created.work.workId,
    targetHumanId: f.member.human.humanId,
    status: 'pending',
  });
  expect(
    await f.ownerConnector.readPendingAccountabilityRequests(f.ownerConnection.connectionId, 'host-owner', {
      offset: 0,
      limit: 50,
    }),
  ).toMatchObject({ items: [], page: { hasMore: false, totalCount: 0, snapshot: expect.stringMatching(/^sha256:/) } });
  await expect(
    f.memberConnector.readPendingAccountabilityRequests(f.memberConnection.connectionId, 'host-owner', {
      offset: 0,
      limit: 50,
    }),
  ).rejects.toThrow(/Host owner/i);
});
