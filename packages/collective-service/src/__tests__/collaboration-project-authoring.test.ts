import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectiveAccountabilityAttentionReadResponse } from '@cat-cafe/shared';
import { afterEach, expect, it } from 'vitest';
import { CollectiveServiceStore } from '../store.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

type ProjectRecord = {
  readonly roadmapId: string;
  readonly revision: number;
  readonly sourceEventId: string;
  readonly workIds: readonly string[];
};

type AccountabilityRequest = {
  readonly accountabilityRequestId: string;
  readonly targetHumanId: string;
  readonly status: 'pending' | 'accepted' | 'declined';
  readonly requestEventId: string;
  readonly responseEventId?: string;
};

type ProjectTask = {
  readonly workId: string;
  readonly revision: number;
  readonly sourceEventId: string;
  readonly lifecycle: string;
  readonly status: string;
  readonly accountableHumanId?: string;
  readonly assignment?: { readonly humanId: string; readonly connectionId: string; readonly catId: string };
  readonly assignmentEventId?: string;
  readonly accountabilityRequests: readonly AccountabilityRequest[];
  readonly history: readonly { readonly action: string; readonly eventId?: string }[];
};

type ProjectTaskMutation = {
  readonly roadmap: ProjectRecord;
  readonly work: ProjectTask;
};

interface ProjectAuthoringStore {
  commitCollectiveWork(sessionToken: string, input: Record<string, unknown>): Promise<ProjectTask>;
  createCollectiveProject(sessionToken: string, input: Record<string, unknown>): Promise<ProjectRecord>;
  createCollectiveProjectTask(sessionToken: string, input: Record<string, unknown>): Promise<ProjectTaskMutation>;
  requestCollectiveWorkAccountability(sessionToken: string, input: Record<string, unknown>): Promise<ProjectTask>;
  respondCollectiveWorkAccountability(sessionToken: string, input: Record<string, unknown>): Promise<ProjectTask>;
  readCollectiveAccountabilityAttention(
    endpointCredential: string,
    input: Record<string, unknown>,
  ): CollectiveAccountabilityAttentionReadResponse;
  setCollectiveRoadmapWorks(sessionToken: string, input: Record<string, unknown>): Promise<ProjectRecord>;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-project-authoring-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  return {
    ...current,
    directory,
    authoring: current.store as unknown as ProjectAuthoringStore,
  };
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
  return current.store.exchangeHumanAuthCompletion(completion.completionToken);
}

async function declareMemberCat(
  current: Awaited<ReturnType<typeof fixture>>,
  member: Awaited<ReturnType<typeof inviteMember>>,
) {
  const pairing = await current.store.createPairingIntent({
    sessionToken: member.sessionToken,
    collectiveId: current.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5184',
    nonce: 'project-assignee-pairing-nonce',
  });
  const connection = await current.store.exchangePairingIntent({
    ...pairing,
    endpointLabel: '受邀成员的 Café',
  });
  await current.store.publishParticipation(connection.endpointCredential, {
    ...current.coordinates,
    connectionId: connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex-astra', displayName: '小星星 · 砚砚', channelIds: ['general'] }],
  });
  return connection;
}

async function createProject(current: Awaited<ReturnType<typeof fixture>>) {
  return current.authoring.createCollectiveProject(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'project-create',
    channelId: 'general',
    title: '跨家协作正式上线',
    purpose: '共同完成项目页创建、责任请求和真实验收。',
  });
}

it('atomically creates Project and Task sources with replay-safe object identity and zero failed residue', async () => {
  const current = await fixture();
  const project = await createProject(current);
  expect(project).toMatchObject({ revision: 1, workIds: [] });

  const projectEvents = await current.store.listEventsForHuman(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  expect(projectEvents).toHaveLength(1);
  expect(projectEvents[0]).toMatchObject({
    eventId: project.sourceEventId,
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
  });
  expect(projectEvents[0]?.body).toContain('跨家协作正式上线');
  expect(await createProject(current)).toEqual(project);
  expect(
    await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId),
  ).toHaveLength(1);

  const created = await current.authoring.createCollectiveProjectTask(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'task-create-self',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: project.revision,
    channelId: 'general',
    title: '接通真实创建路径',
    intendedOutcome: '人在项目页提交后，同一事务留下来源、任务和项目关系。',
    accountability: 'self',
  });
  expect(created.work).toMatchObject({
    lifecycle: 'committed',
    status: 'ready',
    accountableHumanId: current.owner.human.humanId,
    revision: 1,
  });
  expect(created.roadmap).toMatchObject({ revision: 2, workIds: [created.work.workId] });
  expect(created.work.history).toEqual([
    expect.objectContaining({ action: 'committed', eventId: created.work.sourceEventId }),
  ]);
  const createdEvents = await current.store.listEventsForHuman(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  expect(createdEvents.find((event) => event.eventId === created.work.sourceEventId)?.body).toContain(
    '接通真实创建路径',
  );
  expect(
    await current.authoring.createCollectiveProjectTask(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'task-create-self',
      roadmapId: project.roadmapId,
      expectedRoadmapRevision: project.revision,
      channelId: 'general',
      title: '接通真实创建路径',
      intendedOutcome: '人在项目页提交后，同一事务留下来源、任务和项目关系。',
      accountability: 'self',
    }),
  ).toEqual(created);

  const beforeFailure = current.store.listCollectiveCollaboration(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  const beforeFailureEvents = await current.store.listEventsForHuman(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  await expect(
    current.authoring.createCollectiveProjectTask(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'task-create-stale-project',
      roadmapId: project.roadmapId,
      expectedRoadmapRevision: project.revision,
      channelId: 'general',
      title: '不该留下的任务',
      intendedOutcome: '项目 revision 冲突时，来源和对象都不能留下。',
      accountability: 'unassigned',
    }),
  ).rejects.toMatchObject({ code: 'ROADMAP_REVISION_CONFLICT' });
  expect(
    current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId),
  ).toEqual(beforeFailure);
  expect(await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId)).toEqual(
    beforeFailureEvents,
  );
});

it('rolls back the source, Task, and Project membership when an inline responsibility request is invalid', async () => {
  const current = await fixture();
  const project = await createProject(current);
  const before = current.store.listCollectiveCollaboration(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );
  const beforeEvents = await current.store.listEventsForHuman(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  );

  await expect(
    current.authoring.createCollectiveProjectTask(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'task-create-invalid-member-request',
      roadmapId: project.roadmapId,
      expectedRoadmapRevision: project.revision,
      channelId: 'general',
      title: '不该留下的跨成员任务',
      intendedOutcome: '具名对象不是共同体成员时，整个创建操作都应回滚。',
      accountability: 'unassigned',
      requestedAccountableHumanId: 'human_not_a_member',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });

  expect(
    current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId),
  ).toEqual(before);
  expect(await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId)).toEqual(
    beforeEvents,
  );
});

it('keeps a cross-Human responsibility request pending until the named Human accepts it', async () => {
  const current = await fixture();
  const member = await inviteMember(current, 'project-assignee');
  const memberConnection = await declareMemberCat(current, member);
  const project = await createProject(current);
  const created = await current.authoring.createCollectiveProjectTask(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'task-create-request-member',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: project.revision,
    channelId: 'general',
    title: '由另一位成员负责验收',
    intendedOutcome: '只有受邀成员本人接受后，任务才建立新的负责人承诺。',
    accountability: 'unassigned',
    requestedAccountableHumanId: member.human.humanId,
  });
  expect(created.work).toMatchObject({ status: 'unassigned', revision: 2 });
  expect(created.work.accountableHumanId).toBeUndefined();
  expect(created.work.accountabilityRequests).toEqual([
    expect.objectContaining({
      targetHumanId: member.human.humanId,
      status: 'pending',
    }),
  ]);
  const request = created.work.accountabilityRequests[0];
  expect(request).toBeDefined();
  const memberEvents = await current.store.listEventsForHuman(member.sessionToken, current.coordinates.collectiveId);
  expect(memberEvents.find((event) => event.eventId === request?.requestEventId)).toMatchObject({
    recipient: { kind: 'human', humanId: member.human.humanId },
  });

  await expect(
    current.authoring.respondCollectiveWorkAccountability(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'owner-cannot-accept-for-member',
      workId: created.work.workId,
      expectedRevision: created.work.revision,
      accountabilityRequestId: request?.accountabilityRequestId,
      decision: 'accept',
    }),
  ).rejects.toMatchObject({ code: 'ACCOUNTABILITY_REQUEST_TARGET_REQUIRED' });

  await expect(
    current.authoring.commitCollectiveWork(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'owner-cannot-bypass-pending-responsibility',
      workId: created.work.workId,
      expectedRevision: created.work.revision,
      accountability: 'self',
    }),
  ).rejects.toMatchObject({ code: 'ACCOUNTABILITY_REQUEST_PENDING' });

  const beforeInvalidAcceptance = current.store.listCollectiveCollaboration(
    member.sessionToken,
    current.coordinates.collectiveId,
  );
  const beforeInvalidAcceptanceEvents = await current.store.listEventsForHuman(
    member.sessionToken,
    current.coordinates.collectiveId,
  );
  await expect(
    current.authoring.respondCollectiveWorkAccountability(member.sessionToken, {
      ...current.coordinates,
      requestId: 'member-invalid-cat-does-not-consume-request',
      workId: created.work.workId,
      expectedRevision: created.work.revision,
      accountabilityRequestId: request?.accountabilityRequestId,
      decision: 'accept',
      assignment: {
        connectionId: memberConnection.connectionId,
        catId: 'cat-not-declared',
        participationRevision: 1,
      },
    }),
  ).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
  expect(current.store.listCollectiveCollaboration(member.sessionToken, current.coordinates.collectiveId)).toEqual(
    beforeInvalidAcceptance,
  );
  expect(await current.store.listEventsForHuman(member.sessionToken, current.coordinates.collectiveId)).toEqual(
    beforeInvalidAcceptanceEvents,
  );

  const accepted = await current.authoring.respondCollectiveWorkAccountability(member.sessionToken, {
    ...current.coordinates,
    requestId: 'member-accepts-responsibility',
    workId: created.work.workId,
    expectedRevision: created.work.revision,
    accountabilityRequestId: request?.accountabilityRequestId,
    decision: 'accept',
    assignment: {
      connectionId: memberConnection.connectionId,
      catId: 'codex-astra',
      participationRevision: 1,
    },
  });
  expect(accepted).toMatchObject({
    status: 'ready',
    accountableHumanId: member.human.humanId,
    assignment: {
      humanId: member.human.humanId,
      connectionId: memberConnection.connectionId,
      catId: 'codex-astra',
    },
    revision: 3,
  });
  expect(accepted.accountabilityRequests[0]).toMatchObject({ status: 'accepted' });
  expect(accepted.history.at(-1)).toMatchObject({
    action: 'accountability_request_accepted',
    eventId: accepted.accountabilityRequests[0]?.responseEventId,
  });
  expect(
    await current.authoring.respondCollectiveWorkAccountability(member.sessionToken, {
      ...current.coordinates,
      requestId: 'member-accepts-responsibility',
      workId: created.work.workId,
      expectedRevision: created.work.revision,
      accountabilityRequestId: request?.accountabilityRequestId,
      decision: 'accept',
      assignment: {
        connectionId: memberConnection.connectionId,
        catId: 'codex-astra',
        participationRevision: 1,
      },
    }),
  ).toEqual(accepted);

  const acceptedEvents = await current.store.listEventsForHuman(member.sessionToken, current.coordinates.collectiveId);
  expect(acceptedEvents.find((event) => event.eventId === accepted.assignmentEventId)).toMatchObject({
    recipient: {
      kind: 'agent',
      humanId: member.human.humanId,
      connectionId: memberConnection.connectionId,
      agentId: 'codex-astra',
    },
    workRequest: 'entrust',
  });

  const reopened = await CollectiveServiceStore.open({
    dataDirectory: current.directory,
    humanAuthProvider: current.humanAuthProvider,
  });
  const reopenedWork = reopened.store
    .listCollectiveCollaboration(member.sessionToken, current.coordinates.collectiveId)
    .works.find((work) => work.workId === accepted.workId);
  expect(reopenedWork).toMatchObject({ accountableHumanId: member.human.humanId, status: 'ready' });
  expect(reopenedWork?.accountabilityRequests[0]).toMatchObject({ status: 'accepted' });
});

it('reads only the endpoint Human pending requests with complete pagination and retires inoperable Project Tasks', async () => {
  const current = await fixture();
  const member = await inviteMember(current, 'project-attention-member');
  const memberConnection = await declareMemberCat(current, member);
  const project = await createProject(current);
  const first = await current.authoring.createCollectiveProjectTask(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'attention-task-one',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: project.revision,
    channelId: 'general',
    title: '第一项待接责任务',
    intendedOutcome: '第一项请求只出现在目标成员自己的 Host。',
    accountability: 'unassigned',
    requestedAccountableHumanId: member.human.humanId,
  });
  const second = await current.authoring.createCollectiveProjectTask(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'attention-task-two',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: first.roadmap.revision,
    channelId: 'general',
    title: '第二项待接责任务',
    intendedOutcome: '第二项请求证明读取完整分页后才能报告精确覆盖。',
    accountability: 'unassigned',
    requestedAccountableHumanId: member.human.humanId,
  });
  const request = {
    ...current.coordinates,
    connectionId: memberConnection.connectionId,
    offset: 0,
    limit: 1,
  };
  const pageOne = current.authoring.readCollectiveAccountabilityAttention(memberConnection.endpointCredential, request);
  const pageTwo = current.authoring.readCollectiveAccountabilityAttention(memberConnection.endpointCredential, {
    ...request,
    offset: 1,
    snapshot: pageOne.page.snapshot,
  });
  expect(pageOne).toMatchObject({
    identity: {
      ...current.coordinates,
      connectionId: memberConnection.connectionId,
      authorizedHumanId: member.human.humanId,
    },
    page: { offset: 0, limit: 1, hasMore: true, totalCount: 2 },
  });
  expect(pageTwo.page).toEqual({
    offset: 1,
    limit: 1,
    hasMore: false,
    snapshot: pageOne.page.snapshot,
    totalCount: 2,
  });
  expect(new Set([...pageOne.items, ...pageTwo.items].map((item) => item.workId))).toEqual(
    new Set([first.work.workId, second.work.workId]),
  );
  for (const item of [...pageOne.items, ...pageTwo.items]) {
    expect(item).toMatchObject({
      producerId: 'f290.collective_work_accountability_request',
      targetHumanId: member.human.humanId,
      status: 'pending',
      roadmapId: project.roadmapId,
      projectTitle: '跨家协作正式上线',
      channelId: 'general',
      expectedProducerRevision: item.workRevision,
    });
    expect(item.subjectRef).toContain(item.accountabilityRequestId);
    expect(item.actionRef).toContain(`accountabilityRequestId=${item.accountabilityRequestId}`);
  }

  const ownerRead = current.authoring.readCollectiveAccountabilityAttention(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    offset: 0,
    limit: 10,
  });
  expect(ownerRead.items).toEqual([]);
  expect(ownerRead.page.hasMore).toBe(false);

  const detachedProject = await current.authoring.setCollectiveRoadmapWorks(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'attention-project-detach-pending-tasks',
    roadmapId: project.roadmapId,
    expectedRevision: second.roadmap.revision,
    workIds: [],
  });
  expect(detachedProject).toMatchObject({ workIds: [] });
  expect(
    current.authoring.readCollectiveAccountabilityAttention(memberConnection.endpointCredential, {
      ...request,
      limit: 10,
    }).items,
  ).toEqual([]);
  await expect(
    current.authoring.respondCollectiveWorkAccountability(member.sessionToken, {
      ...current.coordinates,
      requestId: 'cannot-accept-completed-project-task',
      workId: first.work.workId,
      expectedRevision: first.work.revision,
      accountabilityRequestId: first.work.accountabilityRequests[0]?.accountabilityRequestId,
      decision: 'accept',
    }),
  ).rejects.toMatchObject({ code: 'ACCOUNTABILITY_REQUEST_UNAVAILABLE' });
});

it('refuses to mix responsibility pages after the pending source set changes', async () => {
  const current = await fixture();
  const member = await inviteMember(current, 'project-attention-snapshot-member');
  const memberConnection = await declareMemberCat(current, member);
  const project = await createProject(current);
  const first = await current.authoring.createCollectiveProjectTask(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'snapshot-task-one',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: project.revision,
    channelId: 'general',
    title: '快照第一项',
    intendedOutcome: '第一页读完后会被正常处理。',
    accountability: 'unassigned',
    requestedAccountableHumanId: member.human.humanId,
  });
  const second = await current.authoring.createCollectiveProjectTask(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'snapshot-task-two',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: first.roadmap.revision,
    channelId: 'general',
    title: '快照第二项',
    intendedOutcome: '源集合变化后不能被 offset 跳过。',
    accountability: 'unassigned',
    requestedAccountableHumanId: member.human.humanId,
  });
  const request = {
    ...current.coordinates,
    connectionId: memberConnection.connectionId,
    offset: 0,
    limit: 1,
  };
  const firstPage = current.authoring.readCollectiveAccountabilityAttention(
    memberConnection.endpointCredential,
    request,
  );
  const selected = [first.work, second.work].find((work) => work.workId === firstPage.items[0]?.workId);
  expect(selected).toBeDefined();
  await current.authoring.respondCollectiveWorkAccountability(member.sessionToken, {
    ...current.coordinates,
    requestId: 'snapshot-intervening-decline',
    workId: selected?.workId,
    expectedRevision: selected?.revision,
    accountabilityRequestId: selected?.accountabilityRequests[0]?.accountabilityRequestId,
    decision: 'decline',
  });
  let failure: unknown;
  try {
    current.authoring.readCollectiveAccountabilityAttention(memberConnection.endpointCredential, {
      ...request,
      offset: 1,
      snapshot: firstPage.page.snapshot,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'ACCOUNTABILITY_ATTENTION_SNAPSHOT_CHANGED', statusCode: 409 });
});

it('lets the named Human decline without assigning responsibility and rejects forged or duplicate requests', async () => {
  const current = await fixture();
  const member = await inviteMember(current, 'project-decline');
  const project = await createProject(current);
  const created = await current.authoring.createCollectiveProjectTask(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'task-create-unassigned',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: project.revision,
    channelId: 'general',
    title: '等待负责人',
    intendedOutcome: '项目负责人可以向具名成员发出请求，但不能替对方接受。',
    accountability: 'unassigned',
  });

  await expect(
    current.authoring.requestCollectiveWorkAccountability(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'request-non-member',
      roadmapId: project.roadmapId,
      workId: created.work.workId,
      expectedRevision: created.work.revision,
      targetHumanId: 'human_not_a_member',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });

  const requested = await current.authoring.requestCollectiveWorkAccountability(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'request-member',
    roadmapId: project.roadmapId,
    workId: created.work.workId,
    expectedRevision: created.work.revision,
    targetHumanId: member.human.humanId,
  });
  expect(requested).toMatchObject({ status: 'unassigned', revision: 2 });
  expect(requested.accountableHumanId).toBeUndefined();
  const request = requested.accountabilityRequests[0];
  expect(request).toMatchObject({ status: 'pending', targetHumanId: member.human.humanId });

  await expect(
    current.authoring.requestCollectiveWorkAccountability(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'request-member-again',
      roadmapId: project.roadmapId,
      workId: created.work.workId,
      expectedRevision: requested.revision,
      targetHumanId: member.human.humanId,
    }),
  ).rejects.toMatchObject({ code: 'ACCOUNTABILITY_REQUEST_PENDING' });

  const declined = await current.authoring.respondCollectiveWorkAccountability(member.sessionToken, {
    ...current.coordinates,
    requestId: 'member-declines-responsibility',
    workId: requested.workId,
    expectedRevision: requested.revision,
    accountabilityRequestId: request?.accountabilityRequestId,
    decision: 'decline',
  });
  expect(declined).toMatchObject({ status: 'unassigned', revision: 3 });
  expect(declined.accountableHumanId).toBeUndefined();
  expect(declined.accountabilityRequests[0]).toMatchObject({ status: 'declined' });
  expect(declined.history.at(-1)).toMatchObject({ action: 'accountability_request_declined' });
  const requestedAgain = await current.authoring.requestCollectiveWorkAccountability(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'request-member-after-decline',
    roadmapId: project.roadmapId,
    workId: declined.workId,
    expectedRevision: declined.revision,
    targetHumanId: member.human.humanId,
  });
  expect(requestedAgain.accountabilityRequests).toHaveLength(2);
  expect(requestedAgain.accountabilityRequests[1]).toMatchObject({ status: 'pending' });
  expect(requestedAgain.accountabilityRequests[1]?.accountabilityRequestId).not.toBe(request?.accountabilityRequestId);
});
