import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fixture } from './communication-work-custody.fixture.js';

it('requires exact local adoption and restores the same persisted acceptance after a lost Service response', async () => {
  const f = await fixture();
  try {
    await expect(f.connector.acceptWork(f.source, f.agent, f.input)).rejects.toMatchObject({
      code: 'WORK_DELEGATION_UNAVAILABLE',
    });
    await expect(
      f.connector.adoptWorkPolicy(f.connection.connectionId, 'other-owner', f.policy.revision),
    ).rejects.toMatchObject({ code: 'CONNECTOR_OWNER_MISMATCH' });
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    f.loseResponse();
    await expect(f.connector.acceptWork(f.source, f.agent, f.input)).rejects.toThrow(/unreachable/);
    expect(f.store.listCollectiveCollaboration(f.owner.sessionToken, f.connection.collectiveId).works).toHaveLength(1);
    const persisted = JSON.parse(await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8'));
    expect(persisted.connections[f.connection.connectionId].workCustody.acceptances).toHaveLength(1);
    const reopened = await f.open();
    const synchronized = await reopened.sync(f.connection.connectionId);
    expect(synchronized.liveStatus).toBe('online');
    const recovered = JSON.parse(await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8'));
    expect(recovered.connections[f.connection.connectionId].workCustody.acceptances[0].status).toBe('accepted');
    const accepted = await reopened.acceptWork(f.source, f.agent, f.input);
    expect(accepted.lifecycle).toBe('committed');
    expect(accepted.history).toContainEqual(
      expect.objectContaining({
        action: 'committed',
        actor: expect.objectContaining({ kind: 'agent', catId: 'codex-sol' }),
      }),
    );
    expect(f.store.listCollectiveCollaboration(f.owner.sessionToken, f.connection.collectiveId).works).toHaveLength(1);
    await expect(
      reopened.acceptWork(f.source, f.agent, { ...f.input, intendedOutcome: 'different operation' }),
    ).rejects.toMatchObject({ code: 'COLLABORATION_OPERATION_CONFLICT' });
  } finally {
    await f.close();
  }
});

it('REVIEW: recovering a lost revocation response must not adopt an unapproved expansion', async () => {
  const f = await fixture();
  try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    f.loseRevokeResponse();
    await expect(
      f.connector.revokeWorkGrants(f.connection.connectionId, 'local-owner', ['owner-grant']),
    ).rejects.toThrow();
    const remote = await f.connector.readWorkPolicy(f.connection.connectionId);
    if (!remote) throw new Error('Expected remote policy');
    await f.store.registerCollectiveWorkPolicy(f.owner.sessionToken, {
      serviceInstanceId: f.connection.serviceInstanceId,
      collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId,
      expectedRevision: remote.revision,
      requestId: 'remote-new-grant-not-adopted',
      grants: [
        {
          grantRef: 'unadopted-grant',
          catIds: ['codex-sol'],
          channelIds: ['general'],
          requestingHumanIds: 'channel_members',
          requestKinds: ['implementation'],
          expiresAt: null,
        },
      ],
    });
    const reopened = await f.open();
    await reopened.sync(f.connection.connectionId);
    await expect(
      reopened.acceptWork(f.source, f.agent, {
        ...f.input,
        grantRef: 'unadopted-grant',
        grantRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'WORK_DELEGATION_UNAVAILABLE' });
  } finally {
    await f.close();
  }
});

it('REVIEW: an unrelated Service policy edit must not permanently wedge local revocation recovery', async () => {
  const f = await fixture();
  try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    await f.store.registerCollectiveWorkPolicy(f.owner.sessionToken, {
      serviceInstanceId: f.connection.serviceInstanceId,
      collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId,
      expectedRevision: f.policy.revision,
      requestId: 'remote-policy-edited',
      grants: [
        {
          grantRef: 'owner-grant',
          catIds: ['codex-sol'],
          channelIds: ['general'],
          requestingHumanIds: 'channel_members',
          requestKinds: ['implementation'],
          expiresAt: null,
        },
        {
          grantRef: 'another-grant',
          catIds: ['codex-sol'],
          channelIds: ['general'],
          requestingHumanIds: 'channel_members',
          requestKinds: ['research'],
          expiresAt: null,
        },
      ],
    });
    await expect(
      f.connector.revokeWorkGrants(f.connection.connectionId, 'local-owner', ['owner-grant']),
    ).rejects.toThrow();
    const reopened = await f.open();
    const current = await reopened.readWorkPolicy(f.connection.connectionId);
    if (!current) throw new Error('Expected current policy');
    await expect(
      reopened.adoptWorkPolicy(f.connection.connectionId, 'local-owner', current.revision),
    ).rejects.toMatchObject({ code: 'WORK_REVOCATION_PENDING' });
    await expect(reopened.sync(f.connection.connectionId)).resolves.toMatchObject({ liveStatus: 'online' });
    const recovered = await reopened.readWorkPolicyStatus(f.connection.connectionId);
    expect(recovered.localAdoption?.revision).toBe(1);
    expect(recovered.localAdoption?.pendingRevocations).toEqual([]);
    expect(recovered.policy?.grants.find((grant) => grant.grantRef === 'owner-grant')?.status).toBe('revoked');
    expect(recovered.policy?.grants.find((grant) => grant.grantRef === 'another-grant')?.status).toBe('active');
    const persisted = JSON.parse(await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8'));
    const operations = persisted.connections[f.connection.connectionId].workCustody.revocations;
    expect(operations.map((operation: { status: string }) => operation.status)).toEqual(['superseded', 'confirmed']);
    expect(operations[0].replacementRequestId).toBe(operations[1].requestId);
    await (await f.open()).sync(f.connection.connectionId);
    const replayed = JSON.parse(await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8'));
    expect(replayed.connections[f.connection.connectionId].workCustody.revocations).toEqual(operations);
  } finally {
    await f.close();
  }
});

it('contracts only the adopted grant version after a remote owner replaces that grant', async () => {
  const f = await fixture();
  try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    const policy = await f.store.registerCollectiveWorkPolicy(f.owner.sessionToken, {
      serviceInstanceId: f.connection.serviceInstanceId,
      collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId,
      expectedRevision: f.policy.revision,
      requestId: 'replace-g1-with-g2',
      grants: [
        {
          grantRef: 'owner-grant',
          catIds: ['codex-sol'],
          channelIds: ['general'],
          requestingHumanIds: 'channel_members',
          requestKinds: ['implementation', 'research'],
          expiresAt: null,
        },
      ],
    });
    expect(policy.grants[0]?.grantRevision).toBe(2);
    await expect(
      f.connector.revokeWorkGrants(f.connection.connectionId, 'local-owner', ['owner-grant']),
    ).rejects.toThrow();
    const reopened = await f.open();
    await reopened.sync(f.connection.connectionId);
    const recovered = await reopened.readWorkPolicyStatus(f.connection.connectionId);
    expect(recovered.policy?.grants[0]).toMatchObject({ grantRevision: 2, status: 'active' });
    expect(recovered.localAdoption?.revision).toBe(1);
    await expect(reopened.acceptWork(f.source, f.agent, { ...f.input, grantRevision: 2 })).rejects.toMatchObject({
      code: 'WORK_DELEGATION_UNAVAILABLE',
    });
    await reopened.adoptWorkPolicy(f.connection.connectionId, 'local-owner', policy.revision);
    await expect(reopened.acceptWork(f.source, f.agent, { ...f.input, grantRevision: 2 })).resolves.toMatchObject({
      lifecycle: 'committed',
    });
  } finally {
    await f.close();
  }
});

it('reports local adoption from persisted custody separately from registered Service policy', async () => {
  const f = await fixture();
  try {
    const registered = await f.connector.readWorkPolicyStatus(f.connection.connectionId);
    expect(registered.policy?.revision).toBe(f.policy.revision);
    expect(registered.localAdoption).toBeNull();
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    const reopened = await f.open();
    const active = await reopened.readWorkPolicyStatus(f.connection.connectionId);
    expect(active.localAdoption).toMatchObject({
      revision: f.policy.revision,
      decisionMode: 'automatic',
      pendingRevocations: [],
      grants: [{ grantRef: 'owner-grant', grantRevision: 1, state: 'active' }],
    });
    await reopened.revokeWorkGrants(f.connection.connectionId, 'local-owner', ['owner-grant']);
    const blocked = await reopened.readWorkPolicyStatus(f.connection.connectionId);
    expect(blocked.localAdoption?.grants[0].state).toBe('blocked');
  } finally {
    await f.close();
  }
});

it('persists local revocation before its Service write and blocks both new and replayed acceptance', async () => {
  const f = await fixture();
  try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    const work = await f.connector.acceptWork(f.source, f.agent, f.input);
    await f.connector.revokeWorkGrants(f.connection.connectionId, 'local-owner', ['owner-grant']);
    const reopened = await f.open();
    await expect(reopened.acceptWork(f.source, f.agent, f.input)).rejects.toMatchObject({
      code: 'WORK_DELEGATION_UNAVAILABLE',
    });
    expect((await reopened.readAssignedWork(f.connection.connectionId, work.workId)).workId).toBe(work.workId);
  } finally {
    await f.close();
  }
});

it('keeps the same source after an unrelated Cat joins but never revives it when its participant re-enters', async () => {
  const f = await fixture();
  try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    const work = await f.connector.acceptWork(f.source, f.agent, f.input);
    const route = await f.connector.getHostRoute(f.connection.connectionId);
    if (!route) throw new Error('Expected current route');
    const { connectionId: _id, revision, updatedAt: _at, ...input } = route;
    const changed = await f.connector.setHostRoute(
      f.connection.connectionId,
      {
        ...input,
        agentRoutes: {
          ...route.agentRoutes,
          [`${f.owner.human.humanId}:codex-astra`]: {
            catId: 'codex-astra',
            threadId: 'channel',
            participation: { displayName: 'Astra', channelIds: ['general'] },
          },
        },
      },
      revision,
    );
    await f.connector.publishParticipation(f.connection.connectionId);
    expect((await f.connector.readParticipationContext(f.source)).source.eventId).toBe(f.source.eventId);
    expect((await f.connector.acceptWork(f.source, f.agent, f.input)).workId).toBe(work.workId);
    const removed = await f.connector.setHostRoute(
      f.connection.connectionId,
      { ...input, agentRoutes: {} },
      changed.revision,
    );
    await f.connector.publishParticipation(f.connection.connectionId);
    await f.connector.setHostRoute(f.connection.connectionId, input, removed.revision);
    await f.connector.publishParticipation(f.connection.connectionId);
    await expect(f.connector.readParticipationContext(f.source)).rejects.toMatchObject({
      code: 'PARTICIPATION_REVOKED',
    });
  } finally {
    await f.close();
  }
});
