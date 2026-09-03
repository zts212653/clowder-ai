import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CollectiveServiceStore,
  type RunningCollectiveServer,
  startCollectiveServer,
} from '@cat-cafe/collective-service';
import { afterEach, describe, expect, it } from 'vitest';

import { CollectiveConnector } from '../connector.js';

const directories: string[] = [];
const servers: RunningCollectiveServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('official Collective Connector', () => {
  it('pairs under Host custody and round-trips verified Agent/human signals with ACK', async () => {
    const fixture = await createFixture();
    const connector = await openConnector(fixture.connectorDirectory);
    const connection = await connector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'Clowder AI test endpoint',
    });
    expect(connection.canonicalClientAnchor).toEqual({
      kind: 'collective-client',
      serviceUrl: fixture.server.url,
      serviceInstanceId: connection.serviceInstanceId,
      collectiveId: connection.collectiveId,
      connectionId: connection.connectionId,
      clientBuildId: 'collective-client-v2',
    });

    const projectionJson = JSON.stringify(await connector.getProjection(connection.connectionId));
    expect(projectionJson).not.toContain('endpointCredential');
    const connectorFile = join(fixture.connectorDirectory, 'collective-connector.json');
    expect((await stat(connectorFile)).mode & 0o777).toBe(0o600);

    await connector.queueAgentMessage(connection.connectionId, {
      clientEventId: 'connector-agent-1',
      agent: {
        agentId: 'codex-sol',
        displayName: 'Sol',
        catId: 'codex-sol',
        sessionRef: 'invocation:verified',
      },
      target: { kind: 'channel', channelId: 'general' },
      body: 'The endpoint is really connected.',
    });
    await connector.sync(connection.connectionId);
    expect(await connector.getProjection(connection.connectionId)).toMatchObject({
      route: { configured: false },
      inbox: { persisted: 1, pending: 1, routed: 0, failed: 0 },
    });
    const serviceEvents = await fixture.store.listEventsForHuman(fixture.ownerSessionToken, fixture.collectiveId);
    expect(serviceEvents).toMatchObject([
      {
        sequence: 1,
        actor: {
          kind: 'agent',
          provenance: {
            connectionId: connection.connectionId,
            catId: 'codex-sol',
            sessionRef: 'invocation:verified',
          },
        },
      },
    ]);
    const firstServiceEvent = serviceEvents[0];
    if (!firstServiceEvent) throw new Error('Expected the Connector signal to reach the Service');

    await fixture.store.postHumanMessage(fixture.ownerSessionToken, {
      serviceInstanceId: fixture.store.serviceInstanceId,
      collectiveId: fixture.collectiveId,
      clientEventId: 'owner-reply-1',
      target: { kind: 'agent', humanId: fixture.ownerHumanId, agentId: 'codex-sol' },
      replyToEventId: firstServiceEvent.eventId,
      body: '@Sol welcome.',
    });
    const synced = await connector.sync(connection.connectionId);
    expect(synced).toMatchObject({ liveStatus: 'online', lastAckedSequence: 2 });
    expect(await connector.listInbox(connection.connectionId)).toMatchObject([
      { event: { sequence: 1 }, disposition: 'persisted' },
      {
        event: {
          sequence: 2,
          target: { kind: 'agent', humanId: fixture.ownerHumanId, agentId: 'codex-sol' },
        },
        disposition: 'persisted',
      },
    ]);
  });

  it('persists inbox before ACK and deduplicates replay after a crash window', async () => {
    const fixture = await createFixture();
    const connector = await openConnector(fixture.connectorDirectory);
    const connection = await connector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'Crash-window endpoint',
    });
    await fixture.store.postHumanMessage(fixture.ownerSessionToken, {
      serviceInstanceId: fixture.store.serviceInstanceId,
      collectiveId: fixture.collectiveId,
      clientEventId: 'human-before-crash',
      target: { kind: 'channel', channelId: 'general' },
      body: 'Persist me before ACK.',
    });

    await expect(
      connector.sync(connection.connectionId, {
        afterInboxPersist: () => {
          throw new Error('simulated crash after inbox persistence');
        },
      }),
    ).rejects.toThrow('simulated crash');
    expect((await connector.getProjection(connection.connectionId)).lastAckedSequence).toBe(0);
    expect(await connector.listInbox(connection.connectionId)).toHaveLength(1);

    const reopened = await openConnector(fixture.connectorDirectory);
    await reopened.sync(connection.connectionId);
    expect(await reopened.listInbox(connection.connectionId)).toHaveLength(1);
    expect((await reopened.getProjection(connection.connectionId)).lastAckedSequence).toBe(1);
    expect((await fixture.store.getConnectionProjection(connection.connectionId)).lastAckedSequence).toBe(1);
  });

  it('recovers when the Service commits an ACK before the response is lost', async () => {
    const fixture = await createFixture();
    let loseFirstAckResponse = true;
    const connector = await openConnector(fixture.connectorDirectory, async (input, init) => {
      const response = await fetch(input, init);
      if (loseFirstAckResponse && new URL(String(input)).pathname === '/api/acks') {
        loseFirstAckResponse = false;
        const error = new Error('simulated response loss after ACK commit') as Error & { code: string };
        error.code = 'ECONNRESET';
        throw error;
      }
      return response;
    });
    const connection = await connector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'Ambiguous ACK endpoint',
    });
    await fixture.store.postHumanMessage(fixture.ownerSessionToken, {
      serviceInstanceId: fixture.store.serviceInstanceId,
      collectiveId: fixture.collectiveId,
      clientEventId: 'human-before-ambiguous-ack',
      target: { kind: 'channel', channelId: 'general' },
      body: 'Commit the ACK, then lose its response.',
    });

    expect(await connector.sync(connection.connectionId)).toMatchObject({
      liveStatus: 'offline',
      lastAckedSequence: 0,
    });
    expect((await fixture.store.getConnectionProjection(connection.connectionId)).lastAckedSequence).toBe(1);
    expect(await readFile(join(fixture.connectorDirectory, 'collective-connector.json'), 'utf8')).toContain(
      '"pendingAckSequence": 1',
    );

    const reopened = await openConnector(fixture.connectorDirectory);
    expect(await reopened.sync(connection.connectionId)).toMatchObject({
      liveStatus: 'online',
      lastAckedSequence: 1,
    });
    expect(await reopened.listInbox(connection.connectionId)).toHaveLength(1);
  });

  it('fails closed when persisted endpoint authority is not private on reopen', async () => {
    const fixture = await createFixture();
    const connector = await openConnector(fixture.connectorDirectory);
    await connector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'Private credential endpoint',
    });
    const stateFile = join(fixture.connectorDirectory, 'collective-connector.json');

    await chmod(stateFile, 0o644);
    await expect(openConnector(fixture.connectorDirectory)).rejects.toThrow(/private|permission|mode/i);

    await chmod(stateFile, 0o600);
    const stateTarget = join(fixture.connectorDirectory, 'collective-connector-target.json');
    await rename(stateFile, stateTarget);
    await symlink(stateTarget, stateFile);
    await expect(openConnector(fixture.connectorDirectory)).rejects.toThrow(/private|regular file/i);

    await rm(stateFile);
    await rename(stateTarget, stateFile);
    await chmod(fixture.connectorDirectory, 0o755);
    await expect(openConnector(fixture.connectorDirectory)).rejects.toThrow(/private|permission|mode/i);
  });

  it('migrates legacy endpoint authority to revoked re-pair-required state without guessing a Human', async () => {
    const fixture = await createFixture();
    const connector = await openConnector(fixture.connectorDirectory);
    const connection = await connector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'Legacy endpoint',
    });
    const stateFile = join(fixture.connectorDirectory, 'collective-connector.json');
    const legacy = JSON.parse(await readFile(stateFile, 'utf8')) as {
      schemaVersion: number;
      connections: Record<string, Record<string, unknown>>;
    };
    legacy.schemaVersion = 1;
    delete (legacy as { legacyConnections?: unknown }).legacyConnections;
    delete (legacy as { hostRoutes?: unknown }).hostRoutes;
    delete legacy.connections[connection.connectionId]?.authorizedHumanId;
    await writeFile(stateFile, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

    const reopened = await openConnector(fixture.connectorDirectory);
    await expect(reopened.getProjection(connection.connectionId)).resolves.toMatchObject({
      authorityStatus: 'revoked',
      liveStatus: 'offline',
      revocationReason: 'identity_rebind_required',
    });

    const migratedText = await readFile(stateFile, 'utf8');
    const migrated = JSON.parse(migratedText) as {
      schemaVersion: number;
      legacyConnections: Array<{ connectionId: string; reason: string; state: unknown }>;
    };
    expect(migrated.schemaVersion).toBe(2);
    expect(migratedText).not.toContain('endpointCredential');
    expect(migrated.legacyConnections).toMatchObject([
      {
        connectionId: connection.connectionId,
        reason: 'identity_rebind_required',
        state: expect.objectContaining({ endpointLabel: 'Legacy endpoint' }),
      },
    ]);
  });

  it('keeps two Human-bound Café endpoints isolated across canonical order, restart, and revoke', async () => {
    const fixture = await createFixture();
    const memberConnectorDirectory = await temporaryDirectory('collective-connector-member-');
    const invite = await fixture.store.createInvite({
      sessionToken: fixture.ownerSessionToken,
      collectiveId: fixture.collectiveId,
    });
    const memberAttempt = await fixture.store.beginHumanAuth({
      provider: 'github',
      intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
    });
    const memberCompletion = await fixture.store.completeHumanAuth({
      provider: 'github',
      state: memberAttempt.state,
      code: 'member-code',
    });
    const member = await fixture.store.exchangeHumanAuthCompletion(memberCompletion.completionToken);
    const memberPairing = await fixture.store.createPairingIntent({
      sessionToken: member.sessionToken,
      collectiveId: fixture.collectiveId,
      hostOrigin: 'http://localhost:5172',
      nonce: 'member-connector-pairing-nonce-5678',
    });

    const ownerConnector = await openConnector(fixture.connectorDirectory);
    const memberConnector = await openConnector(memberConnectorDirectory);
    const ownerConnection = await ownerConnector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'You Café',
    });
    const memberConnection = await memberConnector.pair({
      serviceUrl: fixture.server.url,
      intent: memberPairing,
      endpointLabel: 'Member Café',
    });

    expect(ownerConnection).toMatchObject({ authorizedHumanId: fixture.ownerHumanId });
    expect(memberConnection).toMatchObject({ authorizedHumanId: member.human.humanId });
    expect(memberConnection.authorizedHumanId).not.toBe(ownerConnection.authorizedHumanId);
    expect(memberConnection.connectionId).not.toBe(ownerConnection.connectionId);
    expect(memberConnection.endpointId).not.toBe(ownerConnection.endpointId);
    expect((await stat(join(fixture.connectorDirectory, 'collective-connector.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(memberConnectorDirectory, 'collective-connector.json'))).mode & 0o777).toBe(0o600);

    await ownerConnector.queueAgentMessage(ownerConnection.connectionId, {
      clientEventId: 'operator-cafe-agent-message',
      agent: {
        agentId: 'codex-sol',
        displayName: 'Sol',
        catId: 'codex-sol',
        sessionRef: 'invocation:verified',
      },
      target: { kind: 'channel', channelId: 'general' },
      body: 'You Café is online.',
    });
    await ownerConnector.sync(ownerConnection.connectionId);
    await memberConnector.queueAgentMessage(memberConnection.connectionId, {
      clientEventId: 'member-cafe-agent-message',
      agent: {
        agentId: 'codex-terra',
        displayName: 'Terra',
        catId: 'codex-terra',
        sessionRef: 'invocation:member-verified',
      },
      target: { kind: 'channel', channelId: 'general' },
      body: 'Member Café is online.',
    });
    await memberConnector.sync(memberConnection.connectionId);
    await ownerConnector.sync(ownerConnection.connectionId);

    await fixture.store.postHumanMessage(fixture.ownerSessionToken, {
      serviceInstanceId: fixture.store.serviceInstanceId,
      collectiveId: fixture.collectiveId,
      clientEventId: 'owner-targets-member-agent',
      target: { kind: 'agent', humanId: member.human.humanId, agentId: 'codex-terra' },
      body: '@Terra please take this on the Member Café endpoint.',
    });
    await ownerConnector.sync(ownerConnection.connectionId);
    await memberConnector.sync(memberConnection.connectionId);

    const orderedEvents = await fixture.store.listEventsForHuman(fixture.ownerSessionToken, fixture.collectiveId);
    expect(orderedEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(orderedEvents[0]?.actor).toMatchObject({
      kind: 'agent',
      human: { humanId: fixture.ownerHumanId },
      provenance: {
        connectionId: ownerConnection.connectionId,
        endpointId: ownerConnection.endpointId,
        endpointLabel: 'You Café',
      },
    });
    expect(orderedEvents[1]?.actor).toMatchObject({
      kind: 'agent',
      human: { humanId: member.human.humanId },
      provenance: {
        connectionId: memberConnection.connectionId,
        endpointId: memberConnection.endpointId,
        endpointLabel: 'Member Café',
      },
    });
    expect(orderedEvents[2]?.target).toEqual({
      kind: 'agent',
      humanId: member.human.humanId,
      agentId: 'codex-terra',
    });
    expect((await ownerConnector.listInbox(ownerConnection.connectionId)).map((item) => item.event.sequence)).toEqual([
      1, 2, 3,
    ]);
    expect((await memberConnector.listInbox(memberConnection.connectionId)).map((item) => item.event.sequence)).toEqual(
      [1, 2, 3],
    );

    const fixedPort = fixture.server.port;
    await fixture.server.close();
    servers.splice(servers.indexOf(fixture.server), 1);
    await expect(ownerConnector.sync(ownerConnection.connectionId)).resolves.toMatchObject({ liveStatus: 'offline' });
    await expect(memberConnector.sync(memberConnection.connectionId)).resolves.toMatchObject({ liveStatus: 'offline' });

    const restarted = await startCollectiveServer({
      store: fixture.store,
      host: '127.0.0.1',
      port: fixedPort,
      allowedHostOrigins: ['http://localhost:5172'],
    });
    servers.push(restarted);
    await expect(ownerConnector.sync(ownerConnection.connectionId)).resolves.toMatchObject({
      liveStatus: 'online',
      lastAckedSequence: 3,
    });
    await expect(memberConnector.sync(memberConnection.connectionId)).resolves.toMatchObject({
      liveStatus: 'online',
      lastAckedSequence: 3,
    });

    await expect(ownerConnector.revoke(ownerConnection.connectionId)).resolves.toMatchObject({
      authorityStatus: 'revoked',
      liveStatus: 'offline',
    });
    await memberConnector.queueAgentMessage(memberConnection.connectionId, {
      clientEventId: 'member-cafe-after-owner-revoke',
      agent: {
        agentId: 'codex-terra',
        displayName: 'Terra',
        catId: 'codex-terra',
        sessionRef: 'invocation:member-verified',
      },
      target: { kind: 'channel', channelId: 'general' },
      body: 'Member Café remains connected.',
    });
    await expect(memberConnector.sync(memberConnection.connectionId)).resolves.toMatchObject({
      authorityStatus: 'connected',
      liveStatus: 'online',
      lastAckedSequence: 4,
    });
    expect(
      (await fixture.store.listEventsForHuman(fixture.ownerSessionToken, fixture.collectiveId)).map(
        (event) => event.sequence,
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it('keeps outbox honest while offline, reconnects idempotently, and revokes endpoint authority', async () => {
    const fixture = await createFixture();
    const connector = await openConnector(fixture.connectorDirectory);
    const connection = await connector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'Reconnect endpoint',
    });
    const storedBeforeRevoke = JSON.parse(
      await readFile(join(fixture.connectorDirectory, 'collective-connector.json'), 'utf8'),
    ) as { connections: Record<string, { endpointCredential?: string }> };
    const endpointCredential = storedBeforeRevoke.connections[connection.connectionId]?.endpointCredential;
    expect(endpointCredential).toBeTruthy();
    if (!endpointCredential) throw new Error('Expected the Host to persist endpoint authority');
    await connector.queueAgentMessage(connection.connectionId, {
      clientEventId: 'offline-agent-1',
      agent: {
        agentId: 'codex-sol',
        displayName: 'Sol',
        catId: 'codex-sol',
        sessionRef: 'invocation:verified',
      },
      target: { kind: 'channel', channelId: 'general' },
      body: 'Queued while offline.',
    });

    const fixedPort = fixture.server.port;
    await fixture.server.close();
    servers.splice(servers.indexOf(fixture.server), 1);
    expect(await connector.sync(connection.connectionId)).toMatchObject({
      liveStatus: 'offline',
      outbox: { queued: 1, accepted: 0 },
      lastErrorCode: 'ECONNREFUSED',
    });

    const restarted = await startCollectiveServer({
      store: fixture.store,
      host: '127.0.0.1',
      port: fixedPort,
      allowedHostOrigins: ['http://localhost:5172'],
    });
    servers.push(restarted);
    expect(await connector.sync(connection.connectionId)).toMatchObject({
      liveStatus: 'online',
      outbox: { queued: 0, accepted: 1 },
    });
    expect(await connector.revoke(connection.connectionId)).toMatchObject({
      authorityStatus: 'revoked',
      liveStatus: 'offline',
    });
    const persisted = await readFile(join(fixture.connectorDirectory, 'collective-connector.json'), 'utf8');
    expect(persisted).not.toContain(endpointCredential);
    expect((await fixture.store.listCollectives(fixture.ownerSessionToken))[0]?.collectiveId).toBe(
      fixture.collectiveId,
    );
  });

  it('actively probes a persisted offline connection even when the outbox is empty', async () => {
    const fixture = await createFixture();
    const connector = await openConnector(fixture.connectorDirectory);
    const connection = await connector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'Idle reconnect endpoint',
    });

    const fixedPort = fixture.server.port;
    await fixture.server.close();
    servers.splice(servers.indexOf(fixture.server), 1);
    expect(await connector.sync(connection.connectionId)).toMatchObject({
      liveStatus: 'offline',
      outbox: { queued: 0, accepted: 0 },
      lastErrorCode: expect.any(String),
    });

    const restarted = await startCollectiveServer({
      store: fixture.store,
      host: '127.0.0.1',
      port: fixedPort,
      allowedHostOrigins: ['http://localhost:5172'],
    });
    servers.push(restarted);

    expect(await connector.sync(connection.connectionId)).toMatchObject({
      liveStatus: 'online',
      outbox: { queued: 0, accepted: 0 },
      lastAckedSequence: 0,
    });
  });

  it('persists Host routing custody separately from Service ACK and retries only after route repair', async () => {
    const fixture = await createFixture();
    const connector = await openConnector(fixture.connectorDirectory);
    const connection = await connector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'Host-routed endpoint',
    });
    await fixture.store.postHumanMessage(fixture.ownerSessionToken, {
      serviceInstanceId: fixture.store.serviceInstanceId,
      collectiveId: fixture.collectiveId,
      clientEventId: 'human-needs-host-route',
      target: { kind: 'channel', channelId: 'general' },
      body: 'Persist and ACK before Host routing.',
    });
    await connector.sync(connection.connectionId);

    const routeV1 = await connector.setHostRoute(connection.connectionId, {
      localOwnerUserId: 'owner_1',
      defaultIngressThreadId: 'thread_missing',
      humanNotificationThreadId: 'thread_notice',
      agentRoutes: {},
    });
    const [pending] = await connector.listInboxForRouting(connection.connectionId);
    expect(pending?.disposition).toBe('persisted');
    expect((await fixture.store.getConnectionProjection(connection.connectionId)).lastAckedSequence).toBe(1);
    if (!pending) throw new Error('Expected persisted inbox routing work');

    await connector.beginInboxRouting(connection.connectionId, pending.event.eventId, routeV1.revision);
    await connector.failInboxRouting(connection.connectionId, pending.event.eventId, routeV1.revision, {
      code: 'ROUTE_THREAD_UNAVAILABLE',
      message: 'Configured thread is unavailable',
    });
    expect(await connector.listInboxForRouting(connection.connectionId)).toEqual([]);
    expect(await connector.getProjection(connection.connectionId)).toMatchObject({
      route: { configured: true, revision: routeV1.revision },
      inbox: {
        persisted: 1,
        pending: 0,
        routed: 0,
        failed: 1,
        latestFailure: {
          code: 'ROUTE_THREAD_UNAVAILABLE',
          message: 'Configured thread is unavailable',
        },
      },
    });

    const routeV2 = await connector.setHostRoute(connection.connectionId, {
      localOwnerUserId: 'owner_1',
      defaultIngressThreadId: 'thread_ingress',
      humanNotificationThreadId: 'thread_notice',
      agentRoutes: { 'human_1:codex-sol': { catId: 'codex-sol', threadId: 'thread_agent' } },
    });
    expect(routeV2.revision).toBe(routeV1.revision + 1);
    expect(await connector.listInboxForRouting(connection.connectionId)).toHaveLength(1);

    await connector.beginInboxRouting(connection.connectionId, pending.event.eventId, routeV2.revision);
    await connector.completeInboxRouting(connection.connectionId, pending.event.eventId, routeV2.revision, {
      kind: 'thread_message',
      threadId: 'thread_ingress',
      messageId: 'msg_1',
    });
    const reopened = await openConnector(fixture.connectorDirectory);
    expect(await reopened.listInboxForRouting(connection.connectionId)).toEqual([]);
    expect(await reopened.listInbox(connection.connectionId)).toMatchObject([
      {
        disposition: 'routed',
        routeConfigRevision: routeV2.revision,
        routeReceipt: { kind: 'thread_message', threadId: 'thread_ingress', messageId: 'msg_1' },
      },
    ]);
    expect(await reopened.getProjection(connection.connectionId)).toMatchObject({
      route: { configured: true, revision: routeV2.revision },
      inbox: { persisted: 1, pending: 0, routed: 1, failed: 0 },
    });
  });

  it('retries transient Host routing failures without requiring a route edit', async () => {
    const fixture = await createFixture();
    const connector = await openConnector(fixture.connectorDirectory);
    const connection = await connector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'Transient-route endpoint',
    });
    for (const [clientEventId, body] of [
      ['queue-full-route-event', 'Retry after queue capacity returns.'],
      ['cat-offline-route-event', 'Retry after the Cat returns.'],
    ]) {
      await fixture.store.postHumanMessage(fixture.ownerSessionToken, {
        serviceInstanceId: fixture.store.serviceInstanceId,
        collectiveId: fixture.collectiveId,
        clientEventId,
        target: { kind: 'channel', channelId: 'general' },
        body,
      });
    }
    await connector.sync(connection.connectionId);
    const route = await connector.setHostRoute(connection.connectionId, {
      localOwnerUserId: 'owner_1',
      defaultIngressThreadId: 'thread_ingress',
      humanNotificationThreadId: 'thread_notice',
      agentRoutes: {},
    });
    const pending = await connector.listInboxForRouting(connection.connectionId);
    expect(pending).toHaveLength(2);

    await connector.beginInboxRouting(connection.connectionId, pending[0].event.eventId, route.revision);
    await connector.failInboxRouting(connection.connectionId, pending[0].event.eventId, route.revision, {
      code: 'ROUTE_QUEUE_FULL',
      message: 'Configured Cat queue is full',
    });
    await connector.beginInboxRouting(connection.connectionId, pending[1].event.eventId, route.revision);
    await connector.failInboxRouting(connection.connectionId, pending[1].event.eventId, route.revision, {
      code: 'ROUTE_CAT_UNAVAILABLE',
      message: 'Configured Cat is unavailable',
    });

    expect(await connector.listInboxForRouting(connection.connectionId)).toHaveLength(2);
    await expect(
      connector.beginInboxRouting(connection.connectionId, pending[0].event.eventId, route.revision),
    ).resolves.toMatchObject({ disposition: 'routing', routeConfigRevision: route.revision });
  });

  it('fails closed when Host cannot verify the Agent session binding', async () => {
    const fixture = await createFixture();
    const connector = await CollectiveConnector.open({
      dataDirectory: fixture.connectorDirectory,
      verifyAgent: async () => false,
    });
    const connection = await connector.pair({
      serviceUrl: fixture.server.url,
      intent: fixture.pairing,
      endpointLabel: 'Fail-closed endpoint',
    });
    await expect(
      connector.queueAgentMessage(connection.connectionId, {
        clientEventId: 'forged-agent',
        agent: {
          agentId: 'other-cat',
          displayName: 'Impostor',
          catId: 'codex-sol',
          sessionRef: 'invocation:not-real',
        },
        target: { kind: 'channel', channelId: 'general' },
        body: 'Should not leave Host.',
      }),
    ).rejects.toThrow(/verify/i);
  });
});

async function createFixture() {
  const serviceDirectory = await temporaryDirectory('collective-service-connector-');
  const connectorDirectory = await temporaryDirectory('collective-connector-');
  const opened = await CollectiveServiceStore.open({
    dataDirectory: serviceDirectory,
    humanAuthProvider: {
      id: 'github',
      readiness: { ready: true },
      authorizationUrl: ({ state }) => `https://github.test/authorize?state=${encodeURIComponent(state)}`,
      authenticate: async ({ code }) =>
        code === 'member-code'
          ? {
              providerSubject: '1002',
              handle: 'member',
              displayName: 'Member',
            }
          : {
              providerSubject: '1001',
              handle: 'operator',
              displayName: 'You',
            },
    },
  });
  if (!opened.bootstrapSecret) throw new Error('Expected a fresh Service bootstrap secret');
  const owner = await opened.store.consumeBootstrap({
    secret: opened.bootstrapSecret,
    displayName: 'You',
  });
  const collective = await opened.store.createCollective({
    sessionToken: owner.sessionToken,
    name: 'Clowder AI Collective',
  });
  const authAttempt = await opened.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: owner.sessionToken,
  });
  await opened.store.completeHumanAuth({
    provider: 'github',
    state: authAttempt.state,
    code: 'owner-code',
  });
  const pairing = await opened.store.createPairingIntent({
    sessionToken: owner.sessionToken,
    collectiveId: collective.collectiveId,
    hostOrigin: 'http://localhost:5172',
    nonce: 'connector-pairing-nonce-1234',
  });
  const server = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: ['http://localhost:5172'],
  });
  servers.push(server);
  return {
    server,
    store: opened.store,
    pairing,
    connectorDirectory,
    collectiveId: collective.collectiveId,
    ownerSessionToken: owner.sessionToken,
    ownerHumanId: owner.human.humanId,
  };
}

function openConnector(dataDirectory: string, fetchImpl?: typeof fetch) {
  return CollectiveConnector.open({
    dataDirectory,
    verifyAgent: async (agent) =>
      (agent.catId === 'codex-sol' && agent.sessionRef === 'invocation:verified') ||
      (agent.catId === 'codex-terra' && agent.sessionRef === 'invocation:member-verified'),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
