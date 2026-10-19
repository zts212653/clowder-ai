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
  const directory = await mkdtemp(join(tmpdir(), 'collective-work-wake-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  await current.store.publishParticipation(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex-sol', displayName: '小太阳 · 砚砚', channelIds: ['general'] }],
  });
  const createSelfWork = async (suffix: string) => {
    const source = await current.store.postHumanMessage(current.owner.sessionToken, {
      ...current.coordinates,
      clientEventId: `source-${suffix}`,
      location: { channelId: 'general' },
      recipient: { kind: 'channel' },
      body: `${suffix} 的原讨论`,
    });
    const proposed = await current.store.proposeCollectiveWork(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: `propose-${suffix}`,
      sourceEventId: source.eventId,
      title: suffix,
      intendedOutcome: `${suffix} 完成。`,
    });
    const committed = await current.store.commitCollectiveWork(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: `commit-${suffix}`,
      workId: proposed.workId,
      expectedRevision: proposed.revision,
      accountability: 'self',
    });
    return { source, work: committed };
  };
  const first = await createSelfWork('前置一');
  const second = await createSelfWork('前置二');
  const targetSource = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'target-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '两项前置都完成后继续目标任务。',
  });
  const targetProposal = await current.store.proposeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'target-proposal',
    sourceEventId: targetSource.eventId,
    title: '目标任务',
    intendedOutcome: '收到最后一项前置完成信号后继续。',
  });
  const targetCommitted = await current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'target-commit',
    workId: targetProposal.workId,
    expectedRevision: targetProposal.revision,
    assignment: {
      connectionId: current.connection.connectionId,
      catId: 'codex-sol',
      participationRevision: 1,
    },
  });
  const target = await current.store.setCollectiveWorkDependencies(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'target-dependencies',
    workId: targetCommitted.workId,
    expectedRevision: targetCommitted.revision,
    dependencyWorkIds: [first.work.workId, second.work.workId],
  });
  return { ...current, first, second, targetSource, target };
}

async function inviteMember(current: Awaited<ReturnType<typeof fixture>>, suffix: string) {
  const invite = await current.store.createInvite({
    sessionToken: current.owner.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });
  const begin = await current.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await current.store.completeHumanAuth({
    provider: 'github',
    state: begin.state,
    code: suffix,
  });
  return current.store.exchangeHumanAuthCompletion(completion.completionToken);
}

it('emits one typed same-Task wake only after the final prerequisite completes', async () => {
  const current = await fixture();
  const firstCompleted = await current.store.completeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'complete-first',
    workId: current.first.work.workId,
    expectedRevision: current.first.work.revision,
  });
  let events = await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId);
  expect(events.filter((event) => event.workWakeNotice)).toHaveLength(0);

  const secondCompleted = await current.store.completeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'complete-second',
    workId: current.second.work.workId,
    expectedRevision: current.second.work.revision,
  });
  events = await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId);
  const wakes = events.filter((event) => event.workWakeNotice);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({
    workRequest: 'resume',
    recipient: {
      kind: 'agent',
      connectionId: current.connection.connectionId,
      agentId: 'codex-sol',
    },
    workWakeNotice: {
      reason: 'dependency_completed',
      workId: current.target.workId,
      workRevision: current.target.revision,
      assignmentEventId: current.target.assignmentEventId,
      dependencyWorkId: secondCompleted.workId,
      dependencyWorkRevision: secondCompleted.revision,
    },
  });
  expect(wakes[0]?.body).toContain('前置二');

  await expect(
    current.store.completeCollectiveWork(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'complete-second',
      workId: current.second.work.workId,
      expectedRevision: current.second.work.revision,
    }),
  ).resolves.toEqual(secondCompleted);
  events = await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId);
  expect(events.filter((event) => event.workWakeNotice)).toHaveLength(1);
  expect(firstCompleted.lifecycle).toBe('completed');
});

it('wakes the assigned Task for an exact Work comment but not for an unrelated side branch', async () => {
  const current = await fixture();
  const comment = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'target-comment',
    target: { kind: 'message', eventId: current.targetSource.eventId },
    location: { channelId: 'general', rootEventId: current.targetSource.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: current.targetSource.eventId,
    body: '目标任务请同时保留恢复证据。',
  });
  const sideRoot = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'side-root',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '旁支讨论',
  });
  await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'side-comment',
    target: { kind: 'message', eventId: sideRoot.eventId },
    location: { channelId: 'general', rootEventId: sideRoot.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: sideRoot.eventId,
    body: '这句话不属于目标任务。',
  });

  const events = await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId);
  const wakes = events.filter((event) => event.workWakeNotice?.reason === 'comment');
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({
    workRequest: 'resume',
    workWakeNotice: {
      reason: 'comment',
      workId: current.target.workId,
      workRevision: current.target.revision,
    },
  });
  expect(comment).toMatchObject({ recipient: { kind: 'channel' } });
  expect(comment.workRequest).toBeUndefined();
  expect(comment.workWakeNotice).toBeUndefined();
  expect(wakes[0]?.eventId).not.toBe(comment.eventId);
  expect(wakes[0]?.replyToEventId).toBe(comment.eventId);
  expect(wakes[0]?.body).toContain(comment.body);
});

it('preserves explicit comment routing and response requests while emitting a separate same-Task wake', async () => {
  const current = await fixture();
  const member = await inviteMember(current, 'work-comment-recipient');
  const humanComment = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'target-human-comment',
    location: { channelId: 'general', rootEventId: current.targetSource.eventId },
    recipient: { kind: 'human', humanId: member.human.humanId },
    replyToEventId: current.targetSource.eventId,
    body: '这条评论仍然明确写给另一位 Human。',
  });
  expect(humanComment).toMatchObject({
    recipient: { kind: 'human', humanId: member.human.humanId },
    target: { kind: 'human', humanId: member.human.humanId },
  });

  const responseRequested = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'target-response-requested-comment',
    location: { channelId: 'general', rootEventId: current.targetSource.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: current.targetSource.eventId,
    attentionRequest: 'response_requested',
    body: '这条评论仍然是一条公开请回复。',
  });
  expect(responseRequested).toMatchObject({
    recipient: { kind: 'channel' },
    attentionRequest: 'response_requested',
  });

  const events = await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId);
  const wakes = events.filter((event) => event.workWakeNotice?.reason === 'comment');
  expect(wakes).toHaveLength(2);
  expect(wakes.map((event) => event.replyToEventId)).toEqual([humanComment.eventId, responseRequested.eventId]);
  expect(wakes.every((event) => event.recipient?.kind === 'agent' && event.workRequest === 'resume')).toBe(true);
});

it('replays the accepted comment and its frozen wake after Work changes without creating a later wake', async () => {
  const current = await fixture();
  const request = {
    ...current.coordinates,
    clientEventId: 'target-retry-comment',
    location: { channelId: 'general' as const, rootEventId: current.targetSource.eventId },
    recipient: { kind: 'channel' as const },
    replyToEventId: current.targetSource.eventId,
    body: '丢回包后仍用同一个 clientEventId 重试。',
  };
  const first = await current.store.postHumanMessage(current.owner.sessionToken, request);
  const changed = await current.store.setCollectiveWorkDependencies(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'target-retry-dependencies-change',
    workId: current.target.workId,
    expectedRevision: current.target.revision,
    dependencyWorkIds: [current.first.work.workId],
  });
  expect(changed.revision).toBe(current.target.revision + 1);
  await expect(current.store.postHumanMessage(current.owner.sessionToken, request)).resolves.toEqual(first);
  let events = await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId);
  let wakes = events.filter((event) => event.workWakeNotice?.reason === 'comment');
  expect(wakes).toHaveLength(1);
  expect(wakes[0]?.workWakeNotice?.workRevision).toBe(current.target.revision);
  expect(wakes[0]?.replyToEventId).toBe(first.eventId);

  const unassignedSource = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'later-wake-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '最初没有执行猫的任务。',
  });
  const unassignedProposal = await current.store.proposeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'later-wake-proposal',
    sourceEventId: unassignedSource.eventId,
  });
  const unassigned = await current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'later-wake-unassigned',
    workId: unassignedProposal.workId,
    expectedRevision: unassignedProposal.revision,
    accountability: 'unassigned',
  });
  const earlyRequest = {
    ...current.coordinates,
    clientEventId: 'later-wake-comment',
    location: { channelId: 'general' as const, rootEventId: unassignedSource.eventId },
    recipient: { kind: 'channel' as const },
    replyToEventId: unassignedSource.eventId,
    body: '这条已接纳评论不能在以后重试时突然变成 wake。',
  };
  const early = await current.store.postHumanMessage(current.owner.sessionToken, earlyRequest);
  await current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'later-wake-assignment',
    workId: unassigned.workId,
    expectedRevision: unassigned.revision,
    assignment: {
      connectionId: current.connection.connectionId,
      catId: 'codex-sol',
      participationRevision: 1,
    },
  });
  await expect(current.store.postHumanMessage(current.owner.sessionToken, earlyRequest)).resolves.toEqual(early);
  events = await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId);
  wakes = events.filter((event) => event.workWakeNotice?.reason === 'comment');
  expect(wakes).toHaveLength(1);
});

it('keeps completion durable but emits no wake after the assigned Café is revoked', async () => {
  const current = await fixture();
  const firstCompleted = await current.store.completeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'revoked-complete-first',
    workId: current.first.work.workId,
    expectedRevision: current.first.work.revision,
  });
  expect(firstCompleted.lifecycle).toBe('completed');
  await current.store.revokeConnection({
    sessionToken: current.owner.sessionToken,
    collectiveId: current.coordinates.collectiveId,
    connectionId: current.connection.connectionId,
  });
  const secondCompleted = await current.store.completeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'revoked-complete-second',
    workId: current.second.work.workId,
    expectedRevision: current.second.work.revision,
  });
  expect(secondCompleted.lifecycle).toBe('completed');
  const events = await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId);
  expect(events.filter((event) => event.workWakeNotice)).toHaveLength(0);
});
