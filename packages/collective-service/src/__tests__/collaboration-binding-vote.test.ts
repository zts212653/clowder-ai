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
  return current.store.exchangeHumanAuthCompletion(completion.completionToken);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-binding-vote-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'binding-vote-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '这条路线采用周四还是周五作为候选交付日？',
  });
  const proposed = await current.store.proposeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    sourceEventId: source.eventId,
    requestId: 'binding-vote-work',
  });
  const work = await current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    workId: proposed.workId,
    expectedRevision: proposed.revision,
    requestId: 'binding-vote-work-commit',
  });
  const roadmap = await current.store.createCollectiveRoadmap(current.owner.sessionToken, {
    ...current.coordinates,
    sourceEventId: source.eventId,
    requestId: 'binding-vote-roadmap',
    title: '候选版本路线',
    purpose: '对这条路线已有权限的 Human 冻结一次判断契约。',
    workIds: [work.workId],
  });
  const member = await inviteMember({ ...current, directory, source, work, roadmap }, 'binding-member');
  return { ...current, directory, source, work, roadmap, member };
}

async function createVote(current: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  return current.store.createCollectiveBindingVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId,
    roadmapId: current.roadmap.roadmapId,
    expectedRoadmapRevision: current.roadmap.revision,
    question: '候选版本按哪个日期交付？',
    options: ['周四', '周五'],
    closesAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
  });
}

it('freezes eligible Humans and authority, then settles a passed vote into a Decision without mutating Roadmap', async () => {
  const current = await fixture();
  await expect(
    current.store.createCollectiveBindingVote(current.member.sessionToken, {
      ...current.coordinates,
      requestId: 'member-invents-binding-authority',
      roadmapId: current.roadmap.roadmapId,
      expectedRoadmapRevision: current.roadmap.revision,
      question: '成员能否替负责人开约束投票？',
      options: ['能', '不能'],
      closesAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    }),
  ).rejects.toMatchObject({ code: 'BINDING_VOTE_AUTHORITY_REQUIRED' });

  const vote = await createVote(current, 'binding-delivery-date');
  expect(vote).toMatchObject({
    kind: 'binding_vote',
    target: {
      kind: 'roadmap',
      roadmapId: current.roadmap.roadmapId,
      roadmapRevision: current.roadmap.revision,
    },
    authority: {
      kind: 'roadmap_accountable_human',
      humanId: current.owner.human.humanId,
      scope: 'decision_only',
    },
    rules: { version: 1, quorumCount: 2, passCount: 2, allowAbstain: true },
    lifecycle: 'open',
    status: 'open',
  });
  expect(vote.rules.eligibleVoters.map((voter) => voter.humanId).sort()).toEqual(
    [current.owner.human.humanId, current.member.human.humanId].sort(),
  );
  expect(
    await current.store.createCollectiveBindingVote(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'binding-delivery-date',
      roadmapId: current.roadmap.roadmapId,
      expectedRoadmapRevision: current.roadmap.revision,
      question: '候选版本按哪个日期交付？',
      options: ['周四', '周五'],
      closesAt: vote.closesAt,
    }),
  ).toEqual(vote);
  await expect(createVote(current, 'binding-overlapping-round')).rejects.toMatchObject({
    code: 'BINDING_VOTE_ALREADY_OPEN',
  });
  await expect(
    current.store.settleCollectiveBindingVote(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'settle-before-voters-respond',
      bindingVoteId: vote.bindingVoteId,
    }),
  ).rejects.toMatchObject({ code: 'BINDING_VOTE_STILL_OPEN' });

  const lateMember = await inviteMember(current, 'binding-late-member');
  await expect(
    current.store.castCollectiveBindingVote(lateMember.sessionToken, {
      ...current.coordinates,
      requestId: 'late-member-ballot',
      bindingVoteId: vote.bindingVoteId,
      choice: { kind: 'option', optionId: vote.options[0]?.optionId },
    }),
  ).rejects.toMatchObject({ code: 'BINDING_VOTE_INELIGIBLE' });

  await Promise.all([
    current.store.castCollectiveBindingVote(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'owner-binding-ballot',
      bindingVoteId: vote.bindingVoteId,
      choice: { kind: 'option', optionId: vote.options[0]?.optionId },
    }),
    current.store.castCollectiveBindingVote(current.member.sessionToken, {
      ...current.coordinates,
      requestId: 'member-binding-ballot',
      bindingVoteId: vote.bindingVoteId,
      choice: { kind: 'option', optionId: vote.options[0]?.optionId },
    }),
  ]);
  await expect(
    current.store.settleCollectiveBindingVote(current.member.sessionToken, {
      ...current.coordinates,
      requestId: 'member-settles-binding-vote',
      bindingVoteId: vote.bindingVoteId,
    }),
  ).rejects.toMatchObject({ code: 'BINDING_VOTE_AUTHORITY_REQUIRED' });
  const settled = await current.store.settleCollectiveBindingVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'owner-settles-binding-vote',
    bindingVoteId: vote.bindingVoteId,
  });
  expect(settled).toMatchObject({
    lifecycle: 'settled',
    status: 'settled',
    result: { outcome: 'passed', eligibleCount: 2, participationCount: 2, supportCount: 2 },
  });
  expect(settled.decisionId).toMatch(/^decision_/);

  const projection = current.store.listCollectiveCollaboration(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  expect(projection.decisions).toMatchObject([
    {
      decisionId: settled.decisionId,
      bindingVoteId: vote.bindingVoteId,
      statement: '周四',
      target: vote.target,
      authority: vote.authority,
    },
  ]);
  expect(projection.roadmaps[0]).toEqual(current.roadmap);

  const reopened = await CollectiveServiceStore.open({ dataDirectory: current.directory });
  expect(
    reopened.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId).decisions,
  ).toEqual(projection.decisions);
});

it('retains withdraw/change history and produces no Decision for a tie', async () => {
  const current = await fixture();
  const vote = await createVote(current, 'binding-tie');
  const ownerBallot = await current.store.castCollectiveBindingVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'owner-first-choice',
    bindingVoteId: vote.bindingVoteId,
    choice: { kind: 'option', optionId: vote.options[0]?.optionId },
  });
  const withdrawn = await current.store.withdrawCollectiveBindingVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'owner-withdraws',
    bindingVoteId: vote.bindingVoteId,
  });
  expect(withdrawn.ballots).toHaveLength(0);
  expect(withdrawn.history.at(-1)).toMatchObject({ action: 'ballot_withdrawn' });
  await current.store.castCollectiveBindingVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'owner-final-choice',
    bindingVoteId: vote.bindingVoteId,
    choice: { kind: 'option', optionId: vote.options[0]?.optionId },
  });
  await current.store.castCollectiveBindingVote(current.member.sessionToken, {
    ...current.coordinates,
    requestId: 'member-opposite-choice',
    bindingVoteId: vote.bindingVoteId,
    choice: { kind: 'option', optionId: vote.options[1]?.optionId },
  });
  const settled = await current.store.settleCollectiveBindingVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'settle-tie',
    bindingVoteId: vote.bindingVoteId,
  });
  expect(settled.result).toMatchObject({ outcome: 'no_decision', participationCount: 2, supportCount: 1 });
  expect(settled.decisionId).toBeUndefined();
  expect(ownerBallot.history.at(-1)).toMatchObject({ action: 'ballot_cast' });
  expect(
    current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId).decisions,
  ).toEqual([]);
});

it('counts abstention toward quorum without counting it as support', async () => {
  const current = await fixture();
  const vote = await createVote(current, 'binding-abstention');
  await current.store.castCollectiveBindingVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'owner-supports-thursday',
    bindingVoteId: vote.bindingVoteId,
    choice: { kind: 'option', optionId: vote.options[0]?.optionId },
  });
  await current.store.castCollectiveBindingVote(current.member.sessionToken, {
    ...current.coordinates,
    requestId: 'member-abstains',
    bindingVoteId: vote.bindingVoteId,
    choice: { kind: 'abstain' },
  });
  const settled = await current.store.settleCollectiveBindingVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'settle-abstention',
    bindingVoteId: vote.bindingVoteId,
  });
  expect(settled.result).toMatchObject({ outcome: 'no_decision', participationCount: 2, supportCount: 1 });
  expect(settled.decisionId).toBeUndefined();
});

it('invalidates the frozen authority instead of applying a result after the Roadmap revision changes', async () => {
  const current = await fixture();
  const vote = await createVote(current, 'binding-stale-target');
  await current.store.setCollectiveRoadmapWorks(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'change-roadmap-after-vote',
    roadmapId: current.roadmap.roadmapId,
    expectedRevision: current.roadmap.revision,
    workIds: current.roadmap.workIds,
  });
  const projection = current.store.listCollectiveCollaboration(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  expect(projection.bindingVotes[0]).toMatchObject({ status: 'invalidated' });

  const invalidated = await current.store.settleCollectiveBindingVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'settle-stale-target',
    bindingVoteId: vote.bindingVoteId,
  });
  expect(invalidated).toMatchObject({
    lifecycle: 'invalidated',
    status: 'invalidated',
    invalidationReason: 'roadmap_authority_changed',
  });
  expect(invalidated.history.at(-1)).toMatchObject({ action: 'invalidated' });
  expect(
    current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId).decisions,
  ).toEqual([]);
});

it('invalidates an open frozen electorate when an eligible member leaves', async () => {
  const current = await fixture();
  const vote = await createVote(current, 'binding-member-leaves');

  await current.store.leaveCollective({
    sessionToken: current.member.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });

  const projection = current.store.listCollectiveCollaboration(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  expect(projection.bindingVotes).toContainEqual(
    expect.objectContaining({
      bindingVoteId: vote.bindingVoteId,
      status: 'invalidated',
    }),
  );
  expect(projection.decisions).toEqual([]);

  const invalidated = await current.store.settleCollectiveBindingVote(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'settle-after-member-leaves',
    bindingVoteId: vote.bindingVoteId,
  });
  expect(invalidated).toMatchObject({
    lifecycle: 'invalidated',
    status: 'invalidated',
    invalidationReason: 'eligible_voter_lost_access',
  });
  expect(
    current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId).decisions,
  ).toEqual([]);
});
