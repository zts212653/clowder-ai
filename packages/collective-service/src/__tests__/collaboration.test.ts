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
  const directory = await mkdtemp(join(tmpdir(), 'collective-collaboration-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  await current.store.publishParticipation(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    revision: 1,
    agents: [
      { catId: 'codex-sol', displayName: '小太阳 · 砚砚', channelIds: ['general'] },
      { catId: 'codex-terra', displayName: 'Terra', channelIds: ['general'] },
    ],
  });
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'source-one',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '把完整 Collective 首页接到真实数据，并让结果回到这里。',
  });
  return { ...current, directory, source };
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

it('turns an exact Channel message into one durable proposal and an owner-accepted Cat assignment', async () => {
  const current = await fixture();
  const proposed = await propose(current, current.source.eventId, 'propose-homepage');
  expect(proposed).toMatchObject({
    sourceEventId: current.source.eventId,
    sourceLocation: { channelId: 'general' },
    title: current.source.body,
    intendedOutcome: current.source.body,
    lifecycle: 'proposed',
    status: 'proposed',
    revision: 1,
  });
  expect(proposed.accountableHumanId).toBeUndefined();
  expect(await propose(current, current.source.eventId, 'propose-homepage')).toEqual(proposed);
  await expect(
    current.store.proposeCollectiveWork(current.owner.sessionToken, {
      ...current.coordinates,
      sourceEventId: current.source.eventId,
      requestId: 'propose-homepage',
      title: 'Conflicting replay',
    }),
  ).rejects.toMatchObject({ code: 'COLLABORATION_OPERATION_CONFLICT' });

  const committed = await commit(current, proposed, 'codex-sol');
  expect(committed).toMatchObject({
    lifecycle: 'committed',
    status: 'ready',
    accountableHumanId: current.owner.human.humanId,
    assignment: {
      humanId: current.owner.human.humanId,
      connectionId: current.connection.connectionId,
      catId: 'codex-sol',
      displayName: '小太阳 · 砚砚',
      participationRevision: 1,
    },
    revision: 2,
  });
  const events = await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId);
  const assignment = events.find((event) => event.eventId === committed.assignmentEventId);
  expect(assignment).toMatchObject({
    actor: { kind: 'human', humanId: current.owner.human.humanId },
    location: { channelId: 'general', rootEventId: current.source.eventId },
    recipient: {
      kind: 'agent',
      humanId: current.owner.human.humanId,
      connectionId: current.connection.connectionId,
      agentId: 'codex-sol',
      participationRevision: 1,
    },
    replyToEventId: current.source.eventId,
    workRequest: 'entrust',
    body: current.source.body,
  });
  expect(await commit(current, proposed, 'codex-sol')).toEqual(committed);
  await expect(
    current.store.commitCollectiveWork(current.owner.sessionToken, {
      ...current.coordinates,
      workId: proposed.workId,
      expectedRevision: proposed.revision,
      requestId: 'stale-commit-homepage',
    }),
  ).rejects.toMatchObject({ code: 'WORK_REVISION_CONFLICT' });

  const reopened = await CollectiveServiceStore.open({ dataDirectory: current.directory });
  const projection = reopened.store.listCollectiveCollaboration(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  expect(projection.works).toHaveLength(1);
  expect(projection.works[0]).toEqual(committed);
});

it('keeps one accountable assignment while recording the delegated home Cat as the actual result author', async () => {
  const current = await fixture();
  const work = await commit(current, await propose(current, current.source.eventId, 'propose-delegated'), 'codex-sol');

  await expect(
    current.store.postAgentMessage(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
      clientEventId: 'delegated-result-without-assignment-owner',
      agent: {
        agentId: 'codex-terra',
        catId: 'codex-terra',
        displayName: 'Terra',
        sessionRef: 'invocation:delegated-result',
      },
      target: { kind: 'message', eventId: current.source.eventId },
      location: { channelId: 'general', rootEventId: current.source.eventId },
      recipient: { kind: 'channel' },
      participationRevision: 1,
      replyToEventId: work.assignmentEventId,
      workResultIntent: {
        assignmentEventId: work.assignmentEventId,
        participationRevision: 1,
        resultRevision: 1,
      },
      body: 'An ordinary participant cannot claim another Cat assignment.',
    }),
  ).rejects.toMatchObject({ code: 'RETURN_UNAVAILABLE' });

  const result = await current.store.postAgentMessage(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    clientEventId: 'delegated-result',
    agent: {
      agentId: 'codex-terra',
      catId: 'codex-terra',
      displayName: 'Terra',
      sessionRef: 'invocation:delegated-result',
    },
    target: { kind: 'message', eventId: current.source.eventId },
    location: { channelId: 'general', rootEventId: current.source.eventId },
    recipient: { kind: 'channel' },
    participationRevision: 1,
    replyToEventId: work.assignmentEventId,
    workResultIntent: {
      assignmentEventId: work.assignmentEventId,
      assignmentCatId: 'codex-sol',
      participationRevision: 1,
      resultRevision: 1,
    },
    body: 'Terra helped the accountable Cat and returned the result.',
  });

  expect(result).toMatchObject({
    actor: {
      kind: 'agent',
      agent: { agentId: 'codex-terra', displayName: 'Terra' },
      provenance: { catId: 'codex-terra' },
    },
    workResultReceipt: {
      workId: work.workId,
      assignmentEventId: work.assignmentEventId,
      assignmentCatId: 'codex-sol',
      catId: 'codex-terra',
    },
  });
  const returned = current.store
    .listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId)
    .works.find((candidate) => candidate.workId === work.workId);
  expect(returned).toMatchObject({
    lifecycle: 'result_ready',
    assignment: { catId: 'codex-sol' },
    history: [
      expect.anything(),
      expect.anything(),
      {
        action: 'result_returned',
        actor: { kind: 'agent', catId: 'codex-terra', displayName: 'Terra' },
        eventId: result.eventId,
      },
    ],
  });
});

it('keeps feedback and prior result versions while the same Work returns and accepts a revision', async () => {
  const current = await fixture();
  const work = await commit(current, await propose(current, current.source.eventId, 'propose-revision'), 'codex-sol');
  const firstResultInput = {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    clientEventId: 'revision-result-v1',
    agent: {
      agentId: 'codex-sol',
      catId: 'codex-sol',
      displayName: '小太阳 · 砚砚',
      sessionRef: 'invocation:revision-v1',
    },
    target: { kind: 'message' as const, eventId: current.source.eventId },
    location: { channelId: 'general', rootEventId: current.source.eventId },
    recipient: { kind: 'channel' as const },
    participationRevision: 1,
    replyToEventId: work.assignmentEventId,
    workResultIntent: {
      assignmentEventId: work.assignmentEventId,
      participationRevision: 1,
      resultRevision: 1,
    },
    body: '第一版结果。',
  };
  const firstResult = await current.store.postAgentMessage(current.connection.endpointCredential, firstResultInput);
  const firstReady = current.store
    .listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId)
    .works.find((candidate) => candidate.workId === work.workId);
  expect(firstReady).toMatchObject({
    lifecycle: 'result_ready',
    resultEventId: firstResult.eventId,
    resultRevision: 1,
  });

  const revising = await current.store.requestCollectiveWorkRevision(current.owner.sessionToken, {
    ...current.coordinates,
    workId: work.workId,
    expectedRevision: firstReady?.revision,
    resultEventId: firstResult.eventId,
    resultRevision: 1,
    feedback: '请补上重启后的恢复证据。',
    requestId: 'request-revision-v2',
  });
  expect(revising).toMatchObject({
    lifecycle: 'in_progress',
    status: 'in_progress',
    assignment: { catId: 'codex-sol' },
    resultEventId: firstResult.eventId,
    resultRevision: 1,
    history: expect.arrayContaining([
      expect.objectContaining({
        action: 'result_returned',
        eventId: firstResult.eventId,
        resultRevision: 1,
      }),
      expect.objectContaining({
        action: 'revision_requested',
        eventId: firstResult.eventId,
        resultRevision: 1,
        note: '请补上重启后的恢复证据。',
      }),
    ]),
  });
  const feedbackEvent = (
    await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId)
  ).find((event) => event.workRequest === 'revise');
  expect(feedbackEvent).toMatchObject({
    actor: { kind: 'human', humanId: current.owner.human.humanId },
    recipient: {
      kind: 'agent',
      connectionId: current.connection.connectionId,
      agentId: 'codex-sol',
    },
    replyToEventId: firstResult.eventId,
    body: '请补上重启后的恢复证据。',
    workRevisionNotice: {
      workId: work.workId,
      workRevision: revising.revision,
      assignmentEventId: work.assignmentEventId,
      resultEventId: firstResult.eventId,
      resultRevision: 1,
    },
  });

  await expect(
    current.store.postAgentMessage(current.connection.endpointCredential, {
      ...firstResultInput,
      clientEventId: 'stale-revision-result',
      agent: { ...firstResultInput.agent, sessionRef: 'invocation:stale-revision' },
      body: '错误地再次声称这是第一版。',
    }),
  ).rejects.toMatchObject({ code: 'WORK_RESULT_REVISION_CONFLICT' });

  const secondResultInput = {
    ...firstResultInput,
    clientEventId: 'revision-result-v2',
    agent: { ...firstResultInput.agent, sessionRef: 'invocation:revision-v2' },
    workResultIntent: { ...firstResultInput.workResultIntent, resultRevision: 2 },
    body: '第二版结果，已经补上重启恢复证据。',
  };
  const secondResult = await current.store.postAgentMessage(current.connection.endpointCredential, secondResultInput);
  expect(await current.store.postAgentMessage(current.connection.endpointCredential, secondResultInput)).toEqual(
    secondResult,
  );
  const secondReady = current.store
    .listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId)
    .works.find((candidate) => candidate.workId === work.workId);
  expect(secondReady).toMatchObject({
    lifecycle: 'result_ready',
    resultEventId: secondResult.eventId,
    resultRevision: 2,
    history: expect.arrayContaining([
      expect.objectContaining({ action: 'result_returned', eventId: firstResult.eventId, resultRevision: 1 }),
      expect.objectContaining({ action: 'revision_requested', eventId: firstResult.eventId, resultRevision: 1 }),
      expect.objectContaining({ action: 'result_returned', eventId: secondResult.eventId, resultRevision: 2 }),
    ]),
  });
  expect(secondReady?.history.filter((entry) => entry.action === 'result_returned')).toHaveLength(2);

  await expect(
    current.store.acceptCollectiveWorkResult(current.owner.sessionToken, {
      ...current.coordinates,
      workId: work.workId,
      expectedRevision: secondReady?.revision,
      resultEventId: firstResult.eventId,
      resultRevision: 1,
      requestId: 'accept-stale-result-v1',
    }),
  ).rejects.toMatchObject({ code: 'WORK_RESULT_NOT_CURRENT' });
  const accepted = await current.store.acceptCollectiveWorkResult(current.owner.sessionToken, {
    ...current.coordinates,
    workId: work.workId,
    expectedRevision: secondReady?.revision,
    resultEventId: secondResult.eventId,
    resultRevision: 2,
    requestId: 'accept-result-v2',
  });
  expect(accepted).toMatchObject({
    lifecycle: 'completed',
    resultEventId: secondResult.eventId,
    resultRevision: 2,
    history: expect.arrayContaining([
      expect.objectContaining({
        action: 'result_accepted',
        eventId: secondResult.eventId,
        resultRevision: 2,
      }),
    ]),
  });
});

it('keeps Roadmap dependencies live while an exact Cat result unblocks downstream Work', async () => {
  const current = await fixture();
  const sourceB = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'source-two',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '等首页真实数据接好后，再做完整的团队验收。',
  });
  const workA = await commit(current, await propose(current, current.source.eventId, 'propose-a'), 'codex-sol');
  const workB = await commit(current, await propose(current, sourceB.eventId, 'propose-b'), 'codex-terra');
  const dependent = await current.store.setCollectiveWorkDependencies(current.owner.sessionToken, {
    ...current.coordinates,
    workId: workB.workId,
    expectedRevision: workB.revision,
    dependencyWorkIds: [workA.workId],
    requestId: 'dependencies-b-on-a',
  });
  expect(dependent.status).toBe('blocked');

  const roadmap = await current.store.createCollectiveRoadmap(current.owner.sessionToken, {
    ...current.coordinates,
    sourceEventId: current.source.eventId,
    requestId: 'roadmap-release',
    title: 'F290 可用版本',
    purpose: '从真实消息、工作与结果形成一条可恢复路线。',
    workIds: [workA.workId, workB.workId],
  });
  expect(roadmap).toMatchObject({
    status: 'active',
    accountableHumanId: current.owner.human.humanId,
    workIds: [workA.workId, workB.workId],
    revision: 1,
  });

  const result = await current.store.postAgentMessage(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    clientEventId: 'result-a',
    agent: {
      agentId: 'codex-sol',
      catId: 'codex-sol',
      displayName: '小太阳 · 砚砚',
      sessionRef: 'invocation:result-a',
    },
    target: { kind: 'message', eventId: current.source.eventId },
    location: { channelId: 'general', rootEventId: current.source.eventId },
    recipient: { kind: 'channel' },
    participationRevision: 1,
    replyToEventId: workA.assignmentEventId,
    workResultIntent: {
      assignmentEventId: workA.assignmentEventId,
      participationRevision: 1,
      resultRevision: 1,
    },
    body: '首页已接到真实 Service，浏览器旅程通过。',
  });
  expect(result.workResultReceipt).toMatchObject({
    workId: workA.workId,
    assignmentEventId: workA.assignmentEventId,
    connectionId: current.connection.connectionId,
    humanId: current.owner.human.humanId,
    catId: 'codex-sol',
    participationRevision: 1,
    resultRevision: 1,
  });
  let projection = current.store.listCollectiveCollaboration(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  const returned = projection.works.find((work) => work.workId === workA.workId);
  expect(returned).toMatchObject({ lifecycle: 'result_ready', status: 'result_ready', resultEventId: result.eventId });
  const completed = await current.store.acceptCollectiveWorkResult(current.owner.sessionToken, {
    ...current.coordinates,
    workId: workA.workId,
    expectedRevision: returned?.revision,
    resultEventId: result.eventId,
    resultRevision: 1,
    requestId: 'accept-result-a',
  });
  expect(completed).toMatchObject({ lifecycle: 'completed', status: 'completed', resultEventId: result.eventId });
  expect(
    current.store.readAssignedWork(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
      workId: completed.workId,
    }),
  ).toEqual(completed);
  expect(
    current.store.readAssignedWorkByAssignment(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
      assignmentEventId: completed.assignmentEventId,
    }),
  ).toEqual(completed);
  expect(() =>
    current.store.readAssignedWorkByAssignment(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
      assignmentEventId: 'evt_missingassignment',
    }),
  ).toThrow(expect.objectContaining({ code: 'WORK_NOT_FOUND' }));
  projection = current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId);
  expect(projection.works.find((work) => work.workId === workB.workId)?.status).toBe('ready');
  expect(projection.roadmaps[0]).toEqual(roadmap);

  await expect(
    current.store.setCollectiveWorkDependencies(current.owner.sessionToken, {
      ...current.coordinates,
      workId: workA.workId,
      expectedRevision: completed.revision,
      dependencyWorkIds: [workB.workId],
      requestId: 'cycle-a-on-b',
    }),
  ).rejects.toMatchObject({ code: 'WORK_DEPENDENCY_CYCLE' });
  await current.store.revokeConnection({
    sessionToken: current.owner.sessionToken,
    collectiveId: current.coordinates.collectiveId,
    connectionId: current.connection.connectionId,
  });
  expect(() =>
    current.store.readAssignedWork(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
      workId: completed.workId,
    }),
  ).toThrow(expect.objectContaining({ code: 'CONNECTION_REVOKED' }));
});

it('does not interpret an ordinary same-Cat reply as the assigned Work result', async () => {
  const current = await fixture();
  const committed = await commit(
    current,
    await propose(current, current.source.eventId, 'generic-reply-is-not-a-result'),
    'codex-sol',
  );

  await expect(
    current.store.postAgentMessage(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
      clientEventId: 'caller-shaped-work-result',
      agent: {
        agentId: 'codex-sol',
        catId: 'codex-sol',
        displayName: '小太阳 · 砚砚',
        sessionRef: 'invocation:caller-shaped-result',
      },
      target: { kind: 'message', eventId: current.source.eventId },
      location: { channelId: 'general', rootEventId: current.source.eventId },
      recipient: { kind: 'channel' },
      participationRevision: 1,
      replyToEventId: committed.assignmentEventId,
      workResultIntent: {
        assignmentEventId: 'evt_other-assignment',
        participationRevision: 1,
        resultRevision: 1,
      },
      body: '调用方不能自己声称这是另一条 assignment 的结果。',
    }),
  ).rejects.toMatchObject({ code: 'RETURN_UNAVAILABLE' });

  const reply = await current.store.postAgentMessage(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    clientEventId: 'ordinary-same-cat-reply',
    agent: {
      agentId: 'codex-sol',
      catId: 'codex-sol',
      displayName: '小太阳 · 砚砚',
      sessionRef: 'invocation:ordinary-callback',
    },
    target: { kind: 'message', eventId: current.source.eventId },
    location: { channelId: 'general', rootEventId: current.source.eventId },
    recipient: { kind: 'channel' },
    participationRevision: 1,
    replyToEventId: committed.assignmentEventId,
    body: '这是普通对话回复，不是该 Work 的精确结果回流。',
  });

  expect(reply.replyToEventId).toBe(committed.assignmentEventId);
  expect(
    current.store
      .listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId)
      .works.find((work) => work.workId === committed.workId),
  ).toMatchObject({
    lifecycle: 'committed',
    status: 'ready',
    revision: committed.revision,
  });
});

it('rejects missing sources, stale results, and Cat assignments outside the caller own current Café', async () => {
  const current = await fixture();
  await expect(propose(current, 'evt_missing-source', 'missing-source')).rejects.toMatchObject({
    code: 'WORK_SOURCE_UNAVAILABLE',
  });
  await expect(
    current.store.proposeCollectiveWorkAsAgent(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
      sourceEventId: current.source.eventId,
      requestId: 'undeclared-cat-is-not-agent-authority',
      catId: 'not-declared',
      participationRevision: 1,
    }),
  ).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
  const work = await propose(current, current.source.eventId, 'valid-source');
  await expect(commit(current, work, 'not-declared')).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
  const committed = await commit(current, work);
  expect(() =>
    current.store.readAssignedWork(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
      workId: committed.workId,
    }),
  ).toThrow(expect.objectContaining({ code: 'WORK_AUTHORITY_REQUIRED' }));
  await expect(
    current.store.acceptCollectiveWorkResult(current.owner.sessionToken, {
      ...current.coordinates,
      workId: committed.workId,
      expectedRevision: committed.revision,
      resultEventId: 'evt_missing-result',
      resultRevision: 1,
      requestId: 'accept-without-result',
    }),
  ).rejects.toMatchObject({ code: 'WORK_RESULT_UNAVAILABLE' });
});

it('lets a currently authorized Cat propose, but not commit, Work from its exact public source', async () => {
  const current = await fixture();
  const request = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'response-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    attentionRequest: 'response_requested',
    body: '把这段讨论整理成可以继续推进的事项。',
  });
  const proposed = await current.store.proposeCollectiveWorkAsAgent(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    sourceEventId: request.eventId,
    requestId: 'cat-proposal',
    catId: 'codex-sol',
    participationRevision: 1,
    title: '整理为可继续推进的事项',
  });
  expect(proposed).toMatchObject({
    lifecycle: 'proposed',
    status: 'proposed',
    sourceEventId: request.eventId,
    proposedBy: {
      kind: 'agent',
      humanId: current.owner.human.humanId,
      connectionId: current.connection.connectionId,
      catId: 'codex-sol',
      displayName: '小太阳 · 砚砚',
    },
  });
  expect(proposed.accountableHumanId).toBeUndefined();
});

it('keeps decline and Roadmap membership as explicit idempotent Human decisions', async () => {
  const current = await fixture();
  const declinedProposal = await propose(current, current.source.eventId, 'proposal-to-decline');
  const declined = await current.store.declineCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    workId: declinedProposal.workId,
    expectedRevision: declinedProposal.revision,
    requestId: 'decline-proposal',
    reason: '继续讨论，暂时不形成承诺。',
  });
  expect(declined).toMatchObject({ lifecycle: 'declined', status: 'declined', revision: 2 });

  const sourceB = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'roadmap-work-b',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '完成可恢复的团队验收。',
  });
  const workA = await commit(current, await propose(current, current.source.eventId, 'roadmap-a'));
  const workB = await commit(current, await propose(current, sourceB.eventId, 'roadmap-b'));
  const roadmap = await current.store.createCollectiveRoadmap(current.owner.sessionToken, {
    ...current.coordinates,
    sourceEventId: current.source.eventId,
    requestId: 'roadmap-explicit-membership',
    title: '真实协作路线',
    purpose: '把两项已承诺工作放在同一条完成路径上。',
    workIds: [workA.workId],
  });
  const updated = await current.store.setCollectiveRoadmapWorks(current.owner.sessionToken, {
    ...current.coordinates,
    roadmapId: roadmap.roadmapId,
    expectedRevision: roadmap.revision,
    requestId: 'roadmap-add-work-b',
    workIds: [workA.workId, workB.workId],
  });
  expect(updated).toMatchObject({ revision: 2, workIds: [workA.workId, workB.workId] });
  expect(
    await current.store.setCollectiveRoadmapWorks(current.owner.sessionToken, {
      ...current.coordinates,
      roadmapId: roadmap.roadmapId,
      expectedRevision: roadmap.revision,
      requestId: 'roadmap-add-work-b',
      workIds: [workA.workId, workB.workId],
    }),
  ).toEqual(updated);
  await expect(
    current.store.setCollectiveRoadmapWorks(current.owner.sessionToken, {
      ...current.coordinates,
      roadmapId: roadmap.roadmapId,
      expectedRevision: updated.revision,
      requestId: 'roadmap-add-declined',
      workIds: [workA.workId, declined.workId],
    }),
  ).rejects.toMatchObject({ code: 'WORK_NOT_COMMITTED' });
});
