import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

it('projects only visible Projects and dependency outcomes into a Cat Work context while preserving unreadable counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-project-context-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  await current.store.publishParticipation(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex-sol', displayName: '小太阳 · 砚砚', channelIds: ['general'] }],
  });

  const visibleProject = await current.store.createCollectiveProject(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'visible-project',
    channelId: 'general',
    title: '共同体项目管理',
    purpose: '让项目目标、前置结果和原讨论在同一上下文中可追溯。',
  });
  const visibleDependencyCreated = await current.store.createCollectiveProjectTask(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'visible-dependency',
    roadmapId: visibleProject.roadmapId,
    expectedRoadmapRevision: visibleProject.revision,
    channelId: 'general',
    title: '完成可见前置',
    intendedOutcome: '产出当前参与猫有权读取的前置结果。',
    accountability: 'self',
  });
  const visibleDependency = await current.store.completeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'complete-visible-dependency',
    workId: visibleDependencyCreated.work.workId,
    expectedRevision: visibleDependencyCreated.work.revision,
  });

  const primarySource = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'primary-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '请砚砚接着完成项目上下文。',
  });
  const primaryProposal = await current.store.proposeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'primary-proposal',
    sourceEventId: primarySource.eventId,
    title: '补齐猫的项目上下文',
    intendedOutcome: '猫能读到项目目标、可见前置结果和准确的不可读计数。',
  });
  const primary = await current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'primary-commit',
    workId: primaryProposal.workId,
    expectedRevision: primaryProposal.revision,
    assignment: {
      connectionId: current.connection.connectionId,
      catId: 'codex-sol',
      participationRevision: 1,
    },
  });
  await current.store.setCollectiveRoadmapWorks(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'visible-project-works',
    roadmapId: visibleProject.roadmapId,
    expectedRevision: visibleDependencyCreated.roadmap.revision,
    workIds: [visibleDependency.workId, primary.workId],
  });

  const hiddenSource = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'hidden-dependency-source',
    location: { channelId: 'private-planning' },
    recipient: { kind: 'channel' },
    body: '这是当前猫未参与频道中的前置。',
  });
  const hiddenProposal = await current.store.proposeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'hidden-dependency-proposal',
    sourceEventId: hiddenSource.eventId,
    title: '私密前置',
    intendedOutcome: '完成但不向未参与的猫泄露标题或正文。',
  });
  const hiddenCommitted = await current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'hidden-dependency-commit',
    workId: hiddenProposal.workId,
    expectedRevision: hiddenProposal.revision,
    accountability: 'self',
  });
  const hiddenDependency = await current.store.completeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'complete-hidden-dependency',
    workId: hiddenCommitted.workId,
    expectedRevision: hiddenCommitted.revision,
  });
  const withDependencies = await current.store.setCollectiveWorkDependencies(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'primary-dependencies',
    workId: primary.workId,
    expectedRevision: primary.revision,
    dependencyWorkIds: [visibleDependency.workId, hiddenDependency.workId],
  });

  const hiddenProject = await current.store.createCollectiveProject(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'hidden-project',
    channelId: 'private-planning',
    title: '不可读项目标题',
    purpose: '这个目标不能因共享一个 Work 泄露给未参与该频道的猫。',
  });
  await current.store.setCollectiveRoadmapWorks(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'hidden-project-works',
    roadmapId: hiddenProject.roadmapId,
    expectedRevision: hiddenProject.revision,
    workIds: [primary.workId],
  });

  const context = current.store.readCollectiveWorkSourceContext(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    sourceEventId: primarySource.eventId,
    catId: 'codex-sol',
    participationRevision: 1,
  });
  const matter = context.matters.find((candidate) => candidate.workId === primary.workId);
  expect(matter).toMatchObject({ revision: withDependencies.revision, status: 'ready' });
  expect(matter).toHaveProperty('projectContext', {
    projects: [
      expect.objectContaining({
        roadmapId: visibleProject.roadmapId,
        title: '共同体项目管理',
        purpose: '让项目目标、前置结果和原讨论在同一上下文中可追溯。',
        sourceLocation: { channelId: 'general' },
      }),
    ],
    unreadableProjectCount: 1,
    projectsHasMore: false,
    dependencies: [
      expect.objectContaining({
        workId: visibleDependency.workId,
        title: '完成可见前置',
        lifecycle: 'completed',
        status: 'completed',
        sourceLocation: { channelId: 'general' },
      }),
    ],
    unreadableDependencyCount: 1,
    dependenciesHasMore: false,
  });
  expect(JSON.stringify(matter)).not.toContain('不可读项目标题');
  expect(JSON.stringify(matter)).not.toContain('私密前置');
});
