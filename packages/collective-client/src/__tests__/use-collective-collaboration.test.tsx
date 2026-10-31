// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import type { ClientSnapshot, CollectiveWorkProjection } from '../client-types.js';
import { collectiveClientNamespace } from '../human-send-custody.js';
import { useCollectiveCollaboration } from '../use-collective-collaboration.js';

function readySnapshot(collectiveId: string): ClientSnapshot {
  return {
    phase: 'ready',
    meta: {
      serviceInstanceId: 'svc_aaaaaaaa',
      bootstrapNeeded: false,
      onboardingComplete: true,
      clientBuildId: 'test',
    },
    me: {
      human: { humanId: 'human_aaaaaaaa', displayName: 'You', createdAt: '2026-09-11T00:00:00.000Z' },
      auth: { provider: 'github', handle: 'operator' },
      collectives: [],
    },
    collective: {
      collectiveId,
      name: collectiveId,
      createdByHumanId: 'human_aaaaaaaa',
      createdAt: '2026-09-11T00:00:00.000Z',
      role: 'steward',
    },
    providers: [],
    events: [],
    connection: 'online',
    delivery: { kind: 'idle' },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('does not project an old Collective command result into the newly selected world', async () => {
  const first = readySnapshot('col_aaaaaaaa');
  const second = readySnapshot('col_bbbbbbbb');
  const currentNamespace = { current: collectiveClientNamespace(first) };
  const setSnapshot = vi.fn();
  const refresh = vi.fn(async () => undefined);
  let resolveRequest: (() => void) | undefined;
  const request: ClientRequest = <Result,>() =>
    new Promise<Result>((resolve) => {
      resolveRequest = () => resolve(undefined as Result);
    });
  let controller: ReturnType<typeof useCollectiveCollaboration> | undefined;
  function Harness({ snapshot }: { readonly snapshot: ClientSnapshot }) {
    controller = useCollectiveCollaboration({ snapshot, setSnapshot, currentNamespace, request, refresh });
    return null;
  }

  await act(async () => root.render(<Harness snapshot={first} />));
  let command: Promise<void> | undefined;
  await act(async () => {
    command = controller?.proposeWork('evt_aaaaaaaa');
  });
  expect(setSnapshot).toHaveBeenCalledTimes(1);

  currentNamespace.current = collectiveClientNamespace(second);
  await act(async () => root.render(<Harness snapshot={second} />));
  await act(async () => {
    resolveRequest?.();
    await command;
  });

  expect(refresh).not.toHaveBeenCalled();
  expect(setSnapshot).toHaveBeenCalledTimes(1);
});

it('sends an explicit reaction state through the canonical collaboration command path', async () => {
  const snapshot = readySnapshot('col_aaaaaaaa');
  const currentNamespace = { current: collectiveClientNamespace(snapshot) };
  const setSnapshot = vi.fn();
  const refresh = vi.fn(async () => undefined);
  const requestSpy = vi.fn();
  const request: ClientRequest = async <Result,>(path: string, init?: RequestInit) => {
    requestSpy(path, init);
    return undefined as Result;
  };
  let controller: ReturnType<typeof useCollectiveCollaboration> | undefined;
  function Harness() {
    controller = useCollectiveCollaboration({ snapshot, setSnapshot, currentNamespace, request, refresh });
    return null;
  }

  await act(async () => root.render(<Harness />));
  await act(async () => controller?.setReaction('evt_aaaaaaaa', '🐾', false));

  expect(requestSpy).toHaveBeenCalledOnce();
  const [path, init] = requestSpy.mock.calls[0] ?? [];
  expect(path).toBe('/api/collaboration/reactions/set');
  expect(JSON.parse(String(init?.body))).toMatchObject({
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    eventId: 'evt_aaaaaaaa',
    emoji: '🐾',
    active: false,
  });
  expect(refresh).toHaveBeenCalledOnce();
});

it('sends an explicit unassigned acceptance without inventing a Human or Cat assignee', async () => {
  const snapshot = readySnapshot('col_aaaaaaaa');
  const currentNamespace = { current: collectiveClientNamespace(snapshot) };
  const requestSpy = vi.fn();
  const request: ClientRequest = async <Result,>(path: string, init?: RequestInit) => {
    requestSpy(path, init);
    return undefined as Result;
  };
  let controller: ReturnType<typeof useCollectiveCollaboration> | undefined;
  function Harness() {
    controller = useCollectiveCollaboration({
      snapshot,
      setSnapshot: vi.fn(),
      currentNamespace,
      request,
      refresh: vi.fn(async () => undefined),
    });
    return null;
  }
  const actor = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: 'You' };
  const proposed: CollectiveWorkProjection = {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_aaaaaaaa',
    sourceEventId: 'evt_source00000',
    sourceLocation: { channelId: 'general' },
    title: '精简共同体公开接口',
    intendedOutcome: '先纳入项目，再由负责人决定谁来执行。',
    proposedBy: actor,
    dependencyWorkIds: [],
    lifecycle: 'proposed',
    status: 'proposed',
    revision: 1,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    history: [],
  };

  await act(async () => root.render(<Harness />));
  await act(async () => controller?.commitWork(proposed, undefined, 'unassigned'));

  const [path, init] = requestSpy.mock.calls[0] ?? [];
  expect(path).toBe('/api/collaboration/work/commit');
  expect(JSON.parse(String(init?.body))).toMatchObject({
    workId: proposed.workId,
    expectedRevision: proposed.revision,
    accountability: 'unassigned',
  });
  expect(JSON.parse(String(init?.body))).not.toHaveProperty('assignment');
});

it('binds revision feedback and acceptance to the exact current result version', async () => {
  const snapshot = readySnapshot('col_aaaaaaaa');
  const currentNamespace = { current: collectiveClientNamespace(snapshot) };
  const requestSpy = vi.fn();
  const request: ClientRequest = async <Result,>(path: string, init?: RequestInit) => {
    requestSpy(path, init);
    return undefined as Result;
  };
  let controller: ReturnType<typeof useCollectiveCollaboration> | undefined;
  function Harness() {
    controller = useCollectiveCollaboration({
      snapshot,
      setSnapshot: vi.fn(),
      currentNamespace,
      request,
      refresh: vi.fn(async () => undefined),
    });
    return null;
  }
  const actor = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: 'You' };
  const work: CollectiveWorkProjection = {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_aaaaaaaa',
    sourceEventId: 'evt_source00000',
    sourceLocation: { channelId: 'general' },
    title: '修订结果',
    intendedOutcome: '沿同一 Work 返回新版',
    proposedBy: actor,
    accountableHumanId: actor.humanId,
    dependencyWorkIds: [],
    lifecycle: 'result_ready',
    status: 'result_ready',
    resultEventId: 'evt_result000000',
    resultRevision: 2,
    revision: 5,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:01:00.000Z',
    history: [],
  };

  await act(async () => root.render(<Harness />));
  await act(async () => controller?.requestWorkRevision(work, '请补充恢复证据。'));
  await act(async () => controller?.acceptWorkResult(work));

  expect(requestSpy).toHaveBeenCalledTimes(2);
  expect(requestSpy.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body))])).toEqual([
    [
      '/api/collaboration/work/result/revision',
      expect.objectContaining({
        workId: work.workId,
        expectedRevision: 5,
        resultEventId: work.resultEventId,
        resultRevision: 2,
        feedback: '请补充恢复证据。',
      }),
    ],
    [
      '/api/collaboration/work/result/accept',
      expect.objectContaining({
        workId: work.workId,
        expectedRevision: 5,
        resultEventId: work.resultEventId,
        resultRevision: 2,
      }),
    ],
  ]);
});

it('sends Project-page authoring and named-Human responsibility through their atomic command paths', async () => {
  let snapshot = readySnapshot('col_aaaaaaaa');
  const currentNamespace = { current: collectiveClientNamespace(snapshot) };
  const requestSpy = vi.fn();
  let accountabilityResponse: unknown;
  const request: ClientRequest = async <Result,>(path: string, init?: RequestInit) => {
    requestSpy(path, init);
    if (path === '/api/collaboration/work/accountability/respond') return accountabilityResponse as Result;
    return undefined as Result;
  };
  let controller: ReturnType<typeof useCollectiveCollaboration> | undefined;
  function Harness() {
    controller = useCollectiveCollaboration({
      snapshot,
      setSnapshot: vi.fn(),
      currentNamespace,
      request,
      refresh: vi.fn(async () => undefined),
    });
    return null;
  }
  const actor = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: 'You' };
  const roadmap = {
    v: 1 as const,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    roadmapId: 'roadmap_aaaaaaaa',
    sourceEventId: 'evt_project0000',
    sourceLocation: { channelId: 'general' },
    title: '共同体 v1.2',
    purpose: '成员可以从同一个项目看见并推进真实任务。',
    accountableHumanId: actor.humanId,
    workIds: ['work_aaaaaaaa'],
    status: 'active' as const,
    revision: 3,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:01:00.000Z',
    history: [{ revision: 1, action: 'created' as const, actor, at: '2026-10-18T00:00:00.000Z' }],
  };
  const accountabilityRequest = {
    accountabilityRequestId: 'accountability_aaaaaaaa',
    roadmapId: roadmap.roadmapId,
    targetHumanId: 'human_bbbbbbbb',
    targetDisplayName: '吴浪',
    requestedByHumanId: actor.humanId,
    requestedByDisplayName: actor.displayName,
    requestEventId: 'evt_request0000',
    requestedAt: '2026-10-18T00:02:00.000Z',
    status: 'pending' as const,
  };
  const work: CollectiveWorkProjection = {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_aaaaaaaa',
    sourceEventId: 'evt_task0000000',
    sourceLocation: { channelId: 'general' },
    title: '接通跨成员责任请求',
    intendedOutcome: '被邀请的人明确接受后才成为负责人。',
    proposedBy: actor,
    accountabilityRequests: [accountabilityRequest],
    dependencyWorkIds: [],
    lifecycle: 'committed',
    status: 'unassigned',
    revision: 4,
    createdAt: '2026-10-18T00:01:00.000Z',
    updatedAt: '2026-10-18T00:02:00.000Z',
    history: [],
  };
  const participant = {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_bbbbbbbb',
    endpointId: 'ep_bbbbbbbb',
    endpointLabel: '吴浪的 Café',
    humanId: 'human_bbbbbbbb',
    humanDisplayName: '吴浪',
    catId: 'codex-astra',
    displayName: '小星星 · 砚砚',
    participationRevision: 2,
    channelIds: ['general'],
    availability: 'declared' as const,
  };
  accountabilityResponse = {
    ...work,
    accountableHumanId: accountabilityRequest.targetHumanId,
    accountabilityRequests: [
      {
        ...accountabilityRequest,
        status: 'accepted',
        responseEventId: 'evt_response000',
        respondedAt: '2026-10-18T00:04:00.000Z',
      },
    ],
    assignment: {
      humanId: accountabilityRequest.targetHumanId,
      connectionId: participant.connectionId,
      catId: participant.catId,
      displayName: participant.displayName,
      participationRevision: participant.participationRevision,
      assignedAt: '2026-10-18T00:04:00.000Z',
    },
    assignmentEventId: 'evt_assignment00',
    revision: work.revision + 1,
    status: 'ready',
    updatedAt: '2026-10-18T00:04:00.000Z',
  };
  const projectSuggestion: CollectiveWorkProjection = {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_suggestaa',
    sourceEventId: 'evt_suggest0000',
    sourceLocation: { channelId: 'general' },
    title: '补一项前置验证',
    intendedOutcome: '前置完成且有可验收结果。',
    proposedBy: {
      kind: 'agent',
      humanId: actor.humanId,
      humanDisplayName: actor.displayName,
      connectionId: 'con_aaaaaaaa',
      catId: 'codex-sol',
      displayName: '小太阳 · 砚砚',
    },
    projectSuggestion: {
      roadmapId: roadmap.roadmapId,
      roadmapRevision: roadmap.revision,
      prerequisiteForWorkId: work.workId,
      prerequisiteForWorkRevision: work.revision,
      suggestedTitle: '补一项前置验证',
      suggestedIntendedOutcome: '前置完成且有可验收结果。',
    },
    dependencyWorkIds: [],
    lifecycle: 'proposed',
    status: 'proposed',
    revision: 1,
    createdAt: '2026-10-18T00:03:00.000Z',
    updatedAt: '2026-10-18T00:03:00.000Z',
    history: [],
  };
  snapshot = {
    ...snapshot,
    collaboration: {
      serviceInstanceId: 'svc_aaaaaaaa',
      collectiveId: 'col_aaaaaaaa',
      works: [work, projectSuggestion],
      roadmaps: [roadmap],
      votes: [],
      bindingVotes: [],
      decisions: [],
    },
  };
  const accountabilityChanged = vi.fn();
  window.addEventListener('collective:accountability-changed', accountabilityChanged);

  await act(async () => root.render(<Harness />));
  await act(async () => controller?.createProject('general', '共同体 v1.2', '成员可以推进真实任务。'));
  await act(async () =>
    controller?.createProjectTask(roadmap, 'general', '接通跨成员责任请求', '被邀请的人明确接受后才成为负责人。', {
      accountability: 'unassigned',
      requestedAccountableHumanId: 'human_bbbbbbbb',
    }),
  );
  await act(async () => controller?.requestWorkAccountability(roadmap, work, 'human_bbbbbbbb'));
  await act(async () => controller?.respondWorkAccountability(work, accountabilityRequest, 'accept', participant));
  await act(async () =>
    controller?.decideProjectWorkSuggestion(roadmap, projectSuggestion, 'accept', {
      title: '前置验证（Human 确认）',
      intendedOutcome: '证据可打开，并保留猫建议来源。',
    }),
  );

  expect(requestSpy.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body))])).toEqual([
    [
      '/api/collaboration/projects/create',
      expect.objectContaining({ channelId: 'general', title: '共同体 v1.2', purpose: '成员可以推进真实任务。' }),
    ],
    [
      '/api/collaboration/projects/tasks/create',
      expect.objectContaining({
        roadmapId: roadmap.roadmapId,
        expectedRoadmapRevision: roadmap.revision,
        channelId: 'general',
        title: '接通跨成员责任请求',
        intendedOutcome: '被邀请的人明确接受后才成为负责人。',
        accountability: 'unassigned',
        requestedAccountableHumanId: 'human_bbbbbbbb',
      }),
    ],
    [
      '/api/collaboration/work/accountability/request',
      expect.objectContaining({
        roadmapId: roadmap.roadmapId,
        workId: work.workId,
        expectedRevision: work.revision,
        targetHumanId: 'human_bbbbbbbb',
      }),
    ],
    [
      '/api/collaboration/work/accountability/respond',
      expect.objectContaining({
        workId: work.workId,
        expectedRevision: work.revision,
        accountabilityRequestId: accountabilityRequest.accountabilityRequestId,
        decision: 'accept',
        assignment: {
          connectionId: participant.connectionId,
          catId: participant.catId,
          participationRevision: participant.participationRevision,
        },
      }),
    ],
    [
      '/api/collaboration/projects/suggestions/decide',
      expect.objectContaining({
        workId: projectSuggestion.workId,
        expectedRevision: projectSuggestion.revision,
        expectedRoadmapRevision: roadmap.revision,
        expectedTargetWorkRevision: work.revision,
        decision: 'accept',
        title: '前置验证（Human 确认）',
        intendedOutcome: '证据可打开，并保留猫建议来源。',
      }),
    ],
  ]);
  expect(accountabilityChanged).toHaveBeenCalledOnce();
  expect((accountabilityChanged.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
    workId: work.workId,
    workRevision: work.revision + 1,
    accountabilityRequestId: accountabilityRequest.accountabilityRequestId,
    status: 'accepted',
  });
  window.removeEventListener('collective:accountability-changed', accountabilityChanged);
});
