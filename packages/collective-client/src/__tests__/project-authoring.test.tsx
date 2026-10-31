// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  CollectiveMemberDirectory,
  CollectiveParticipant,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from '../client-types.js';
import { participantKey } from '../participant-identity.js';
import { RoadmapWorkspace } from '../RoadmapWorkspace.js';

const operator = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: 'You' };
const wulang = { kind: 'human' as const, humanId: 'human_bbbbbbbb', displayName: '吴浪' };
const at = '2026-10-18T00:00:00.000Z';
const members: CollectiveMemberDirectory['humans'] = [
  { ...operator, role: 'steward' },
  { ...wulang, role: 'member' },
];
const participant: CollectiveParticipant = {
  serviceInstanceId: 'svc_aaaaaaaa',
  collectiveId: 'col_aaaaaaaa',
  connectionId: 'con_bbbbbbbb',
  endpointId: 'ep_bbbbbbbb',
  endpointLabel: '吴浪的 Café',
  humanId: wulang.humanId,
  humanDisplayName: wulang.displayName,
  catId: 'codex-astra',
  displayName: '小星星 · 砚砚',
  participationRevision: 2,
  channelIds: ['general'],
  availability: 'declared',
};

function roadmap(workIds: readonly string[] = []): CollectiveRoadmapRecord {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    roadmapId: 'roadmap_aaaaaaaa',
    sourceEventId: 'evt_project0000',
    sourceLocation: { channelId: 'general' },
    title: '共同体 v1.2',
    purpose: '成员可以从同一个项目看见并推进真实任务。',
    accountableHumanId: operator.humanId,
    workIds: [...workIds],
    status: 'active',
    revision: 3,
    createdAt: at,
    updatedAt: at,
    history: [{ revision: 1, action: 'created', actor: operator, at }],
  };
}

function unassignedWork(
  accountabilityRequests: NonNullable<CollectiveWorkProjection['accountabilityRequests']> = [],
): CollectiveWorkProjection {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_aaaaaaaa',
    sourceEventId: 'evt_task0000000',
    sourceLocation: { channelId: 'general' },
    title: '接通跨成员责任请求',
    intendedOutcome: '被邀请的人明确接受后才成为负责人。',
    proposedBy: operator,
    accountabilityRequests,
    dependencyWorkIds: [],
    lifecycle: 'committed',
    status: 'unassigned',
    revision: 4,
    createdAt: at,
    updatedAt: at,
    history: [],
  };
}

function projectSuggestion(
  project: CollectiveRoadmapRecord,
  target: CollectiveWorkProjection,
): CollectiveWorkProjection {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_suggestaa',
    sourceEventId: 'evt_suggest0000',
    sourceLocation: { channelId: 'general' },
    title: '补一项前置验证',
    intendedOutcome: '前置完成且留下可验收证据。',
    proposedBy: {
      kind: 'agent',
      humanId: operator.humanId,
      humanDisplayName: operator.displayName,
      connectionId: 'con_aaaaaaaa',
      catId: 'codex-sol',
      displayName: '小太阳 · 砚砚',
    },
    projectSuggestion: {
      roadmapId: project.roadmapId,
      roadmapRevision: project.revision,
      prerequisiteForWorkId: target.workId,
      prerequisiteForWorkRevision: target.revision,
      suggestedTitle: '补一项前置验证',
      suggestedIntendedOutcome: '前置完成且留下可验收证据。',
    },
    accountabilityRequests: [],
    dependencyWorkIds: [],
    lifecycle: 'proposed',
    status: 'proposed',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    history: [],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button?.click());
}

async function enter(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  expect(element, `field ${label}`).not.toBeNull();
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function select(label: string, value: string) {
  const element = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`);
  expect(element, `select ${label}`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value);
    element?.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function workspaceProps() {
  return {
    channelId: 'general',
    humans: members,
    participants: [participant],
    humanNames: { [operator.humanId]: operator.displayName, [wulang.humanId]: wulang.displayName },
    onSetDependencies: vi.fn(),
    onSetStatus: vi.fn(),
    bindingVotes: [],
    decisions: [],
    onCreateBindingVote: vi.fn(),
    onCastBindingVote: vi.fn(),
    onWithdrawBindingVote: vi.fn(),
    onSettleBindingVote: vi.fn(),
    onCommitWork: vi.fn(async () => undefined),
    onRequestWorkAccountability: vi.fn(async () => undefined),
    onRespondWorkAccountability: vi.fn(async () => undefined),
  };
}

it('keeps the empty Project page useful and creates a Project with an atomic channel source', async () => {
  const onCreateProject = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        {...workspaceProps()}
        roadmaps={[]}
        works={[]}
        currentHumanId={operator.humanId}
        onCreateProject={onCreateProject}
        onCreateProjectTask={vi.fn()}
      />,
    ),
  );

  expect(container.querySelector('h1')?.textContent).toBe('项目');
  await click('新建项目');
  await enter('项目名称', '共同体 v1.2');
  await enter('项目完成标准', '成员可以从同一个项目看见并推进真实任务。');
  await click('创建项目');

  expect(onCreateProject).toHaveBeenCalledWith('general', '共同体 v1.2', '成员可以从同一个项目看见并推进真实任务。');
});

it('creates a Project Task and records another Human as a pending request, not an accepted owner', async () => {
  const project = roadmap();
  const onCreateProjectTask = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        {...workspaceProps()}
        roadmaps={[project]}
        works={[]}
        currentHumanId={operator.humanId}
        onCreateProject={vi.fn()}
        onCreateProjectTask={onCreateProjectTask}
      />,
    ),
  );

  await click(project.title);
  await click('新建任务');
  await enter('任务名称', '接通跨成员责任请求');
  await enter('任务完成标准', '被邀请的人明确接受后才成为负责人。');
  await select('任务负责人', wulang.humanId);
  await click('创建任务');

  expect(onCreateProjectTask).toHaveBeenCalledWith(
    project,
    'general',
    '接通跨成员责任请求',
    '被邀请的人明确接受后才成为负责人。',
    { accountability: 'unassigned', requestedAccountableHumanId: wulang.humanId },
  );
});

it('lets the Project owner request responsibility while only the named Human can accept or decline it', async () => {
  const original = unassignedWork();
  const project = roadmap([original.workId]);
  const ownerProps = workspaceProps();
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        {...ownerProps}
        roadmaps={[project]}
        works={[original]}
        currentHumanId={operator.humanId}
        onCreateProject={vi.fn()}
        onCreateProjectTask={vi.fn()}
      />,
    ),
  );
  await click(project.title);
  await click(original.title);
  await select('邀请负责人', wulang.humanId);
  await click('发送邀请');
  expect(ownerProps.onRequestWorkAccountability).toHaveBeenCalledWith(project, original, wulang.humanId);

  const request = {
    accountabilityRequestId: 'accountability_aaaaaaaa',
    roadmapId: project.roadmapId,
    targetHumanId: wulang.humanId,
    targetDisplayName: wulang.displayName,
    requestedByHumanId: operator.humanId,
    requestedByDisplayName: operator.displayName,
    requestEventId: 'evt_request0000',
    requestedAt: at,
    status: 'pending' as const,
  };
  const requested = unassignedWork([request]);
  const targetProps = workspaceProps();
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        {...targetProps}
        roadmaps={[project]}
        works={[requested]}
        currentHumanId={wulang.humanId}
        onCreateProject={vi.fn()}
        onCreateProjectTask={vi.fn()}
      />,
    ),
  );
  await click(requested.title);
  expect(container.textContent).toContain('You 邀请你负责');
  await select('接下任务后', participantKey(participant));
  await click('接受负责');
  await click('暂不接受');

  expect(targetProps.onRespondWorkAccountability).toHaveBeenNthCalledWith(1, requested, request, 'accept', participant);
  expect(targetProps.onRespondWorkAccountability).toHaveBeenNthCalledWith(2, requested, request, 'decline');
});

it('projects the same responsibility and result truth into the Project to-do without granting another Human actions', async () => {
  const request = {
    accountabilityRequestId: 'accountability_aaaaaaaa',
    roadmapId: 'roadmap_aaaaaaaa',
    targetHumanId: wulang.humanId,
    targetDisplayName: wulang.displayName,
    requestedByHumanId: operator.humanId,
    requestedByDisplayName: operator.displayName,
    requestEventId: 'evt_request0000',
    requestedAt: at,
    status: 'pending' as const,
  };
  const invited = {
    ...unassignedWork([request]),
    workId: 'work_invitedaa',
    title: '确认跨成员责任邀请',
  };
  const waitingForOwner = {
    ...unassignedWork(),
    workId: 'work_unassigned',
    title: '指定任务负责人',
  };
  const waitingForAcceptance: CollectiveWorkProjection = {
    ...unassignedWork(),
    workId: 'work_resultaaa',
    title: '验收猫交回的结果',
    accountableHumanId: operator.humanId,
    lifecycle: 'result_ready',
    status: 'result_ready',
    revision: 5,
    resultEventId: 'evt_result0000',
    resultRevision: 1,
    history: [
      {
        revision: 5,
        action: 'result_returned',
        actor: operator,
        at,
        eventId: 'evt_result0000',
        resultRevision: 1,
      },
    ],
  };
  const project = roadmap([invited.workId, waitingForOwner.workId, waitingForAcceptance.workId]);
  const onViewChange = vi.fn();
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        {...workspaceProps()}
        roadmaps={[project]}
        works={[invited, waitingForOwner, waitingForAcceptance]}
        currentHumanId={wulang.humanId}
        onViewChange={onViewChange}
        onCreateProject={vi.fn()}
        onCreateProjectTask={vi.fn()}
      />,
    ),
  );

  const panel = container.querySelector('[aria-label="项目待办"]');
  expect(panel?.textContent).toContain(invited.title);
  expect(panel?.textContent).not.toContain(waitingForOwner.title);
  expect(panel?.textContent).not.toContain(waitingForAcceptance.title);

  await select('待办成员', operator.humanId);
  expect(panel?.textContent).not.toContain(invited.title);
  expect(panel?.textContent).toContain(waitingForOwner.title);
  expect(panel?.textContent).toContain(waitingForAcceptance.title);
  expect(panel?.textContent).toContain('查看任务');

  await select('待办成员', wulang.humanId);
  await click('处理邀请');
  expect(onViewChange).toHaveBeenCalledWith(
    expect.objectContaining({ workspace: 'project', roadmapId: project.roadmapId, workId: invited.workId }),
  );
});

it('lets the Project owner edit and accept a Cat suggestion without treating it as assigned work', async () => {
  const target = { ...unassignedWork(), accountableHumanId: operator.humanId, status: 'ready' as const };
  const project = roadmap([target.workId]);
  const suggestion = projectSuggestion(project, target);
  const props = workspaceProps();
  const onDecideProjectSuggestion = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        {...props}
        roadmaps={[project]}
        works={[target, suggestion]}
        currentHumanId={operator.humanId}
        onCreateProject={vi.fn()}
        onCreateProjectTask={vi.fn()}
        onDecideProjectSuggestion={onDecideProjectSuggestion}
      />,
    ),
  );

  await click(project.title);
  const surface = container.querySelector('[aria-label="项目建议"]');
  expect(surface?.textContent).toContain('小太阳 · 砚砚');
  expect(surface?.textContent).toContain(`建议作为“${target.title}”的前置任务`);
  await enter(`建议任务名称 · ${suggestion.title}`, '前置验证（Human 确认）');
  await enter(`建议任务完成标准 · ${suggestion.title}`, '验证完成、证据可打开，并保留猫建议来源。');
  await click('纳入项目');

  expect(onDecideProjectSuggestion).toHaveBeenCalledWith(project, suggestion, 'accept', {
    title: '前置验证（Human 确认）',
    intendedOutcome: '验证完成、证据可打开，并保留猫建议来源。',
  });
  expect(suggestion.accountableHumanId).toBeUndefined();
  expect(suggestion.assignment).toBeUndefined();
});
