// @vitest-environment jsdom

import { act, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from '../client-types.js';
import { ProjectBoardCard } from '../ProjectBoardCard.js';
import { ProjectContextPanel } from '../ProjectContextPanel.js';
import { ProjectList } from '../ProjectList.js';
import { ProjectPlanTable } from '../ProjectPlanTable.js';
import { RoadmapProjection } from '../RoadmapProjection.js';
import { roadmap as baseRoadmap, work as baseWork, participant } from './collaboration-cards.fixture.js';

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

function makeWork(
  suffix: string,
  title: string,
  overrides: Partial<CollectiveWorkProjection> = {},
): CollectiveWorkProjection {
  const workId = `work_${suffix.padEnd(8, 'x')}`;
  return {
    ...baseWork,
    workId,
    sourceEventId: `evt_${suffix.padEnd(8, 'x')}`,
    sourceLocation: { channelId: '产品方向' },
    title,
    intendedOutcome: `${title}，并保留可回查来源。`,
    accountableHumanId: participant.humanId,
    lifecycle: 'committed',
    status: 'ready',
    revision: 2,
    history: [
      ...baseWork.history,
      { revision: 2, action: 'committed', actor: baseWork.proposedBy, at: baseWork.createdAt },
    ],
    ...overrides,
  };
}

function makeRoadmap(suffix: string, title: string, workIds: readonly string[]): CollectiveRoadmapRecord {
  return {
    ...baseRoadmap,
    roadmapId: `roadmap_${suffix.padEnd(8, 'x')}`,
    title,
    purpose: `让 ${title} 的任务保留同一份真实状态。`,
    workIds: [...workIds],
  };
}

function assignedBlockedWork(
  suffix: string,
  title: string,
  admission: 'admitted' | 'rejected' | 'pending',
  overrides: Partial<CollectiveWorkProjection> = {},
): CollectiveWorkProjection {
  const current = makeWork(suffix, title, {
    lifecycle: 'in_progress',
    status: 'blocked',
    ...overrides,
  });
  const notice = {
    v: 1 as const,
    workId: current.workId,
    sourceEventId: current.sourceEventId,
    operationRef: `accept-${suffix}`,
    grantRef: `grant-${suffix}`,
    grantRevision: 1,
    requestKind: 'guide',
  };
  const admitted = {
    state: 'admitted' as const,
    issuer: 'host' as const,
    receiptRef: `host-admission-initial-${suffix}`,
    at: current.createdAt,
  };
  return {
    ...current,
    assignmentEventId: `evt_assignment_${suffix}`,
    assignment: {
      humanId: participant.humanId,
      connectionId: participant.connectionId,
      catId: participant.catId,
      displayName: participant.displayName,
      participationRevision: 1,
      assignedAt: current.createdAt,
    },
    acceptance: { ...notice, hostAdmission: admitted },
    executionAuthority: {
      ...notice,
      revision: 2,
      assignmentEventId: `evt_assignment_${suffix}`,
      eventId: `evt_execution_${suffix}`,
      participationRevision: 1,
      resultRevision: 1,
      ...(admission === 'pending'
        ? {}
        : {
            hostAdmission: {
              ...admitted,
              state: admission,
              receiptRef: `host-admission-current-${suffix}`,
              ...(admission === 'rejected' ? { reason: 'WORK_DELEGATION_UNAVAILABLE' } : {}),
            },
          }),
    },
  };
}

it.each([
  {
    label: 'revoked execution authority',
    expected: '当前委托已经不可用',
    build: () =>
      assignedBlockedWork('revoked-cause', '撤权后不能执行', 'admitted', {
        executionStatus: {
          issuer: 'service',
          revision: 2,
          state: 'unavailable',
          reason: 'WORK_DELEGATION_UNAVAILABLE',
        },
      }),
  },
  {
    label: 'Host admission still pending',
    expected: '已接下，待家内准入',
    build: () => assignedBlockedWork('pending-cause', '等待家内准入', 'pending'),
  },
  {
    label: 'Host admission rejected',
    expected: '当前委托已经不可用',
    build: () => assignedBlockedWork('rejected-cause', '家内准入被拒', 'rejected'),
  },
])('keeps $label as the current cause when every prerequisite is complete', async ({ expected, build }) => {
  const completed = makeWork('cause-done', '已经完成的前置', {
    lifecycle: 'completed',
    status: 'completed',
  });
  const blocked = { ...build(), dependencyWorkIds: [completed.workId] };
  const project = makeRoadmap('cause', '执行原因项目', [blocked.workId]);

  await renderBlockingSurfaces(project, blocked, [blocked, completed]);

  const list = container.querySelector(`[data-project-id="${project.roadmapId}"] .project-list-next`);
  const context = container.querySelector('[aria-label="项目上下文与动态"]');
  const plan = container.querySelector(`[data-project-plan-work-id="${blocked.workId}"] .project-plan-dependencies`);
  const graph = container.querySelector(`[aria-label="任务依赖图"] [data-roadmap-work-id="${blocked.workId}"]`);
  for (const surface of [list, context, plan, graph]) {
    expect(surface?.textContent).toContain(expected);
    expect(surface?.textContent).not.toContain('阻塞原因未填写');
  }
  expect(plan?.textContent).not.toContain('等待前置任务');
  expect(plan?.textContent).toContain(`已完成前置：${completed.title}`);
  expect(graph?.textContent).not.toContain(`等待 ${completed.title}`);
});

it('does not mistake completed dependency history for the current blocking cause', async () => {
  const completed = makeWork('history-done', '已经完成的历史前置', {
    lifecycle: 'completed',
    status: 'completed',
  });
  const blocked = makeWork('unknown-cause', '原因尚未写明的阻塞', {
    status: 'blocked',
    dependencyWorkIds: [completed.workId],
  });
  const project = makeRoadmap('unknown', '未知原因项目', [blocked.workId]);

  await renderBlockingSurfaces(project, blocked, [blocked, completed]);

  const plan = container.querySelector(`[data-project-plan-work-id="${blocked.workId}"] .project-plan-dependencies`);
  const graph = container.querySelector(`[aria-label="任务依赖图"] [data-roadmap-work-id="${blocked.workId}"]`);
  expect(container.querySelector('.project-list-next')?.textContent).toContain('阻塞原因未填写');
  expect(container.querySelector('[aria-label="项目上下文与动态"]')?.textContent).toContain('阻塞原因未填写');
  expect(plan?.textContent).toContain('阻塞原因未填写');
  expect(plan?.textContent).not.toContain('等待前置任务');
  expect(plan?.textContent).toContain(`已完成前置：${completed.title}`);
  expect(graph?.textContent).toContain('阻塞原因未填写');
  expect(graph?.textContent).not.toContain(`等待 ${completed.title}`);
});

it('uses only unfinished prerequisites as the current dependency cause', async () => {
  const dependency = makeWork('current-dep', '仍未完成的前置');
  const blocked = makeWork('dependency-cause', '真实等待前置的任务', {
    status: 'blocked',
    dependencyWorkIds: [dependency.workId],
  });
  const project = makeRoadmap('dependency', '真实依赖项目', [blocked.workId]);

  await renderBlockingSurfaces(project, blocked, [blocked, dependency]);

  expect(container.querySelector('.project-list-next')?.textContent).toContain(`等待 ${dependency.title}`);
  expect(container.querySelector('[aria-label="项目上下文与动态"]')?.textContent).toContain(
    `${blocked.title}等待${dependency.title}`,
  );
  const plan = container.querySelector(`[data-project-plan-work-id="${blocked.workId}"] .project-plan-dependencies`);
  const graph = container.querySelector(`[aria-label="任务依赖图"] [data-roadmap-work-id="${blocked.workId}"]`);
  expect(plan?.textContent).toContain('等待前置任务');
  expect(plan?.textContent).toContain(dependency.title);
  expect(plan?.textContent).not.toContain('阻塞原因未填写');
  expect(graph?.textContent).toContain(`等待 ${dependency.title}`);
});

it('retires the current-blocker claim when the prerequisite completes and the dependent Work becomes ready', async () => {
  const prerequisite = makeWork('transition-upstream', '完成后不再阻塞');
  const dependent = makeWork('transition-downstream', '完成前仍被阻塞', {
    status: 'blocked',
    dependencyWorkIds: [prerequisite.workId],
  });
  const project = makeRoadmap('transition', '依赖转换项目', [prerequisite.workId, dependent.workId]);

  await renderBoardCard(prerequisite, dependent, project);
  expect(container.textContent).toContain(`正挡住 ${dependent.title}`);

  const completed = { ...prerequisite, lifecycle: 'completed' as const, status: 'completed' as const };
  const ready = { ...dependent, status: 'ready' as const };
  await renderBoardCard(completed, ready, project);
  expect(container.textContent).not.toContain('正挡住');
});

async function renderBlockingSurfaces(
  roadmap: CollectiveRoadmapRecord,
  work: CollectiveWorkProjection,
  availableWorks: readonly CollectiveWorkProjection[],
) {
  await act(async () =>
    root.render(
      <Fragment>
        <ProjectList
          roadmaps={[roadmap]}
          works={availableWorks}
          currentHumanId={participant.humanId}
          humans={[]}
          participants={[participant]}
          humanNames={{ [participant.humanId]: 'You' }}
          onOpen={vi.fn()}
        />
        <ProjectContextPanel
          roadmap={roadmap}
          works={[work]}
          availableWorks={availableWorks}
          view={{ lens: 'stage', presentation: 'graph', scope: 'all' }}
        />
        <ProjectPlanTable
          roadmap={roadmap}
          works={[work]}
          availableWorks={availableWorks}
          currentHumanId={participant.humanId}
          humans={[]}
          participants={[participant]}
          humanNames={{ [participant.humanId]: 'You' }}
          onSelect={vi.fn()}
        />
        <RoadmapProjection
          works={[work]}
          allWorks={availableWorks}
          view={{ lens: 'dependencies', presentation: 'graph', scope: 'all' }}
          currentHumanId={participant.humanId}
          humanNames={{ [participant.humanId]: 'You' }}
          onSelect={vi.fn()}
        />
      </Fragment>,
    ),
  );
}

async function renderBoardCard(
  prerequisite: CollectiveWorkProjection,
  dependent: CollectiveWorkProjection,
  roadmap: CollectiveRoadmapRecord,
) {
  await act(async () =>
    root.render(
      <ProjectBoardCard
        work={prerequisite}
        availableWorks={[prerequisite, dependent]}
        projectWorks={[prerequisite, dependent]}
        projects={[roadmap]}
        currentHumanId={participant.humanId}
        humans={[]}
        participants={[participant]}
        humanNames={{ [participant.humanId]: 'You' }}
        onSelect={vi.fn()}
      />,
    ),
  );
}
