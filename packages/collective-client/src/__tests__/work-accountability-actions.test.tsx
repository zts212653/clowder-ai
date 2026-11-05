// @vitest-environment jsdom

import { act, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollectiveParticipant, CollectiveRoadmapRecord, CollectiveWorkProjection } from '../client-types.js';
import { ProjectAttentionPanel } from '../ProjectAttentionPanel.js';
import { ProjectBoardCard } from '../ProjectBoardCard.js';
import { ProjectPlanTable } from '../ProjectPlanTable.js';
import { WorkAccountabilityActions } from '../WorkAccountabilityActions.js';

const owner = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: 'You' };
const target = { kind: 'human' as const, humanId: 'human_bbbbbbbb', displayName: '吴浪' };
const at = '2026-10-18T00:00:00.000Z';
const participants: readonly CollectiveParticipant[] = [
  {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_bbbbbbbb',
    endpointId: 'ep_bbbbbbbb',
    endpointLabel: '吴浪的 Café',
    humanId: target.humanId,
    humanDisplayName: target.displayName,
    catId: 'codex-sol',
    displayName: '缅因猫',
    participationRevision: 2,
    channelIds: ['general'],
    availability: 'declared',
  },
  {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_bbbbbbbb',
    endpointId: 'ep_bbbbbbbb',
    endpointLabel: '吴浪的 Café',
    humanId: target.humanId,
    humanDisplayName: target.displayName,
    catId: 'fable-5',
    displayName: '宪宪',
    participationRevision: 3,
    channelIds: ['general'],
    availability: 'declared',
  },
];

function project(status: CollectiveRoadmapRecord['status'] = 'active'): CollectiveRoadmapRecord {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    roadmapId: 'roadmap_aaaaaaaa',
    sourceEventId: 'evt_project0000',
    sourceLocation: { channelId: 'general' },
    title: '共同体 v1.2',
    purpose: '成员明确承诺后才改变责任。',
    accountableHumanId: owner.humanId,
    workIds: ['work_aaaaaaaa'],
    status,
    revision: 3,
    createdAt: at,
    updatedAt: at,
    history: [{ revision: 1, action: 'created', actor: owner, at }],
  };
}

function requestedWork(state: Partial<CollectiveWorkProjection> = {}): CollectiveWorkProjection {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_aaaaaaaa',
    sourceEventId: 'evt_task0000000',
    sourceLocation: { channelId: 'general' },
    title: '接通跨成员责任请求',
    intendedOutcome: '被邀请的人明确接受后才成为负责人。',
    proposedBy: owner,
    accountabilityRequests: [
      {
        accountabilityRequestId: 'accountability_aaaaaaaa',
        roadmapId: 'roadmap_aaaaaaaa',
        targetHumanId: target.humanId,
        targetDisplayName: target.displayName,
        requestedByHumanId: owner.humanId,
        requestedByDisplayName: owner.displayName,
        requestEventId: 'evt_request0000',
        requestedAt: at,
        status: 'pending',
      },
    ],
    dependencyWorkIds: [],
    lifecycle: 'committed',
    status: 'unassigned',
    revision: 4,
    createdAt: at,
    updatedAt: at,
    history: [],
    ...state,
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

it('keeps two Cats on one Café connection distinct through acceptance', async () => {
  const roadmap = project();
  const work = requestedWork();
  const onRespond = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <WorkAccountabilityActions
        roadmap={roadmap}
        work={work}
        currentHumanId={target.humanId}
        humans={[]}
        participants={participants}
        onRespond={onRespond}
      />,
    ),
  );

  const select = container.querySelector<HTMLSelectElement>('[aria-label="接下任务后"]');
  const second = [...(select?.options ?? [])].find((option) => option.textContent === '交给 宪宪');
  expect(second).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, second?.value);
    select?.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === '接受负责')?.click(),
  );

  expect(onRespond).toHaveBeenCalledWith(work, work.accountabilityRequests?.[0], 'accept', participants[1]);
});

const inoperableCases = [
  { label: 'completed Work', work: { lifecycle: 'completed' as const, status: 'completed' as const } },
  { label: 'declined Work', work: { lifecycle: 'declined' as const, status: 'declined' as const } },
  { label: 'cancelled Work', work: { lifecycle: 'cancelled' as const, status: 'cancelled' as const } },
  {
    label: 'assigned Work',
    work: {
      status: 'ready' as const,
      accountableHumanId: owner.humanId,
      assignment: {
        humanId: owner.humanId,
        connectionId: 'con_aaaaaaaa',
        catId: 'codex-sol',
        displayName: '小太阳 · 砚砚',
        participationRevision: 2,
        assignedAt: at,
      },
    },
  },
] as const;

it.each(inoperableCases)('retires Project attention and Task actions for $label', async ({ work: state }) => {
  await renderResponsibilitySurfaces(project(), requestedWork(state));
  expect(container.querySelector('[aria-label="项目待办"]')?.textContent).not.toContain('接通跨成员责任请求');
  expect(container.querySelector('[aria-label="任务负责人操作"]')).toBeNull();
});

it('retires Project attention and Task actions when the Project is no longer active', async () => {
  await renderResponsibilitySurfaces(project('completed'), requestedWork());
  expect(container.querySelector('[aria-label="项目待办"]')?.textContent).not.toContain('接通跨成员责任请求');
  expect(container.querySelector('[aria-label="任务负责人操作"]')).toBeNull();
});

it.each([
  {
    label: 'the original Project no longer contains the shared Work',
    original: { ...project(), workIds: [] },
  },
  {
    label: 'the original Project is completed',
    original: project('completed'),
  },
])('does not offer responsibility promises when $label', async ({ original }) => {
  const work = requestedWork();
  const current = {
    ...project(),
    roadmapId: 'roadmap_bbbbbbbb',
    sourceEventId: 'evt_project_bbb',
    title: '当前项目 B',
    accountableHumanId: target.humanId,
  } satisfies CollectiveRoadmapRecord;

  await renderCrossProjectResponsibility(original, current, work);

  expect(buttonsNamed('接受负责')).toHaveLength(0);
  expect(buttonsNamed('接受')).toHaveLength(0);
  expect(buttonsNamed('暂不接受')).toHaveLength(0);
});

it('keeps a cross-Project invitation actionable only while its original Project still owns the Work', async () => {
  const work = requestedWork();
  const original = project();
  const current = {
    ...project(),
    roadmapId: 'roadmap_bbbbbbbb',
    sourceEventId: 'evt_project_bbb',
    title: '当前项目 B',
    accountableHumanId: target.humanId,
  } satisfies CollectiveRoadmapRecord;

  await renderCrossProjectResponsibility(original, current, work);

  expect(buttonsNamed('接受负责')).toHaveLength(1);
  expect(buttonsNamed('接受')).toHaveLength(2);
  expect(buttonsNamed('暂不接受')).toHaveLength(3);
});

async function renderResponsibilitySurfaces(roadmap: CollectiveRoadmapRecord, work: CollectiveWorkProjection) {
  await act(async () =>
    root.render(
      <Fragment>
        <ProjectAttentionPanel
          roadmaps={[roadmap]}
          works={[work]}
          humans={[]}
          humanNames={{ [target.humanId]: target.displayName }}
          currentHumanId={target.humanId}
          onOpen={vi.fn()}
        />
        <WorkAccountabilityActions
          roadmap={roadmap}
          work={work}
          currentHumanId={target.humanId}
          humans={[]}
          participants={participants}
          onRespond={vi.fn(async () => undefined)}
        />
      </Fragment>,
    ),
  );
}

async function renderCrossProjectResponsibility(
  original: CollectiveRoadmapRecord,
  current: CollectiveRoadmapRecord,
  work: CollectiveWorkProjection,
) {
  const roadmaps = [original, current];
  await act(async () =>
    root.render(
      <Fragment>
        <WorkAccountabilityActions
          roadmap={current}
          roadmaps={roadmaps}
          work={work}
          currentHumanId={target.humanId}
          humans={[]}
          participants={participants}
          onRespond={vi.fn(async () => undefined)}
        />
        <ProjectPlanTable
          roadmap={current}
          allRoadmaps={roadmaps}
          works={[work]}
          availableWorks={[work]}
          currentHumanId={target.humanId}
          humans={[]}
          participants={participants}
          humanNames={{ [target.humanId]: target.displayName }}
          onSelect={vi.fn()}
          onRespondWorkAccountability={vi.fn(async () => undefined)}
        />
        <ProjectBoardCard
          work={work}
          availableWorks={[work]}
          projectWorks={[work]}
          projects={[current]}
          allRoadmaps={roadmaps}
          currentHumanId={target.humanId}
          humans={[]}
          participants={participants}
          humanNames={{ [target.humanId]: target.displayName }}
          onSelect={vi.fn()}
          onRespondWorkAccountability={vi.fn(async () => undefined)}
        />
      </Fragment>,
    ),
  );
}

function buttonsNamed(label: string) {
  return [...container.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);
}
