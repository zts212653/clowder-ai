// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from '../client-types.js';
import { RoadmapWorkspace } from '../RoadmapWorkspace.js';

const operator = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: 'You' };
const wulang = { kind: 'human' as const, humanId: 'human_bbbbbbbb', displayName: '吴浪' };
const at = '2026-09-19T12:00:00.000Z';

function lifecycleForStatus(status: CollectiveWorkProjection['status']): CollectiveWorkProjection['lifecycle'] {
  if (status === 'blocked') return 'committed';
  if (status === 'ready') return 'committed';
  if (status === 'unassigned') return 'committed';
  return status;
}

function work(
  suffix: string,
  title: string,
  status: CollectiveWorkProjection['status'],
  options: {
    readonly accountableHumanId?: string;
    readonly dependencies?: readonly string[];
    readonly channelId?: string;
    readonly rootEventId?: string;
    readonly assigned?: boolean;
  } = {},
): CollectiveWorkProjection {
  const lifecycle = lifecycleForStatus(status);
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: `work_${suffix.padEnd(8, 'a')}`,
    sourceEventId: `evt_${suffix.padEnd(8, 'a')}`,
    sourceLocation: {
      channelId: options.channelId ? options.channelId : '产品方向',
      ...(options.rootEventId ? { rootEventId: options.rootEventId } : {}),
    },
    title,
    intendedOutcome: `${title}，并把证据带回原讨论。`,
    proposedBy: operator,
    accountableHumanId: options.accountableHumanId ? options.accountableHumanId : operator.humanId,
    ...(options.assigned
      ? {
          assignment: {
            humanId: operator.humanId,
            connectionId: 'con_aaaaaaaa',
            catId: 'codex-astra',
            displayName: '小星星 · 砚砚',
            participationRevision: 1,
            assignedAt: at,
          },
        }
      : {}),
    dependencyWorkIds: options.dependencies ? [...options.dependencies] : [],
    lifecycle,
    status,
    revision: 3,
    createdAt: at,
    updatedAt: '2026-09-19T12:15:00.000Z',
    history: [
      { revision: 1, action: 'proposed', actor: operator, at },
      { revision: 2, action: 'committed', actor: operator, at: '2026-09-19T12:05:00.000Z' },
      {
        revision: 3,
        action: 'dependencies_changed',
        actor: operator,
        at: '2026-09-19T12:15:00.000Z',
        note: '先等正式入口稳定。',
      },
    ],
  };
}

function roadmap(
  roadmapId: string,
  title: string,
  workIds: readonly string[],
  status: CollectiveRoadmapRecord['status'] = 'active',
): CollectiveRoadmapRecord {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    roadmapId,
    sourceEventId: 'evt_routeaa',
    sourceLocation: { channelId: '产品方向' },
    title,
    purpose: `让 ${title} 从讨论长成可回查的项目。`,
    accountableHumanId: operator.humanId,
    workIds: [...workIds],
    status,
    revision: 4,
    createdAt: at,
    updatedAt: '2026-09-19T12:30:00.000Z',
    history: [
      { revision: 1, action: 'created', actor: operator, at },
      { revision: 2, action: 'completed', actor: operator, at: '2026-09-19T12:10:00.000Z' },
      { revision: 3, action: 'reopened', actor: operator, at: '2026-09-19T12:20:00.000Z' },
      { revision: 4, action: 'works_changed', actor: operator, at: '2026-09-19T12:30:00.000Z' },
    ],
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
  expect(button, `button containing ${label}`).toBeDefined();
  await act(async () => button?.click());
}

function controlLabels(label: string): readonly (string | null)[] {
  const group = [...container.querySelectorAll('fieldset.roadmap-control-group')].find(
    (candidate) => candidate.querySelector('legend')?.textContent === label,
  );
  expect(group, `control group ${label}`).toBeDefined();
  if (!group) return [];
  return [...group.querySelectorAll('button')].map((item) => item.textContent);
}

it('keeps the accepted lenses while projection and scope reshape the same canonical Works', async () => {
  const foundation = work('foundation', '接通正式入口', 'completed', { assigned: true });
  const narrative = work('narrative', '补齐团队叙事', 'in_progress', { assigned: true });
  const mobile = work('mobile', '移动端发布', 'blocked', {
    assigned: true,
    dependencies: [foundation.workId],
    channelId: '插件共建',
    rootEventId: 'evt_topicroot',
  });
  const memberWork = work('member', '吴浪的验收', 'ready', { accountableHumanId: wulang.humanId });
  const primary = roadmap('roadmap_primarya', '完整可用版本', [
    foundation.workId,
    narrative.workId,
    mobile.workId,
    memberWork.workId,
  ]);
  const followup = roadmap('roadmap_followupa', '发布后跟进', [memberWork.workId], 'completed');
  const onOpenSource = vi.fn();

  await act(async () =>
    root.render(
      <RoadmapWorkspace
        roadmaps={[primary, followup]}
        works={[foundation, narrative, mobile, memberWork]}
        currentHumanId={operator.humanId}
        humanNames={{ [operator.humanId]: 'You', [wulang.humanId]: '吴浪' }}
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

  await click(primary.title);

  expect([...container.querySelectorAll('[aria-label="项目观察方式"] button')].map((item) => item.textContent)).toEqual(
    ['计划', '看板', '依赖图', '作品'],
  );
  expect(controlLabels('项目筛选')).toEqual(['全部 4', '未完成 3', '与我相关 3']);
  expect([...container.querySelectorAll('button')].some((button) => button.textContent === '完成项目')).toBe(false);

  const plan = container.querySelector('[aria-label="项目任务计划"]');
  expect(plan).not.toBeNull();
  expect(plan?.querySelectorAll('[data-project-plan-work-id]')).toHaveLength(4);
  expect(plan?.textContent).toContain(foundation.title);
  expect(plan?.textContent).toContain(narrative.title);
  expect(plan?.textContent).toContain(mobile.title);
  expect(plan?.textContent).toContain(memberWork.title);

  await click('未完成');
  expect(
    container.querySelector('[aria-label="项目任务计划"]')?.querySelectorAll('[data-project-plan-work-id]'),
  ).toHaveLength(3);

  const projectBoardButton = [
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label="项目观察方式"] button'),
  ].find((button) => button.textContent === '看板');
  expect(projectBoardButton).toBeDefined();
  await act(async () => projectBoardButton?.click());
  const focusBoard = container.querySelector('[aria-label="项目看板"]');
  expect(focusBoard?.querySelectorAll('[data-roadmap-work-id]')).toHaveLength(4);
  expect(container.querySelector('[aria-label="项目观察方式"] [aria-current="page"]')?.textContent).toBe('看板');

  await click('依赖图');
  const graph = container.querySelector('[aria-label="任务依赖图"]');
  expect(graph).not.toBeNull();
  if (!graph) throw new Error('Expected the dependency projection');
  expect(graph.querySelectorAll('[data-dependency-level="0"]')).toHaveLength(3);
  expect(graph.querySelectorAll('[data-dependency-level="1"]')).toHaveLength(1);
  expect(
    new Set(
      [...graph.querySelectorAll('[data-roadmap-work-id]')].map((item) => item.getAttribute('data-roadmap-work-id')),
    ).size,
  ).toBe(4);
  expect(graph.textContent).toContain('阻塞原因未填写');
  expect(graph.textContent).toContain(`前置已完成：${foundation.title}`);
  expect(graph.textContent).not.toContain(`等待 ${foundation.title}`);

  await click(foundation.title);
  const completedDetail = container.querySelector(`[aria-label="任务详情 · ${foundation.title}"]`);
  expect(completedDetail).not.toBeNull();
  expect(completedDetail?.querySelector('.roadmap-dependency-editor')).toBeNull();

  await click(mobile.title);
  const detail = container.querySelector(`[aria-label="任务详情 · ${mobile.title}"]`);
  expect(detail?.textContent).toContain('You 负责');
  expect(detail?.textContent).toContain('小星星 · 砚砚 推进');
  expect(detail?.textContent).toContain('#插件共建 · 话题');
  expect(detail?.textContent).toContain('调整了前置任务');
  expect(container.textContent).toContain('重新打开了项目');
  expect(container.textContent).not.toContain('今天已冻结');
  await click('查看来源消息');
  expect(onOpenSource).toHaveBeenCalledWith(
    mobile,
    expect.objectContaining({ roadmapId: primary.roadmapId, lens: 'dependencies', workId: mobile.workId }),
  );

  await click('与我相关');
  const mine = container.querySelector('[aria-label="任务依赖图"]');
  expect(mine).not.toBeNull();
  expect(mine?.textContent).toContain(foundation.title);
  expect(mine?.textContent).toContain(narrative.title);
  expect(mine?.textContent).toContain(mobile.title);
  expect(mine?.textContent).not.toContain(memberWork.title);
});

it('shows one real cross-project task board with four progress columns and executor swimlanes', async () => {
  const unassigned = {
    ...work('unassigned', '精简共同体公开接口', 'ready'),
    accountableHumanId: undefined,
    status: 'unassigned' as const,
  } satisfies CollectiveWorkProjection;
  const blocked = {
    ...work('blockedrun', 'C1 插件切换', 'blocked', {
      assigned: true,
      dependencies: ['work_foundation'],
    }),
    lifecycle: 'in_progress',
  } satisfies CollectiveWorkProjection;
  const review = work('review', '#1519 新安装包', 'result_ready', { assigned: true });
  const shared = work('shared', 'A2A 主体合入', 'completed', { assigned: true });
  const selfRun = work('selfrun', '取包核验新安装包', 'in_progress');
  const primary = roadmap('roadmap_primarya', '插件框架', [
    unassigned.workId,
    blocked.workId,
    review.workId,
    shared.workId,
  ]);
  const secondary = roadmap('roadmap_secondaa', '首次上手', [shared.workId, selfRun.workId]);

  await act(async () =>
    root.render(
      <RoadmapWorkspace
        roadmaps={[primary, secondary]}
        works={[unassigned, blocked, review, shared, selfRun]}
        currentHumanId={operator.humanId}
        humanNames={{ [operator.humanId]: 'You' }}
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

  expect(
    [...container.querySelectorAll('[aria-label="项目视图"] button')].map((item) => item.textContent?.trim()),
  ).toEqual(['项目列表', '跨项目依赖', '看板']);
  await click('看板');
  const board = container.querySelector('[aria-label="项目看板"]');
  expect(board).not.toBeNull();
  expect(
    [...(board?.querySelectorAll('[data-project-column] > header strong') ?? [])].map((item) => item.textContent),
  ).toEqual(['待开始', '进行中', '待确认', '已完成']);
  expect(board?.querySelector('[data-project-lane]')?.textContent).toContain('未分配');
  const cardColumn = (workId: string) =>
    board
      ?.querySelector(`[data-roadmap-work-id="${workId}"]`)
      ?.closest('[data-project-column]')
      ?.getAttribute('data-project-column');
  expect(cardColumn(unassigned.workId)).toBe('queued');
  expect(cardColumn(blocked.workId)).toBe('in_progress');
  expect(cardColumn(review.workId)).toBe('result_ready');
  expect(cardColumn(shared.workId)).toBe('completed');
  expect(board?.querySelector('[data-work-status="blocked"] .project-board-banner-critical')?.textContent).toContain(
    '等待',
  );
  expect(board?.querySelectorAll(`[data-roadmap-work-id="${shared.workId}"]`)).toHaveLength(1);
  expect(board?.querySelectorAll('[data-roadmap-work-id]')).toHaveLength(5);

  await click(unassigned.title);
  expect(container.querySelector(`[aria-label="任务详情 · ${unassigned.title}"]`)).not.toBeNull();
  expect(
    container.querySelector(`[aria-label="项目任务计划"] [data-project-plan-work-id="${unassigned.workId}"]`),
  ).not.toBeNull();

  await click('项目');
  const list = container.querySelector('[aria-label="项目列表"]');
  expect(list?.textContent).toContain(primary.title);
  expect(list?.textContent).toContain(secondary.title);
  expect(list?.querySelectorAll('[data-project-id]')).toHaveLength(2);

  await click(secondary.title);
  await click('看板');
  await click(shared.title);
  expect(container.querySelector(`[aria-label="项目 · ${secondary.title}"]`)).not.toBeNull();
  expect(container.querySelector(`[aria-label="项目看板"] [data-roadmap-work-id="${shared.workId}"]`)).not.toBeNull();

  await click('项目');
  await click('跨项目依赖');
  const dependencies = container.querySelector('[aria-label="任务依赖图"]');
  expect(dependencies?.querySelectorAll(`[data-roadmap-work-id="${shared.workId}"]`)).toHaveLength(1);
  expect(dependencies?.querySelectorAll('[data-roadmap-work-id]')).toHaveLength(5);
});
