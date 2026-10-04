import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CollectiveConnector } from '@cat-cafe/collective-connector';
import { CollectiveServiceStore, startCollectiveServer } from '@cat-cafe/collective-service';
import { catRegistry } from '@cat-cafe/shared';
import { createCollectiveAgentVerifier } from '../../src/domains/plugin/builtin-runtime/collective-agent-verifier.ts';

/** Real Service HTTP/disk and Connectors. Humans are explicitly fixture-authenticated. */
export async function createModelWorld(root, catId, evidence) {
  const origin = 'http://127.0.0.1:5172';
  const humanAuthProvider = {
    id: 'github',
    readiness: { ready: true },
    authorizationUrl: ({ state }) => `https://fixture-github.invalid/authorize?state=${encodeURIComponent(state)}`,
    authenticate: async ({ code }) => ({ providerSubject: code, handle: code, displayName: code }),
  };
  const opened = await CollectiveServiceStore.open({ dataDirectory: join(root, 'service'), humanAuthProvider });
  const store = opened.store;
  assert.ok(opened.bootstrapSecret);
  const owner = await store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'Fixture Cafe A Owner' });
  const first = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: owner.sessionToken,
  });
  const bound = await store.completeHumanAuth({ provider: 'github', state: first.state, code: 'fixture-cafe-a-owner' });
  await store.exchangeHumanAuthCompletion(bound.completionToken);
  const collective = await store.createCollective({
    sessionToken: owner.sessionToken,
    name: 'F290 true-model fixture collective',
  });
  const coordinates = { serviceInstanceId: store.serviceInstanceId, collectiveId: collective.collectiveId };
  const server = await startCollectiveServer({ store, host: '127.0.0.1', port: 0, allowedHostOrigins: [origin] });
  const invite = await store.createInvite({ sessionToken: owner.sessionToken, collectiveId: collective.collectiveId });
  const second = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completed = await store.completeHumanAuth({
    provider: 'github',
    state: second.state,
    code: 'fixture-cafe-b-owner',
  });
  const member = await store.exchangeHumanAuthCompletion(completed.completionToken);
  const verifierOwners = new Map();
  async function pair(label, human, sessionToken) {
    const productionVerifier = createCollectiveAgentVerifier({
      resolveCatDisplayName: (id) => catRegistry.tryGet(id)?.config.displayName,
      readTurnExecution: (id) => verifierOwners.get(label)?.get(id),
    });
    const verifyAgent = async (agent) => {
      const accepted = await productionVerifier(agent);
      const turn = await verifierOwners.get(label)?.get(agent.sessionRef);
      evidence.agentVerifications.push({
        cafe: label,
        catId: agent.catId,
        invocationId: agent.sessionRef,
        accepted,
        turnStatus: turn?.status,
        source: 'production running-turn verifier',
      });
      return accepted;
    };
    const dataDirectory = join(root, `connector-${label}`);
    const connector = await CollectiveConnector.open({ dataDirectory, verifyAgent });
    const intent = await store.createPairingIntent({
      sessionToken,
      collectiveId: collective.collectiveId,
      hostOrigin: origin,
      nonce: `real-model-${label}-${randomUUID()}`,
    });
    const connection = await connector.pair({ serviceUrl: server.url, intent, endpointLabel: `Fixture Cafe ${label}` });
    assert.equal(connection.authorizedHumanId, human.humanId);
    return {
      label,
      ownerUserId: `fixture-owner-${label}`,
      humanId: human.humanId,
      sessionToken,
      dataDirectory,
      connector,
      verifyAgent,
      connectionId: connection.connectionId,
      endpointId: connection.endpointId,
    };
  }
  const a = await pair('A', owner.human, owner.sessionToken);
  const b = await pair('B', member.human, member.sessionToken);
  evidence.service = {
    ...coordinates,
    url: server.url,
    persistence: 'production disk store',
    humanAuth: 'fixture GitHub provider',
  };
  evidence.cafes = [a, b].map(({ label, ownerUserId, humanId, connectionId, endpointId }) => ({
    label: `Fixture Cafe ${label}`,
    ownerUserId,
    humanId,
    connectionId,
    endpointId,
  }));
  const world = {
    store,
    server,
    coordinates,
    a,
    b,
    catId,
    attachTurns(label, turns) {
      verifierOwners.set(label, turns);
    },
    async configure(cafe, endpoint) {
      const old = await cafe.connector.getHostRoute(cafe.connectionId);
      const route = await cafe.connector.setHostRoute(
        cafe.connectionId,
        {
          localOwnerUserId: cafe.ownerUserId,
          defaultIngressThreadId: endpoint.id,
          humanNotificationThreadId: endpoint.id,
          agentRoutes: {
            [`${cafe.humanId}:${catId}`]: {
              catId,
              threadId: endpoint.id,
              participation: { displayName: catRegistry.tryGet(catId).config.displayName, channelIds: ['general'] },
            },
          },
        },
        old?.revision ?? 0,
      );
      await cafe.connector.publishParticipation(cafe.connectionId);
      const policy = await store.registerCollectiveWorkPolicy(cafe.sessionToken, {
        ...coordinates,
        connectionId: cafe.connectionId,
        expectedRevision: 0,
        requestId: `fixture-policy-${cafe.label}`,
        decisionMode: 'automatic',
        grants: [
          {
            grantRef: 'fixture-guide-grant',
            catIds: [catId],
            channelIds: ['general'],
            requestingHumanIds: 'channel_members',
            requestKinds: ['guide'],
            expiresAt: null,
          },
        ],
      });
      await cafe.connector.adoptWorkPolicy(cafe.connectionId, cafe.ownerUserId, policy.revision);
      return route.revision;
    },
    post(from, to, body, revision, replyToEventId) {
      return store.postHumanMessage(from.sessionToken, {
        ...coordinates,
        clientEventId: `fixture-${randomUUID()}`,
        location: { channelId: 'general' },
        target: replyToEventId
          ? { kind: 'message', eventId: replyToEventId }
          : { kind: 'agent', humanId: to.humanId, agentId: catId },
        recipient: {
          kind: 'agent',
          humanId: to.humanId,
          connectionId: to.connectionId,
          agentId: catId,
          participationRevision: revision,
        },
        ...(replyToEventId ? { replyToEventId } : {}),
        body,
      });
    },
    works() {
      return store.listCollectiveCollaboration(a.sessionToken, coordinates.collectiveId).works;
    },
    work(id) {
      const work = world.works().find((row) => row.workId === id);
      assert.ok(work);
      return work;
    },
    async accept(cafe, work) {
      return store.acceptCollectiveWorkResult(cafe.sessionToken, {
        ...coordinates,
        requestId: `fixture-accept-${randomUUID()}`,
        workId: work.workId,
        expectedRevision: work.revision,
        resultEventId: work.resultEventId,
        resultRevision: work.resultRevision,
      });
    },
    async verifyDiskRecovery() {
      const reopened = await CollectiveServiceStore.open({ dataDirectory: join(root, 'service'), humanAuthProvider });
      const recoveredWorks = reopened.store.listCollectiveCollaboration(a.sessionToken, coordinates.collectiveId).works;
      assert.deepEqual(recoveredWorks, world.works());
      const connectorRecovery = [];
      for (const cafe of [a, b]) {
        const recovered = await CollectiveConnector.open({
          dataDirectory: cafe.dataDirectory,
          verifyAgent: cafe.verifyAgent,
        });
        assert.deepEqual(await recovered.listConnections(), await cafe.connector.listConnections());
        assert.deepEqual(
          await recovered.listInbox(cafe.connectionId),
          await cafe.connector.listInbox(cafe.connectionId),
        );
        assert.deepEqual(
          await recovered.getHostRoute(cafe.connectionId),
          await cafe.connector.getHostRoute(cafe.connectionId),
        );
        connectorRecovery.push({
          cafe: cafe.label,
          connectionId: cafe.connectionId,
          connectionInboxAndHostRouteRecovered: true,
        });
      }
      return {
        serviceWorksRecovered: recoveredWorks.map((work) => ({
          workId: work.workId,
          resultRevision: work.resultRevision,
          lifecycle: work.lifecycle,
        })),
        connectors: connectorRecovery,
        method: 'read-only production store reopen from dedicated disk after all turns idle',
      };
    },
    async close() {
      await server.close();
    },
  };
  return world;
}
