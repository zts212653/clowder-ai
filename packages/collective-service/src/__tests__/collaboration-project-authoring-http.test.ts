import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { type RunningCollectiveServer, startCollectiveServer } from '../http-server.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];
const servers: RunningCollectiveServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function inviteMember(current: Awaited<ReturnType<typeof participationFixture>>) {
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
    code: 'project-http-member',
  });
  return current.store.exchangeHumanAuthCompletion(completion.completionToken);
}

async function post(url: string, path: string, body: Record<string, unknown>, bearer: string) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  expect(response.status, JSON.stringify(payload)).toBeLessThan(300);
  return payload;
}

it('serves the Project-page authoring and named-Human acceptance contract over HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-project-authoring-http-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  const member = await inviteMember(current);
  const server = await startCollectiveServer({ store: current.store, host: '127.0.0.1', port: 0 });
  servers.push(server);
  const project = await post(
    server.url,
    '/api/collaboration/projects/create',
    {
      ...current.coordinates,
      requestId: 'http-project-create',
      channelId: 'general',
      title: 'HTTP 项目',
      purpose: '浏览器只走公开路由也能留下真实来源。',
    },
    current.owner.sessionToken,
  );
  const created = await post(
    server.url,
    '/api/collaboration/projects/tasks/create',
    {
      ...current.coordinates,
      requestId: 'http-task-create',
      roadmapId: project.roadmapId,
      expectedRoadmapRevision: project.revision,
      channelId: 'general',
      title: 'HTTP 任务',
      intendedOutcome: '受邀成员本人接受前保持未分配。',
      accountability: 'unassigned',
      requestedAccountableHumanId: member.human.humanId,
    },
    current.owner.sessionToken,
  );
  const work = created.work as Record<string, unknown>;
  const requests = work.accountabilityRequests as readonly Record<string, unknown>[];
  expect(work).toMatchObject({ status: 'unassigned' });
  expect(requests[0]).toMatchObject({ targetHumanId: member.human.humanId, status: 'pending' });

  const accepted = await post(
    server.url,
    '/api/collaboration/work/accountability/respond',
    {
      ...current.coordinates,
      requestId: 'http-accountability-accept',
      workId: work.workId,
      expectedRevision: work.revision,
      accountabilityRequestId: requests[0]?.accountabilityRequestId,
      decision: 'accept',
    },
    member.sessionToken,
  );
  expect(accepted).toMatchObject({ accountableHumanId: member.human.humanId, status: 'ready' });

  const unassigned = await post(
    server.url,
    '/api/collaboration/projects/tasks/create',
    {
      ...current.coordinates,
      requestId: 'http-task-create-unassigned',
      roadmapId: project.roadmapId,
      expectedRoadmapRevision: (created.roadmap as Record<string, unknown>).revision,
      channelId: 'general',
      title: '稍后指派的任务',
      intendedOutcome: '从任务详情向具名成员发出请求。',
      accountability: 'unassigned',
    },
    current.owner.sessionToken,
  );
  const unassignedWork = unassigned.work as Record<string, unknown>;
  const requested = await post(
    server.url,
    '/api/collaboration/work/accountability/request',
    {
      ...current.coordinates,
      requestId: 'http-accountability-request',
      roadmapId: project.roadmapId,
      workId: unassignedWork.workId,
      expectedRevision: unassignedWork.revision,
      targetHumanId: member.human.humanId,
    },
    current.owner.sessionToken,
  );
  expect(requested).toMatchObject({ status: 'unassigned' });
  expect((requested.accountabilityRequests as readonly Record<string, unknown>[])[0]).toMatchObject({
    targetHumanId: member.human.humanId,
    status: 'pending',
  });
});
