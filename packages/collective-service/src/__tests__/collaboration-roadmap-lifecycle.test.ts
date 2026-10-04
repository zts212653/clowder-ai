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
  const directory = await mkdtemp(join(tmpdir(), 'collective-roadmap-lifecycle-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'roadmap-lifecycle-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '把默认入口与真实团队验收留在一条可完成的路线里。',
  });
  const proposed = await current.store.proposeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    sourceEventId: source.eventId,
    requestId: 'roadmap-lifecycle-proposal',
  });
  const work = await current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    workId: proposed.workId,
    expectedRevision: proposed.revision,
    requestId: 'roadmap-lifecycle-commit',
  });
  const roadmap = await current.store.createCollectiveRoadmap(current.owner.sessionToken, {
    ...current.coordinates,
    sourceEventId: source.eventId,
    requestId: 'roadmap-lifecycle-create',
    title: 'F290 真实交付路线',
    purpose: '保留承诺、完成与重开的历史。',
    workIds: [work.workId],
  });
  return { ...current, directory, source, work, roadmap };
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
    code: 'roadmap-member',
  });
  return current.store.exchangeHumanAuthCompletion(completion.completionToken);
}

it('closes and reopens a Roadmap only through its accountable Human and a completed route', async () => {
  const current = await fixture();
  await expect(
    current.store.setCollectiveRoadmapStatus(current.owner.sessionToken, {
      ...current.coordinates,
      roadmapId: current.roadmap.roadmapId,
      expectedRevision: current.roadmap.revision,
      requestId: 'complete-roadmap-too-early',
      status: 'completed',
    }),
  ).rejects.toMatchObject({ code: 'ROADMAP_WORK_INCOMPLETE' });

  const member = await inviteMember(current);
  await expect(
    current.store.setCollectiveRoadmapStatus(member.sessionToken, {
      ...current.coordinates,
      roadmapId: current.roadmap.roadmapId,
      expectedRevision: current.roadmap.revision,
      requestId: 'member-completes-owner-roadmap',
      status: 'completed',
    }),
  ).rejects.toMatchObject({ code: 'ROADMAP_AUTHORITY_REQUIRED' });

  await current.store.completeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    workId: current.work.workId,
    expectedRevision: current.work.revision,
    requestId: 'complete-roadmap-work',
  });
  const completed = await current.store.setCollectiveRoadmapStatus(current.owner.sessionToken, {
    ...current.coordinates,
    roadmapId: current.roadmap.roadmapId,
    expectedRevision: current.roadmap.revision,
    requestId: 'complete-roadmap',
    status: 'completed',
  });
  expect(completed).toMatchObject({ status: 'completed', revision: 2 });
  expect(completed.history.at(-1)).toMatchObject({ action: 'completed', revision: 2 });
  expect(
    await current.store.setCollectiveRoadmapStatus(current.owner.sessionToken, {
      ...current.coordinates,
      roadmapId: current.roadmap.roadmapId,
      expectedRevision: current.roadmap.revision,
      requestId: 'complete-roadmap',
      status: 'completed',
    }),
  ).toEqual(completed);

  await expect(
    current.store.setCollectiveRoadmapWorks(current.owner.sessionToken, {
      ...current.coordinates,
      roadmapId: completed.roadmapId,
      expectedRevision: completed.revision,
      requestId: 'edit-completed-roadmap',
      workIds: completed.workIds,
    }),
  ).rejects.toMatchObject({ code: 'ROADMAP_COMPLETED' });

  const reopened = await current.store.setCollectiveRoadmapStatus(current.owner.sessionToken, {
    ...current.coordinates,
    roadmapId: completed.roadmapId,
    expectedRevision: completed.revision,
    requestId: 'reopen-roadmap',
    status: 'active',
  });
  expect(reopened).toMatchObject({ status: 'active', revision: 3 });
  expect(reopened.history.at(-1)).toMatchObject({ action: 'reopened', revision: 3 });
});
