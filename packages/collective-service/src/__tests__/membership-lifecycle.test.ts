import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CollectiveServiceStore } from '../store.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-membership-lifecycle-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  return { ...current, directory };
}

async function inviteMember(current: Awaited<ReturnType<typeof fixture>>, identity = 'member') {
  const invite = await current.store.createInvite({
    sessionToken: current.owner.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });
  const attempt = await current.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await current.store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: identity,
  });
  const member = await current.store.exchangeHumanAuthCompletion(completion.completionToken);
  const pairing = await current.store.createPairingIntent({
    sessionToken: member.sessionToken,
    collectiveId: current.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5189',
    nonce: `${identity}-membership-lifecycle-nonce`,
  });
  const connection = await current.store.exchangePairingIntent({
    ...pairing,
    endpointLabel: `${identity} Café`,
  });
  return { member, connection };
}

it('ends an ordinary membership and every owned Café authority while preserving public history across restart', async () => {
  const current = await fixture();
  const { member, connection } = await inviteMember(current);
  await current.store.publishParticipation(connection.endpointCredential, {
    ...current.coordinates,
    connectionId: connection.connectionId,
    revision: 1,
    agents: [{ catId: 'member-cat', displayName: '成员猫', channelIds: ['general'] }],
  });
  const event = await current.store.postHumanMessage(member.sessionToken, {
    ...current.coordinates,
    clientEventId: 'member-history-before-exit',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '这条公开历史在退出后仍要保留署名。',
  });

  const left = await current.store.leaveCollective({
    sessionToken: member.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });
  expect(left).toMatchObject({
    collectiveId: current.coordinates.collectiveId,
    humanId: member.human.humanId,
    role: 'member',
    status: 'left',
    leaveReason: 'self_left',
    revision: 2,
  });
  expect(left.leftAt).toEqual(expect.any(String));
  expect(current.store.listMembers(current.owner.sessionToken, current.coordinates.collectiveId)).toMatchObject({
    humans: [{ humanId: current.owner.human.humanId }],
    cafes: [{ connectionId: current.connection.connectionId }],
  });
  expect(await current.store.listCollectives(member.sessionToken)).toEqual([]);
  await expect(
    current.store.listEventsForHuman(member.sessionToken, current.coordinates.collectiveId),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    current.store.pollEvents(connection.endpointCredential, {
      ...current.coordinates,
      connectionId: connection.connectionId,
      afterSequence: 0,
      limit: 10,
    }),
  ).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
  expect(await current.store.getConnectionProjection(connection.connectionId)).toMatchObject({
    status: 'revoked',
    revocationReason: 'membership_left',
  });
  expect(current.store.listParticipants(current.owner.sessionToken, current.coordinates.collectiveId)).toEqual([
    expect.objectContaining({
      connectionId: connection.connectionId,
      humanId: member.human.humanId,
      availability: 'revoked',
    }),
  ]);
  expect(
    (await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId))[0],
  ).toMatchObject({
    eventId: event.eventId,
    actor: { kind: 'human', humanId: member.human.humanId, displayName: member.human.displayName },
  });

  const repeated = await current.store.leaveCollective({
    sessionToken: member.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });
  expect(repeated).toEqual(left);

  const reopened = await CollectiveServiceStore.open({
    dataDirectory: current.directory,
    humanAuthProvider: current.humanAuthProvider,
  });
  expect(await reopened.store.listCollectives(member.sessionToken)).toEqual([]);
  await expect(
    reopened.store.listEventsForHuman(member.sessionToken, current.coordinates.collectiveId),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(await reopened.store.getConnectionProjection(connection.connectionId)).toMatchObject({
    status: 'revoked',
    revocationReason: 'membership_left',
  });
});

it('fails closed for stewards and Humans who still own unfinished public responsibilities', async () => {
  const current = await fixture();
  await expect(
    current.store.leaveCollective({
      sessionToken: current.owner.sessionToken,
      collectiveId: current.coordinates.collectiveId,
    }),
  ).rejects.toMatchObject({ code: 'MEMBERSHIP_HANDOFF_REQUIRED' });

  const { member, connection } = await inviteMember(current, 'responsible-member');
  const source = await current.store.postHumanMessage(member.sessionToken, {
    ...current.coordinates,
    clientEventId: 'member-responsibility-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '我承诺完成这项公开工作。',
  });
  const proposed = await current.store.proposeCollectiveWork(member.sessionToken, {
    ...current.coordinates,
    sourceEventId: source.eventId,
    requestId: 'member-proposes-work',
  });
  await current.store.commitCollectiveWork(member.sessionToken, {
    ...current.coordinates,
    workId: proposed.workId,
    expectedRevision: proposed.revision,
    requestId: 'member-commits-work',
  });

  await expect(
    current.store.leaveCollective({
      sessionToken: member.sessionToken,
      collectiveId: current.coordinates.collectiveId,
    }),
  ).rejects.toMatchObject({ code: 'MEMBERSHIP_RESPONSIBILITY_REQUIRED' });
  expect(current.store.listMembers(current.owner.sessionToken, current.coordinates.collectiveId).humans).toContainEqual(
    expect.objectContaining({ humanId: member.human.humanId }),
  );
  expect(await current.store.getConnectionProjection(connection.connectionId)).toMatchObject({ status: 'connected' });
});

it('rejoins the same Human membership without reviving an old endpoint credential', async () => {
  const current = await fixture();
  const original = await inviteMember(current, 'returning-member');
  await current.store.leaveCollective({
    sessionToken: original.member.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });

  const invite = await current.store.createInvite({
    sessionToken: current.owner.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });
  const attempt = await current.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await current.store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: 'returning-member',
  });
  const rejoined = await current.store.exchangeHumanAuthCompletion(completion.completionToken);
  expect(rejoined.human.humanId).toBe(original.member.human.humanId);
  expect(await current.store.listCollectives(rejoined.sessionToken)).toEqual([
    expect.objectContaining({ collectiveId: current.coordinates.collectiveId }),
  ]);
  expect(await current.store.getConnectionProjection(original.connection.connectionId)).toMatchObject({
    status: 'revoked',
    revocationReason: 'membership_left',
  });

  const pairing = await current.store.createPairingIntent({
    sessionToken: rejoined.sessionToken,
    collectiveId: current.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5190',
    nonce: 'returning-member-new-endpoint-nonce',
  });
  const replacement = await current.store.exchangePairingIntent({ ...pairing, endpointLabel: '重新加入的 Café' });
  expect(await current.store.getConnectionProjection(replacement.connectionId)).toMatchObject({ status: 'connected' });

  const leftAgain = await current.store.leaveCollective({
    sessionToken: rejoined.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });
  expect(leftAgain).toMatchObject({ status: 'left', revision: 4 });
  expect(leftAgain.history.map((entry) => entry.action)).toEqual(['joined', 'left', 'joined', 'left']);
});

it('reads pre-lifecycle v2 membership records as active without rewriting history', async () => {
  const current = await fixture();
  const filePath = join(current.directory, 'collective-service.json');
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  for (const membership of Object.values(persisted.memberships) as Array<Record<string, unknown>>) {
    delete membership.status;
    delete membership.revision;
    delete membership.history;
  }
  await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`);

  const reopened = await CollectiveServiceStore.open({
    dataDirectory: current.directory,
    humanAuthProvider: current.humanAuthProvider,
  });
  expect(await reopened.store.listCollectives(current.owner.sessionToken)).toEqual([
    expect.objectContaining({ collectiveId: current.coordinates.collectiveId }),
  ]);
  expect(reopened.store.listMembers(current.owner.sessionToken, current.coordinates.collectiveId).humans).toEqual([
    expect.objectContaining({ humanId: current.owner.human.humanId }),
  ]);
});
