import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { HumanAuthProvider } from '../human-auth-provider.js';
import { CollectiveServiceError, CollectiveServiceStore } from '../store.js';

const createdDirectories: string[] = [];

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'collective-service-test-'));
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('CollectiveServiceStore', () => {
  it('fails closed when a persisted event violates the canonical envelope', async () => {
    const directory = await dataDirectory();
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(directory);
    await store.postHumanMessage(ownerSessionToken, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      clientEventId: 'corrupt-event-fixture',
      target: { kind: 'channel', channelId: 'general' },
      body: 'This event will be corrupted on disk.',
    });
    const filePath = join(directory, 'collective-service.json');
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      events: Record<string, Array<Record<string, unknown>>>;
    };
    const persistedEvent = persisted.events[collectiveId]?.[0];
    if (!persistedEvent) throw new Error('Expected a persisted event fixture');
    persistedEvent.sequence = 0;
    await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(CollectiveServiceStore.open({ dataDirectory: directory })).rejects.toMatchObject({
      code: 'STATE_CORRUPT',
    });
    expect(await readFile(filePath, 'utf8')).toContain('"sequence": 0');
  });

  it('bootstraps exactly once and preserves Service identity across restart', async () => {
    const directory = await dataDirectory();
    const first = await CollectiveServiceStore.open({
      dataDirectory: directory,
      now: () => 1_787_918_400_000,
      humanAuthProvider: fakeAuthProvider(),
    });
    expect(first.bootstrapSecret).toBeTruthy();
    const bootstrapSecret = first.bootstrapSecret;
    if (!bootstrapSecret) throw new Error('Expected a fresh bootstrap secret');

    const owner = await first.store.consumeBootstrap({
      secret: bootstrapSecret,
      displayName: 'You',
    });
    const collective = await first.store.createCollective({
      sessionToken: owner.sessionToken,
      name: 'Clowder AI Collective',
    });
    await expect(
      first.store.createCollective({
        sessionToken: owner.sessionToken,
        name: 'Another Collective',
      }),
    ).rejects.toMatchObject({ code: 'HUMAN_AUTH_REQUIRED' });
    await bindBootstrapOwner(first.store, owner.sessionToken);

    await expect(
      first.store.consumeBootstrap({ secret: bootstrapSecret, displayName: 'Replay' }),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_ALREADY_CONSUMED' });

    const reopened = await CollectiveServiceStore.open({
      dataDirectory: directory,
      now: () => 1_787_918_401_000,
    });
    expect(reopened.bootstrapSecret).toBeUndefined();
    expect(reopened.store.serviceInstanceId).toBe(first.store.serviceInstanceId);
    expect((await reopened.store.requireSession(owner.sessionToken)).human.displayName).toBe('You');
    expect((await reopened.store.listCollectives(owner.sessionToken))[0]?.collectiveId).toBe(collective.collectiveId);

    const storeFile = join(directory, 'collective-service.json');
    expect((await stat(storeFile)).isFile()).toBe(true);
    expect(await readFile(storeFile, 'utf8')).not.toContain(bootstrapSecret);
  });

  it('migrates v1 connections without Human ownership to revoked v2 authority', async () => {
    const directory = await dataDirectory();
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(directory);
    const pairing = await store.createPairingIntent({
      sessionToken: ownerSessionToken,
      collectiveId,
      hostOrigin: 'http://localhost:5172',
      nonce: 'legacy-connection-migration-nonce',
    });
    const connection = await store.exchangePairingIntent({ ...pairing, endpointLabel: 'Legacy Host' });
    const filePath = join(directory, 'collective-service.json');
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      schemaVersion: number;
      humanAuthBindings?: unknown;
      humanAuthAttempts?: unknown;
      humanAuthCompletions?: unknown;
      legacyEvents?: unknown;
      connections: Record<string, Record<string, unknown>>;
    };
    persisted.schemaVersion = 1;
    delete persisted.humanAuthBindings;
    delete persisted.humanAuthAttempts;
    delete persisted.humanAuthCompletions;
    delete persisted.legacyEvents;
    delete persisted.connections[connection.connectionId]?.authorizedHumanId;
    await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const reopened = await CollectiveServiceStore.open({ dataDirectory: directory });
    expect(await reopened.store.getConnectionProjection(connection.connectionId)).toMatchObject({
      status: 'revoked',
      revocationReason: 'identity_rebind_required',
    });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ schemaVersion: 2 });
  });

  it('fails closed without rewriting a v1 canonical log that contains unmigratable Agent history', async () => {
    const directory = await dataDirectory();
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(directory);
    await store.postHumanMessage(ownerSessionToken, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      clientEventId: 'legacy-human-before-agent',
      target: { kind: 'channel', channelId: 'general' },
      body: 'Human before legacy Agent.',
    });
    const pairing = await store.createPairingIntent({
      sessionToken: ownerSessionToken,
      collectiveId,
      hostOrigin: 'http://localhost:5172',
      nonce: 'legacy-agent-migration-nonce',
    });
    const connection = await store.exchangePairingIntent({ ...pairing, endpointLabel: 'Legacy Host' });
    await store.postAgentMessage(connection.endpointCredential, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      connectionId: connection.connectionId,
      clientEventId: 'legacy-agent-event',
      agent: {
        agentId: 'codex-sol',
        displayName: 'Sol',
        catId: 'codex-sol',
        sessionRef: 'invocation:legacy-agent',
      },
      target: { kind: 'channel', channelId: 'general' },
      body: 'Legacy Agent history must not disappear.',
    });
    await store.postHumanMessage(ownerSessionToken, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      clientEventId: 'legacy-human-after-agent',
      target: { kind: 'channel', channelId: 'general' },
      body: 'Human after legacy Agent.',
    });

    const filePath = join(directory, 'collective-service.json');
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown> & {
      events: Record<string, Array<Record<string, unknown>>>;
      connections: Record<string, Record<string, unknown>>;
    };
    persisted.schemaVersion = 1;
    delete persisted.humanAuthBindings;
    delete persisted.humanAuthAttempts;
    delete persisted.humanAuthCompletions;
    delete persisted.legacyEvents;
    for (const legacyConnection of Object.values(persisted.connections)) {
      delete legacyConnection.authorizedHumanId;
      delete legacyConnection.revocationReason;
    }
    for (const legacyEvent of persisted.events[collectiveId] ?? []) {
      const target = legacyEvent.target as Record<string, unknown>;
      if (target.kind === 'channel') legacyEvent.target = { kind: 'channel', id: target.channelId };
      const actor = legacyEvent.actor as Record<string, unknown>;
      if (actor.kind === 'agent') {
        const agent = actor.agent as Record<string, unknown>;
        legacyEvent.actor = {
          kind: 'agent',
          agentId: agent.agentId,
          displayName: agent.displayName,
          provenance: actor.provenance,
        };
      }
    }
    const humanAfterAgent = persisted.events[collectiveId]?.find(
      (event) => event.clientEventId === 'legacy-human-after-agent',
    );
    if (!humanAfterAgent) throw new Error('Expected the legacy Human target fixture');
    humanAfterAgent.target = { kind: 'actor', id: 'codex-sol' };
    await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(CollectiveServiceStore.open({ dataDirectory: directory })).rejects.toMatchObject({
      code: 'STATE_MIGRATION_REQUIRED',
    });
    const unchanged = await readFile(filePath, 'utf8');
    expect(unchanged).toContain('"schemaVersion": 1');
    expect(unchanged).toContain('Legacy Agent history must not disappear.');
  });

  it('does not create a Human or consume an invite from an unauthenticated display name', async () => {
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(await dataDirectory());
    const invite = await store.createInvite({ sessionToken: ownerSessionToken, collectiveId });

    await expect(
      store.joinInvite({ inviteToken: invite.inviteToken, displayName: 'Unverified name' }),
    ).rejects.toMatchObject({ code: 'HUMAN_AUTH_REQUIRED' });
  });

  it('authenticates an invited member before assigning one canonical order to human messages', async () => {
    const directory = await dataDirectory();
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(directory, fakeAuthProvider());
    const ownerAttempt = await store.beginHumanAuth({
      provider: 'github',
      intent: { kind: 'bind' },
      sessionToken: ownerSessionToken,
    });
    const ownerCompletion = await store.completeHumanAuth({
      provider: 'github',
      state: ownerAttempt.state,
      code: 'owner-code',
    });
    const reboundOwner = await store.exchangeHumanAuthCompletion(ownerCompletion.completionToken);
    const invite = await store.createInvite({ sessionToken: ownerSessionToken, collectiveId });
    const memberAttempt = await store.beginHumanAuth({
      provider: 'github',
      intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
    });
    const memberCompletion = await store.completeHumanAuth({
      provider: 'github',
      state: memberAttempt.state,
      code: 'member-code',
    });
    const member = await store.exchangeHumanAuthCompletion(memberCompletion.completionToken);

    await expect(
      store.completeHumanAuth({ provider: 'github', state: memberAttempt.state, code: 'member-code' }),
    ).rejects.toMatchObject({ code: 'AUTH_ATTEMPT_CONSUMED' });
    await expect(store.exchangeHumanAuthCompletion(memberCompletion.completionToken)).rejects.toMatchObject({
      code: 'AUTH_COMPLETION_CONSUMED',
    });
    expect(reboundOwner.human.humanId).not.toBe(member.human.humanId);

    const ownerMessage = await store.postHumanMessage(ownerSessionToken, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      clientEventId: 'owner-message-1',
      target: { kind: 'channel', channelId: 'general' },
      body: 'Welcome!',
    });
    const memberReply = await store.postHumanMessage(member.sessionToken, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      clientEventId: 'member-reply-1',
      target: { kind: 'message', eventId: ownerMessage.eventId },
      replyToEventId: ownerMessage.eventId,
      body: 'I am here.',
    });

    expect(ownerMessage.sequence).toBe(1);
    expect(memberReply.sequence).toBe(2);
    expect(memberReply.actor).toMatchObject({ kind: 'human', humanId: member.human.humanId });
    expect((await store.listEventsForHuman(member.sessionToken, collectiveId)).map((e) => e.body)).toEqual([
      'Welcome!',
      'I am here.',
    ]);
    expect(
      await store.postHumanMessage(ownerSessionToken, {
        serviceInstanceId: store.serviceInstanceId,
        collectiveId,
        clientEventId: 'owner-message-1',
        target: { kind: 'channel', channelId: 'general' },
        body: 'Welcome!',
      }),
    ).toEqual(ownerMessage);
  });

  it('logs a bound Human back into the same identity and rejects unbound or conflicting provider identities', async () => {
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(
      await dataDirectory(),
      fakeAuthProvider(),
    );
    const ownerHumanId = (await store.requireSession(ownerSessionToken)).human.humanId;
    const loginAttempt = await store.beginHumanAuth({ provider: 'github', intent: { kind: 'login' } });
    const loginCompletion = await store.completeHumanAuth({
      provider: 'github',
      state: loginAttempt.state,
      code: 'owner-code',
    });
    expect((await store.exchangeHumanAuthCompletion(loginCompletion.completionToken)).human.humanId).toBe(ownerHumanId);

    const unboundLogin = await store.beginHumanAuth({ provider: 'github', intent: { kind: 'login' } });
    await expect(
      store.completeHumanAuth({ provider: 'github', state: unboundLogin.state, code: 'member-code' }),
    ).rejects.toMatchObject({ code: 'AUTH_BINDING_REQUIRED' });

    const member = await inviteAuthenticatedMember(store, ownerSessionToken, collectiveId);
    const foreignSubjectBind = await store.beginHumanAuth({
      provider: 'github',
      intent: { kind: 'bind' },
      sessionToken: member.sessionToken,
    });
    await expect(
      store.completeHumanAuth({ provider: 'github', state: foreignSubjectBind.state, code: 'owner-code' }),
    ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });

    const replacementSubjectBind = await store.beginHumanAuth({
      provider: 'github',
      intent: { kind: 'bind' },
      sessionToken: member.sessionToken,
    });
    await expect(
      store.completeHumanAuth({ provider: 'github', state: replacementSubjectBind.state, code: 'third-code' }),
    ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
  });

  it('lets a member pair its own endpoint but keeps invites and endpoint governance steward-only', async () => {
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(await dataDirectory());
    const member = await inviteAuthenticatedMember(store, ownerSessionToken, collectiveId);
    const memberPairing = await store.createPairingIntent({
      sessionToken: member.sessionToken,
      collectiveId,
      hostOrigin: 'http://localhost:5172',
      nonce: 'member-owned-pairing-nonce',
    });
    const connection = await store.exchangePairingIntent({ ...memberPairing, endpointLabel: 'Member Host' });
    expect(connection.authorizedHumanId).toBe(member.human.humanId);

    await expect(store.createInvite({ sessionToken: member.sessionToken, collectiveId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      store.revokeConnection({
        sessionToken: member.sessionToken,
        collectiveId,
        connectionId: connection.connectionId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await store.getConnectionProjection(connection.connectionId)).toMatchObject({ status: 'connected' });
  });

  it('keeps OAuth attempts retryable across provider outage but fails expired invites and replay closed', async () => {
    const directory = await dataDirectory();
    let now = 1_788_000_000_000;
    let providerOffline = false;
    const opened = await CollectiveServiceStore.open({
      dataDirectory: directory,
      now: () => now,
      humanAuthProvider: {
        id: 'github',
        readiness: { ready: true },
        authorizationUrl: ({ state }) => `https://github.test/authorize?state=${encodeURIComponent(state)}`,
        authenticate: async ({ code }) => {
          if (providerOffline) throw new Error('simulated provider outage');
          return code === 'owner-code'
            ? { providerSubject: '1001', handle: 'operator', displayName: 'You' }
            : { providerSubject: '1002', handle: 'member', displayName: 'Member' };
        },
      },
    });
    if (!opened.bootstrapSecret) throw new Error('Expected bootstrap secret');
    const owner = await opened.store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'You' });
    const collective = await opened.store.createCollective({ sessionToken: owner.sessionToken, name: 'Home' });
    await bindBootstrapOwner(opened.store, owner.sessionToken);

    const expiringInvite = await opened.store.createInvite({
      sessionToken: owner.sessionToken,
      collectiveId: collective.collectiveId,
      ttlMs: 1_000,
    });
    const expiredAttempt = await opened.store.beginHumanAuth({
      provider: 'github',
      intent: { kind: 'accept_invite', inviteToken: expiringInvite.inviteToken },
    });
    now += 1_001;
    await expect(
      opened.store.completeHumanAuth({ provider: 'github', state: expiredAttempt.state, code: 'member-code' }),
    ).rejects.toMatchObject({ code: 'INVITE_EXPIRED' });

    const retryInvite = await opened.store.createInvite({
      sessionToken: owner.sessionToken,
      collectiveId: collective.collectiveId,
    });
    const retryAttempt = await opened.store.beginHumanAuth({
      provider: 'github',
      intent: { kind: 'accept_invite', inviteToken: retryInvite.inviteToken },
    });
    providerOffline = true;
    await expect(
      opened.store.completeHumanAuth({ provider: 'github', state: retryAttempt.state, code: 'member-code' }),
    ).rejects.toThrow('simulated provider outage');
    providerOffline = false;
    const completion = await opened.store.completeHumanAuth({
      provider: 'github',
      state: retryAttempt.state,
      code: 'member-code',
    });
    await expect(
      opened.store.completeHumanAuth({ provider: 'github', state: retryAttempt.state, code: 'member-code' }),
    ).rejects.toMatchObject({ code: 'AUTH_ATTEMPT_CONSUMED' });
    await opened.store.exchangeHumanAuthCompletion(completion.completionToken);
    await expect(opened.store.exchangeHumanAuthCompletion(completion.completionToken)).rejects.toMatchObject({
      code: 'AUTH_COMPLETION_CONSUMED',
    });
  });

  it('pairs an endpoint, derives Agent provenance, replays until ACK, and revokes only endpoint authority', async () => {
    const directory = await dataDirectory();
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(directory);
    const pairing = await store.createPairingIntent({
      sessionToken: ownerSessionToken,
      collectiveId,
      hostOrigin: 'http://localhost:5172',
      nonce: 'pairing-nonce-at-least-16',
    });
    const connection = await store.exchangePairingIntent({
      ...pairing,
      endpointLabel: 'Clowder AI on this Mac',
    });
    await expect(store.exchangePairingIntent({ ...pairing, endpointLabel: 'Replay Host' })).rejects.toMatchObject({
      code: 'PAIRING_ALREADY_CONSUMED',
    });

    const agentEvent = await store.postAgentMessage(connection.endpointCredential, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      connectionId: connection.connectionId,
      clientEventId: 'agent-message-1',
      agent: {
        agentId: 'codex-sol',
        displayName: 'Sol',
        catId: 'codex-sol',
        sessionRef: 'invocation:real-session',
      },
      target: { kind: 'channel', channelId: 'general' },
      body: 'Paired endpoint online.',
    });
    expect(agentEvent.actor).toMatchObject({
      kind: 'agent',
      provenance: {
        connectionId: connection.connectionId,
        endpointId: connection.endpointId,
        endpointLabel: 'Clowder AI on this Mac',
        catId: 'codex-sol',
      },
    });

    const delivery = await store.pollEvents(connection.endpointCredential, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      connectionId: connection.connectionId,
      afterSequence: 0,
      limit: 100,
    });
    expect(delivery.events).toEqual([agentEvent]);
    expect((await store.getConnectionProjection(connection.connectionId)).lastAckedSequence).toBe(0);

    const reopened = await CollectiveServiceStore.open({ dataDirectory: directory });
    expect(
      (
        await reopened.store.pollEvents(connection.endpointCredential, {
          serviceInstanceId: reopened.store.serviceInstanceId,
          collectiveId,
          connectionId: connection.connectionId,
          afterSequence: 0,
          limit: 100,
        })
      ).events,
    ).toEqual([agentEvent]);
    await reopened.store.acknowledge(connection.endpointCredential, {
      serviceInstanceId: reopened.store.serviceInstanceId,
      collectiveId,
      connectionId: connection.connectionId,
      sequence: agentEvent.sequence,
    });
    expect((await reopened.store.getConnectionProjection(connection.connectionId)).lastAckedSequence).toBe(1);

    await reopened.store.revokeConnection({
      sessionToken: ownerSessionToken,
      collectiveId,
      connectionId: connection.connectionId,
    });
    await expect(
      reopened.store.pollEvents(connection.endpointCredential, {
        serviceInstanceId: reopened.store.serviceInstanceId,
        collectiveId,
        connectionId: connection.connectionId,
        afterSequence: 1,
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
    expect((await reopened.store.listCollectives(ownerSessionToken))[0]?.collectiveId).toBe(collectiveId);
  });

  it('stops endpoint replay when its authorizing Human loses Collective membership', async () => {
    const directory = await dataDirectory();
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(directory);
    const pairing = await store.createPairingIntent({
      sessionToken: ownerSessionToken,
      collectiveId,
      hostOrigin: 'http://localhost:5172',
      nonce: 'membership-revocation-nonce',
    });
    const connection = await store.exchangePairingIntent({ ...pairing, endpointLabel: 'Host' });
    await store.postHumanMessage(ownerSessionToken, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      clientEventId: 'must-not-leak-after-membership-removal',
      target: { kind: 'channel', channelId: 'general' },
      body: 'No longer visible to this endpoint.',
    });
    await store.pollEvents(connection.endpointCredential, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      connectionId: connection.connectionId,
      afterSequence: 0,
      limit: 100,
    });

    const filePath = join(directory, 'collective-service.json');
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      memberships: Record<string, { collectiveId: string; humanId: string }>;
    };
    const membershipEntry = Object.entries(persisted.memberships).find(
      ([, membership]) =>
        membership.collectiveId === collectiveId && membership.humanId === connection.authorizedHumanId,
    );
    if (!membershipEntry) throw new Error('Expected the connection Human membership fixture');
    delete persisted.memberships[membershipEntry[0]];
    await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const reopened = await CollectiveServiceStore.open({ dataDirectory: directory });
    await expect(
      reopened.store.pollEvents(connection.endpointCredential, {
        serviceInstanceId: reopened.store.serviceInstanceId,
        collectiveId,
        connectionId: connection.connectionId,
        afterSequence: 0,
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      reopened.store.acknowledge(connection.endpointCredential, {
        serviceInstanceId: reopened.store.serviceInstanceId,
        collectiveId,
        connectionId: connection.connectionId,
        sequence: 1,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects coordinate spoofing and ACKs outside stored order', async () => {
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(await dataDirectory());
    const pairing = await store.createPairingIntent({
      sessionToken: ownerSessionToken,
      collectiveId,
      hostOrigin: 'http://localhost:5172',
      nonce: 'pairing-nonce-at-least-16',
    });
    const connection = await store.exchangePairingIntent({ ...pairing, endpointLabel: 'Host' });

    await expect(
      store.postAgentMessage(connection.endpointCredential, {
        serviceInstanceId: 'svc_wrong-service',
        collectiveId,
        connectionId: connection.connectionId,
        clientEventId: 'spoofed',
        agent: {
          agentId: 'codex-sol',
          displayName: 'Sol',
          catId: 'codex-sol',
          sessionRef: 'invocation:real-session',
        },
        target: { kind: 'channel', channelId: 'general' },
        body: 'Nope',
      }),
    ).rejects.toBeInstanceOf(CollectiveServiceError);
    await store.postHumanMessage(ownerSessionToken, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      clientEventId: 'not-yet-delivered',
      target: { kind: 'channel', channelId: 'general' },
      body: 'The endpoint has not polled this event yet.',
    });
    await expect(
      store.pollEvents(connection.endpointCredential, {
        serviceInstanceId: store.serviceInstanceId,
        collectiveId,
        connectionId: connection.connectionId,
        afterSequence: 1,
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'POLL_CURSOR_MISMATCH' });
    await expect(
      store.acknowledge(connection.endpointCredential, {
        serviceInstanceId: store.serviceInstanceId,
        collectiveId,
        connectionId: connection.connectionId,
        sequence: 1,
      }),
    ).rejects.toMatchObject({ code: 'ACK_OUT_OF_RANGE' });
  });

  it('lets a paired endpoint revoke only itself without holding a human session', async () => {
    const { store, ownerSessionToken, collectiveId } = await bootstrappedCollective(await dataDirectory());
    const pairing = await store.createPairingIntent({
      sessionToken: ownerSessionToken,
      collectiveId,
      hostOrigin: 'http://localhost:5172',
      nonce: 'pairing-nonce-at-least-16',
    });
    const connection = await store.exchangePairingIntent({ ...pairing, endpointLabel: 'Host' });

    const revoked = await store.revokeOwnConnection(connection.endpointCredential, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      connectionId: connection.connectionId,
    });
    expect(revoked.status).toBe('revoked');
    await expect(
      store.revokeOwnConnection(connection.endpointCredential, {
        serviceInstanceId: store.serviceInstanceId,
        collectiveId,
        connectionId: connection.connectionId,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
    expect((await store.listCollectives(ownerSessionToken))[0]?.collectiveId).toBe(collectiveId);
  });
});

async function bootstrappedCollective(dataDirectory: string, humanAuthProvider?: HumanAuthProvider) {
  const provider = humanAuthProvider ?? fakeAuthProvider();
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider: provider,
  });
  if (!opened.bootstrapSecret) throw new Error('Expected a fresh bootstrap secret');
  const owner = await opened.store.consumeBootstrap({
    secret: opened.bootstrapSecret,
    displayName: 'You',
  });
  await bindBootstrapOwner(opened.store, owner.sessionToken);
  const collective = await opened.store.createCollective({
    sessionToken: owner.sessionToken,
    name: 'Clowder AI Collective',
  });
  return {
    store: opened.store,
    ownerSessionToken: owner.sessionToken,
    collectiveId: collective.collectiveId,
  };
}

async function bindBootstrapOwner(store: CollectiveServiceStore, sessionToken: string) {
  const attempt = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken,
  });
  const completion = await store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: 'owner-code',
  });
  await store.exchangeHumanAuthCompletion(completion.completionToken);
}

async function inviteAuthenticatedMember(
  store: CollectiveServiceStore,
  ownerSessionToken: string,
  collectiveId: string,
) {
  const invite = await store.createInvite({ sessionToken: ownerSessionToken, collectiveId });
  const attempt = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: 'member-code',
  });
  return store.exchangeHumanAuthCompletion(completion.completionToken);
}

function fakeAuthProvider(): HumanAuthProvider {
  return {
    id: 'github' as const,
    readiness: { ready: true as const },
    authorizationUrl(input: { state: string; redirectUri: string }) {
      return `https://github.test/login/oauth/authorize?state=${encodeURIComponent(input.state)}&redirect_uri=${encodeURIComponent(input.redirectUri)}`;
    },
    async authenticate(input: { code: string }) {
      if (input.code === 'owner-code') {
        return {
          providerSubject: '1001',
          handle: 'operator',
          displayName: 'You',
          avatarUrl: 'https://avatars.test/owner.png',
        };
      }
      if (input.code === 'third-code') {
        return {
          providerSubject: '1003',
          handle: 'third-party',
          displayName: 'Third identity',
          avatarUrl: 'https://avatars.test/third.png',
        };
      }
      return {
        providerSubject: '1002',
        handle: 'member',
        displayName: 'New member',
        avatarUrl: 'https://avatars.test/member.png',
      };
    },
  };
}
