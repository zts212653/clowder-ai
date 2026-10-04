import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-human-authority-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  await current.store.publishParticipation(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex-sol', displayName: '小太阳 · 砚砚', channelIds: ['general'] }],
  });
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'authority-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '把完整 Collective 首页接到真实数据，并让结果回到这里。',
  });
  return { ...current, source };
}

async function propose(current: Awaited<ReturnType<typeof fixture>>, sourceEventId: string, requestId: string) {
  return current.store.proposeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    sourceEventId,
    requestId,
  });
}

async function commit(
  current: Awaited<ReturnType<typeof fixture>>,
  work: { workId: string; revision: number },
  catId?: string,
) {
  return current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    workId: work.workId,
    expectedRevision: work.revision,
    requestId: `commit-${work.workId}`,
    ...(catId
      ? {
          assignment: {
            connectionId: current.connection.connectionId,
            catId,
            participationRevision: 1,
          },
        }
      : {}),
  });
}

async function inviteMember(current: Awaited<ReturnType<typeof fixture>>, identity: string) {
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
    hostOrigin: 'http://localhost:5183',
    nonce: `${identity}-pairing-nonce`,
  });
  const connection = await current.store.exchangePairingIntent({ ...pairing, endpointLabel: `${identity} Café` });
  return { member, connection };
}

it('lets accountable Humans complete their own unassigned Work without bypassing prerequisites or Cat results', async () => {
  const current = await fixture();
  const sourceB = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'human-completion-source-b',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '前置完成以后，由我收口验收说明。',
  });
  const prerequisite = await commit(current, await propose(current, current.source.eventId, 'human-prerequisite'));
  const dependent = await current.store.setCollectiveWorkDependencies(current.owner.sessionToken, {
    ...current.coordinates,
    workId: (await commit(current, await propose(current, sourceB.eventId, 'human-dependent'))).workId,
    expectedRevision: 2,
    dependencyWorkIds: [prerequisite.workId],
    requestId: 'human-dependent-prerequisite',
  });

  await expect(
    current.store.completeCollectiveWork(current.owner.sessionToken, {
      ...current.coordinates,
      workId: dependent.workId,
      expectedRevision: dependent.revision,
      requestId: 'complete-blocked-human-work',
    }),
  ).rejects.toMatchObject({ code: 'WORK_DEPENDENCIES_INCOMPLETE' });

  const completedPrerequisite = await current.store.completeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    workId: prerequisite.workId,
    expectedRevision: prerequisite.revision,
    requestId: 'complete-human-prerequisite',
  });
  expect(completedPrerequisite).toMatchObject({ lifecycle: 'completed', status: 'completed', revision: 3 });
  expect(completedPrerequisite.history.at(-1)).toMatchObject({ action: 'completed' });

  const completedDependent = await current.store.completeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    workId: dependent.workId,
    expectedRevision: dependent.revision,
    requestId: 'complete-human-dependent',
  });
  expect(completedDependent).toMatchObject({ lifecycle: 'completed', status: 'completed' });

  const assignedSource = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'assigned-completion-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '这项交给猫推进，Human 不能绕过结果回流直接完成。',
  });
  const assigned = await commit(
    current,
    await propose(current, assignedSource.eventId, 'assigned-completion'),
    'codex-sol',
  );
  await expect(
    current.store.completeCollectiveWork(current.owner.sessionToken, {
      ...current.coordinates,
      workId: assigned.workId,
      expectedRevision: assigned.revision,
      requestId: 'complete-assigned-without-result',
    }),
  ).rejects.toMatchObject({ code: 'WORK_RESULT_REQUIRED' });
});

it('lets the Human behind an Agent proposal decline it without granting unrelated members the same authority', async () => {
  const current = await fixture();
  const { member, connection } = await inviteMember(current, 'member-agent-owner');
  await current.store.publishParticipation(connection.endpointCredential, {
    ...current.coordinates,
    connectionId: connection.connectionId,
    revision: 1,
    agents: [{ catId: 'member-cat', displayName: '成员猫', channelIds: ['general'] }],
  });
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'member-agent-proposal-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    attentionRequest: 'response_requested',
    body: '请把这个讨论整理成可选工作。',
  });
  const proposedByMemberCat = await current.store.proposeCollectiveWorkAsAgent(connection.endpointCredential, {
    ...current.coordinates,
    connectionId: connection.connectionId,
    sourceEventId: source.eventId,
    requestId: 'member-cat-proposal',
    catId: 'member-cat',
    participationRevision: 1,
  });
  const declined = await current.store.declineCollectiveWork(member.sessionToken, {
    ...current.coordinates,
    workId: proposedByMemberCat.workId,
    expectedRevision: proposedByMemberCat.revision,
    requestId: 'member-declines-own-cat-proposal',
  });
  expect(declined).toMatchObject({ lifecycle: 'declined', status: 'declined' });

  const ownerProposal = await propose(current, current.source.eventId, 'owner-only-proposal');
  await expect(
    current.store.declineCollectiveWork(member.sessionToken, {
      ...current.coordinates,
      workId: ownerProposal.workId,
      expectedRevision: ownerProposal.revision,
      requestId: 'member-declines-unrelated-proposal',
    }),
  ).rejects.toMatchObject({ code: 'WORK_AUTHORITY_REQUIRED' });
});
