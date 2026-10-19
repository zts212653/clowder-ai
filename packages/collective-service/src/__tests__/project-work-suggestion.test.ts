import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CollectiveServiceStore } from '../store.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

type SuggestionDecision = {
  readonly work: {
    readonly workId: string;
    readonly lifecycle: string;
    readonly status: string;
    readonly title: string;
    readonly intendedOutcome: string;
    readonly revision: number;
  };
  readonly roadmap: { readonly roadmapId: string; readonly revision: number; readonly workIds: readonly string[] };
  readonly targetWork?: {
    readonly workId: string;
    readonly revision: number;
    readonly dependencyWorkIds: readonly string[];
    readonly history: readonly { readonly action: string; readonly eventId?: string; readonly note?: string }[];
  };
};

type ProjectSuggestionStore = CollectiveServiceStore & {
  decideCollectiveProjectWorkSuggestion(sessionToken: string, input: unknown): Promise<SuggestionDecision>;
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-project-suggestion-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  await current.store.publishParticipation(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex-sol', displayName: '小太阳 · 砚砚', channelIds: ['general'] }],
  });
  const project = await current.store.createCollectiveProject(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'project-create',
    channelId: 'general',
    title: '项目建议闭环',
    purpose: '猫只建议，Human 决定是否纳入并重验版本与依赖。',
  });
  const target = await current.store.createCollectiveProjectTask(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'target-create',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: project.revision,
    channelId: 'general',
    title: '交付完整版本',
    intendedOutcome: '所有前置完成后交付。',
    accountability: 'self',
  });
  return {
    ...current,
    project: target.roadmap,
    target: target.work,
    suggestions: current.store as ProjectSuggestionStore,
  };
}

async function source(current: Awaited<ReturnType<typeof fixture>>, suffix: string) {
  return current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: `suggestion-${suffix}`,
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: `请判断项目需要的${suffix}。`,
  });
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

async function propose(
  current: Awaited<ReturnType<typeof fixture>>,
  input: {
    readonly suffix: string;
    readonly roadmapRevision: number;
    readonly targetWorkRevision?: number;
  },
) {
  const event = await source(current, input.suffix);
  const work = await current.store.proposeCollectiveWorkAsAgent(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    sourceEventId: event.eventId,
    requestId: `proposal-${input.suffix}`,
    catId: 'codex-sol',
    participationRevision: 1,
    title: `${input.suffix}建议`,
    intendedOutcome: `${input.suffix}有可验收结果。`,
    projectSuggestion: {
      roadmapId: current.project.roadmapId,
      roadmapRevision: input.roadmapRevision,
      ...(input.targetWorkRevision
        ? { prerequisiteForWorkId: current.target.workId, prerequisiteForWorkRevision: input.targetWorkRevision }
        : {}),
    },
  });
  return { event, work };
}

it('keeps Cat Project suggestions pending until one atomic Human accept or ignore decision', async () => {
  const current = await fixture();
  const taskSuggestion = await propose(current, {
    suffix: '补充任务',
    roadmapRevision: current.project.revision,
  });
  expect(taskSuggestion.work).toMatchObject({
    lifecycle: 'proposed',
    status: 'proposed',
    projectSuggestion: {
      roadmapId: current.project.roadmapId,
      roadmapRevision: current.project.revision,
    },
  });

  const acceptedTask = await current.suggestions.decideCollectiveProjectWorkSuggestion(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'accept-task-suggestion',
    workId: taskSuggestion.work.workId,
    expectedRevision: taskSuggestion.work.revision,
    expectedRoadmapRevision: current.project.revision,
    decision: 'accept',
    title: '补充经过 Human 修改的任务',
    intendedOutcome: '保留猫建议来源，同时采用 Human 确认后的完成标准。',
  });
  expect(acceptedTask.work).toMatchObject({
    lifecycle: 'committed',
    status: 'unassigned',
    title: '补充经过 Human 修改的任务',
    intendedOutcome: '保留猫建议来源，同时采用 Human 确认后的完成标准。',
  });
  expect(acceptedTask.roadmap.workIds).toContain(taskSuggestion.work.workId);
  expect(
    await current.suggestions.decideCollectiveProjectWorkSuggestion(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'accept-task-suggestion',
      workId: taskSuggestion.work.workId,
      expectedRevision: taskSuggestion.work.revision,
      expectedRoadmapRevision: current.project.revision,
      decision: 'accept',
      title: '补充经过 Human 修改的任务',
      intendedOutcome: '保留猫建议来源，同时采用 Human 确认后的完成标准。',
    }),
  ).toEqual(acceptedTask);

  const prerequisiteSuggestion = await propose(current, {
    suffix: '新增前置任务',
    roadmapRevision: acceptedTask.roadmap.revision,
    targetWorkRevision: current.target.revision,
  });
  await expect(
    current.suggestions.decideCollectiveProjectWorkSuggestion(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'stale-prerequisite-accept',
      workId: prerequisiteSuggestion.work.workId,
      expectedRevision: prerequisiteSuggestion.work.revision,
      expectedRoadmapRevision: acceptedTask.roadmap.revision,
      expectedTargetWorkRevision: current.target.revision + 1,
      decision: 'accept',
    }),
  ).rejects.toMatchObject({ code: 'WORK_REVISION_CONFLICT' });
  const afterRejected = current.store
    .listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId)
    .works.find((work) => work.workId === prerequisiteSuggestion.work.workId);
  expect(afterRejected).toMatchObject({ lifecycle: 'proposed', revision: prerequisiteSuggestion.work.revision });

  const acceptedPrerequisite = await current.suggestions.decideCollectiveProjectWorkSuggestion(
    current.owner.sessionToken,
    {
      ...current.coordinates,
      requestId: 'accept-prerequisite-suggestion',
      workId: prerequisiteSuggestion.work.workId,
      expectedRevision: prerequisiteSuggestion.work.revision,
      expectedRoadmapRevision: acceptedTask.roadmap.revision,
      expectedTargetWorkRevision: current.target.revision,
      decision: 'accept',
    },
  );
  expect(acceptedPrerequisite.work).toMatchObject({ lifecycle: 'committed', status: 'unassigned' });
  expect(acceptedPrerequisite.roadmap.workIds).toContain(prerequisiteSuggestion.work.workId);
  expect(acceptedPrerequisite.targetWork).toMatchObject({
    workId: current.target.workId,
    dependencyWorkIds: [prerequisiteSuggestion.work.workId],
  });
  expect(acceptedPrerequisite.targetWork?.history.at(-1)).toMatchObject({
    action: 'dependencies_changed',
    eventId: prerequisiteSuggestion.event.eventId,
    note: expect.stringContaining('新增前置任务'),
  });

  const ignoredSuggestion = await propose(current, {
    suffix: '忽略候选',
    roadmapRevision: acceptedPrerequisite.roadmap.revision,
  });
  const ignored = await current.suggestions.decideCollectiveProjectWorkSuggestion(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'ignore-project-suggestion',
    workId: ignoredSuggestion.work.workId,
    expectedRevision: ignoredSuggestion.work.revision,
    expectedRoadmapRevision: acceptedPrerequisite.roadmap.revision,
    decision: 'ignore',
    reason: '当前版本不需要这项工作。',
  });
  expect(ignored.work).toMatchObject({ lifecycle: 'declined' });
  expect(ignored.roadmap.workIds).not.toContain(ignoredSuggestion.work.workId);
});

it('admits a pending Project suggestion only through its Project-owner decision', async () => {
  const current = await fixture();
  const member = await inviteMember(current, 'project-suggestion-member');
  const humanCandidate = await propose(current, {
    suffix: '普通提交不可绕过',
    roadmapRevision: current.project.revision,
  });
  await expect(
    current.store.commitCollectiveWork(member.sessionToken, {
      ...current.coordinates,
      requestId: 'member-generic-project-commit',
      workId: humanCandidate.work.workId,
      expectedRevision: humanCandidate.work.revision,
      accountability: 'self',
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_SUGGESTION_DECISION_REQUIRED' });

  const declineCandidate = await propose(current, {
    suffix: '普通拒绝不可绕过',
    roadmapRevision: current.project.revision,
  });
  await expect(
    current.store.declineCollectiveWork(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'owner-generic-project-decline',
      workId: declineCandidate.work.workId,
      expectedRevision: declineCandidate.work.revision,
      reason: '必须走项目决定入口',
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_SUGGESTION_DECISION_REQUIRED' });

  const agentCandidate = await propose(current, {
    suffix: '猫自动接纳不可绕过',
    roadmapRevision: current.project.revision,
  });
  await current.store.registerCollectiveWorkPolicy(current.owner.sessionToken, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    expectedRevision: 0,
    requestId: 'project-suggestion-work-policy',
    decisionMode: 'automatic',
    grants: [
      {
        grantRef: 'grant-project-suggestion',
        catIds: ['codex-sol'],
        channelIds: ['general'],
        requestingHumanIds: 'channel_members',
        requestKinds: ['guide'],
        expiresAt: null,
      },
    ],
  });
  await expect(
    current.store.acceptCollectiveWorkAsAgent(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
      participationRevision: 1,
      sourceEventId: agentCandidate.event.eventId,
      requestId: 'agent-generic-project-accept',
      catId: 'codex-sol',
      sessionRef: 'project-suggestion-agent-turn',
      grantRef: 'grant-project-suggestion',
      grantRevision: 1,
      requestKind: 'guide',
      title: agentCandidate.work.title,
      intendedOutcome: agentCandidate.work.intendedOutcome,
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_SUGGESTION_DECISION_REQUIRED' });

  const adopted = await current.suggestions.decideCollectiveProjectWorkSuggestion(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'project-owner-adopts-before-claim',
    workId: humanCandidate.work.workId,
    expectedRevision: humanCandidate.work.revision,
    expectedRoadmapRevision: current.project.revision,
    decision: 'accept',
  });
  const claimed = await current.store.commitCollectiveWork(member.sessionToken, {
    ...current.coordinates,
    requestId: 'member-claims-adopted-project-work',
    workId: adopted.work.workId,
    expectedRevision: adopted.work.revision,
    accountability: 'self',
  });
  expect(claimed).toMatchObject({
    lifecycle: 'committed',
    accountableHumanId: member.human.humanId,
  });
  expect(adopted.roadmap.workIds).toContain(humanCandidate.work.workId);
});
