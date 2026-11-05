// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from '../client-types.js';
import { ProjectBoard } from '../ProjectBoard.js';
import { RoadmapWorkDetails } from '../RoadmapWorkDetails.js';
import { RoadmapWorkspace } from '../RoadmapWorkspace.js';
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

it('resolves a non-overlapping cross-project dependency without expanding the selected project', async () => {
  const dependency = makeWork('external', '接通外部基础能力', {
    sourceLocation: { channelId: '基础设施' },
  });
  const current = makeWork('current', '交付当前项目', {
    status: 'blocked',
    dependencyWorkIds: [dependency.workId],
  });
  const primary = makeRoadmap('primary', '当前项目', [current.workId]);
  const foundation = makeRoadmap('foundation', '基础项目', [dependency.workId]);
  const onOpenSource = vi.fn();

  await act(async () =>
    root.render(
      <RoadmapWorkspace
        roadmaps={[primary, foundation]}
        works={[current, dependency]}
        currentHumanId={participant.humanId}
        humanNames={{ [participant.humanId]: 'You' }}
        view={{
          workspace: 'project',
          roadmapId: primary.roadmapId,
          workId: current.workId,
          lens: 'dependencies',
          presentation: 'graph',
          scope: 'all',
        }}
        onOpenSource={onOpenSource}
        onSetDependencies={vi.fn()}
        onSetStatus={vi.fn()}
        bindingVotes={[]}
        decisions={[]}
        onCreateBindingVote={vi.fn()}
        onCastBindingVote={vi.fn()}
        onWithdrawBindingVote={vi.fn()}
        onSettleBindingVote={vi.fn()}
      />,
    ),
  );

  const details = container.querySelector(`[aria-label="任务详情 · ${current.title}"]`);
  expect(details?.textContent).toContain(`${dependency.title}（#基础设施）`);
  expect(details?.textContent).not.toContain('没有前置任务');
  const graph = container.querySelector('[aria-label="任务依赖图"]');
  expect(graph?.querySelector(`[data-roadmap-work-id="${current.workId}"]`)?.textContent).toContain(dependency.title);
  expect(graph?.querySelector(`[data-roadmap-work-id="${dependency.workId}"]`)).toBeNull();
  expect(
    [...(details?.querySelectorAll('.roadmap-dependency-editor button') ?? [])].some((button) =>
      button.textContent?.includes(dependency.title),
    ),
  ).toBe(true);

  const sourceButton = [...(details?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === '查看来源消息',
  );
  await act(async () => sourceButton?.click());
  expect(onOpenSource).toHaveBeenCalledWith(
    current,
    expect.objectContaining({ roadmapId: primary.roadmapId, workId: current.workId, lens: 'dependencies' }),
  );
});

it('reports inaccessible dependency references instead of claiming there are none', async () => {
  const current = makeWork('private', '等待不可读任务', {
    status: 'blocked',
    dependencyWorkIds: ['work_not_readable'],
  });

  await act(async () =>
    root.render(
      <RoadmapWorkDetails
        work={current}
        availableWorks={[current]}
        view={{ lens: 'dependencies', presentation: 'graph', scope: 'all' }}
        currentHumanId={participant.humanId}
        humanNames={{ [participant.humanId]: 'You' }}
        canEditDependencies={false}
        onSetDependencies={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );

  expect(container.textContent).toContain('1 项前置任务当前不可读');
  expect(container.textContent).not.toContain('没有前置任务');
});

it('explains blocked board cards from execution authority before actual dependencies', async () => {
  const dependency = makeWork('dependency', '准备依赖');
  const revoked = assignedBlockedWork('revoked', '撤回后的任务', 'admitted', {
    executionStatus: {
      issuer: 'service',
      revision: 2,
      state: 'unavailable',
      reason: 'PARTICIPATION_REVOKED',
    },
  });
  const pending = assignedBlockedWork('pending', '等待准入的任务', 'pending');
  const rejected = assignedBlockedWork('rejected', '被 Host 拒绝的任务', 'rejected');
  const dependencyBlocked = assignedBlockedWork('dependent', '真实等待依赖的任务', 'admitted', {
    dependencyWorkIds: [dependency.workId],
  });
  const works = [revoked, pending, rejected, dependencyBlocked, dependency];
  const project = makeRoadmap(
    'board',
    '执行真相项目',
    works.map((item) => item.workId),
  );

  await act(async () =>
    root.render(
      <ProjectBoard
        roadmaps={[project]}
        works={works}
        humanNames={{ [participant.humanId]: 'You' }}
        onSelect={vi.fn()}
      />,
    ),
  );

  const banner = (current: CollectiveWorkProjection) =>
    container.querySelector(`[data-roadmap-work-id="${current.workId}"] .project-board-banner-critical`)?.textContent;
  expect(banner(revoked)).toBe('当前无法执行');
  expect(banner(pending)).toBe('已接下，待家内准入');
  expect(banner(rejected)).toBe('暂时不能执行');
  expect(banner(dependencyBlocked)).toBe(`等待 ${dependency.title}`);
});
