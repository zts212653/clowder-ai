import { mkdtemp, rm } from 'node:fs/promises';
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
  const directory = await mkdtemp(join(tmpdir(), 'collective-vote-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'vote-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '候选版本周四还是周五交付？',
  });
  return { ...current, directory, source };
}

async function inviteMember(current: Awaited<ReturnType<typeof fixture>>) {
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
    code: 'vote-member',
  });
  return current.store.exchangeHumanAuthCompletion(completion.completionToken);
}

it('keeps an informal Vote source-linked, changeable, concurrent, named, and explicitly non-binding', async () => {
  const current = await fixture();
  const member = await inviteMember(current);
  const created = await current.store.createCollectiveVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'create-delivery-poll',
    sourceEventId: current.source.eventId,
    question: current.source.body,
    options: ['周四', '周五'],
    closesAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
  });
  expect(created).toMatchObject({
    kind: 'informal_poll',
    effect: 'preference_only',
    eligibility: 'current_members',
    ballotVisibility: 'named',
    sourceEventId: current.source.eventId,
    sourceLocation: { channelId: 'general' },
    question: current.source.body,
    lifecycle: 'open',
    status: 'open',
    revision: 1,
    ballots: [],
  });
  expect(created.options.map((option) => option.label)).toEqual(['周四', '周五']);

  const ownerFirst = await current.store.castCollectiveVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'owner-votes-thursday',
    voteId: created.voteId,
    optionId: created.options[0]?.optionId,
  });
  expect(ownerFirst.ballots).toMatchObject([{ humanId: current.owner.human.humanId, displayName: 'owner' }]);
  expect(
    await current.store.castCollectiveVote(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'owner-votes-thursday',
      voteId: created.voteId,
      optionId: created.options[0]?.optionId,
    }),
  ).toEqual(ownerFirst);

  await Promise.all([
    current.store.castCollectiveVote(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'owner-changes-to-friday',
      voteId: created.voteId,
      optionId: created.options[1]?.optionId,
    }),
    current.store.castCollectiveVote(member.sessionToken, {
      ...current.coordinates,
      requestId: 'member-votes-friday',
      voteId: created.voteId,
      optionId: created.options[1]?.optionId,
    }),
  ]);
  let projection = current.store.listCollectiveCollaboration(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  expect(projection.votes[0]?.ballots).toHaveLength(2);
  expect(projection.votes[0]?.ballots.every((ballot) => ballot.optionId === created.options[1]?.optionId)).toBe(true);
  expect(projection.votes[0]?.history.map((entry) => entry.action)).toEqual([
    'created',
    'ballot_cast',
    'ballot_changed',
    'ballot_cast',
  ]);

  await expect(
    current.store.closeCollectiveVote(member.sessionToken, {
      ...current.coordinates,
      requestId: 'member-closes-owner-poll',
      voteId: created.voteId,
    }),
  ).rejects.toMatchObject({ code: 'VOTE_AUTHORITY_REQUIRED' });
  const closed = await current.store.closeCollectiveVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'owner-closes-poll',
    voteId: created.voteId,
  });
  expect(closed).toMatchObject({ lifecycle: 'closed', status: 'closed', revision: 5 });
  expect(closed.history.at(-1)).toMatchObject({ action: 'closed' });
  await expect(
    current.store.castCollectiveVote(member.sessionToken, {
      ...current.coordinates,
      requestId: 'late-member-vote',
      voteId: created.voteId,
      optionId: created.options[0]?.optionId,
    }),
  ).rejects.toMatchObject({ code: 'VOTE_CLOSED' });

  const reopened = await CollectiveServiceStore.open({ dataDirectory: current.directory });
  projection = reopened.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId);
  expect(projection.votes).toEqual([closed]);
});
