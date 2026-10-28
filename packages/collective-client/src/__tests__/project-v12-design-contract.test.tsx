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
import { RoadmapWorkspace } from '../RoadmapWorkspace.js';

const operator = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: 'You' };
const wulang = { kind: 'human' as const, humanId: 'human_bbbbbbbb', displayName: '吴浪' };
const at = '2026-10-18T08:00:00.000Z';
const humans: CollectiveMemberDirectory['humans'] = [
  { ...operator, role: 'steward', avatarUrl: 'https://example.test/operator.png' },
  { ...wulang, role: 'member' },
];
const cat: CollectiveParticipant = {
  serviceInstanceId: 'svc_aaaaaaaa',
  collectiveId: 'col_aaaaaaaa',
  connectionId: 'con_aaaaaaaa',
  endpointId: 'endpoint_aaaaaaaa',
  endpointLabel: 'You 的 Café',
  humanId: operator.humanId,
  humanDisplayName: operator.displayName,
  catId: 'codex-sol',
  displayName: '小太阳 · 砚砚',
  channelIds: ['产品方向'],
  participationRevision: 1,
  availability: 'declared',
};

function makeWork(
  suffix: string,
  title: string,
  options: {
    readonly status?: CollectiveWorkProjection['status'];
    readonly accountableHumanId?: string;
    readonly unassigned?: boolean;
    readonly assigned?: boolean;
    readonly dependencies?: readonly string[];
    readonly outcome?: string;
    readonly historyAction?: CollectiveWorkProjection['history'][number]['action'];
  } = {},
): CollectiveWorkProjection {
  const status = options.status ?? (options.unassigned ? 'unassigned' : 'ready');
  const lifecycle: CollectiveWorkProjection['lifecycle'] =
    status === 'blocked' || status === 'unassigned' || status === 'ready' ? 'committed' : status;
  const actor = options.accountableHumanId === wulang.humanId ? wulang : operator;
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: `work_${suffix.padEnd(8, 'x')}`,
    sourceEventId: `evt_${suffix.padEnd(8, 'x')}`,
    sourceLocation: { channelId: '产品方向' },
    title,
    intendedOutcome: options.outcome ?? `${title} 有一份可打开、可验收的交付。`,
    proposedBy: actor,
    ...(!options.unassigned ? { accountableHumanId: options.accountableHumanId ?? operator.humanId } : {}),
    ...(options.assigned
      ? {
          assignment: {
            humanId: options.accountableHumanId ?? operator.humanId,
            connectionId: cat.connectionId,
            catId: cat.catId,
            displayName: cat.displayName,
            participationRevision: cat.participationRevision,
            assignedAt: at,
          },
        }
      : {}),
    dependencyWorkIds: [...(options.dependencies ?? [])],
    lifecycle,
    status,
    revision: 3,
    createdAt: at,
    updatedAt: '2026-10-18T09:30:00.000Z',
    history: [
      { revision: 1, action: 'proposed', actor, at },
      {
        revision: 3,
        action: options.historyAction ?? (lifecycle === 'completed' ? 'completed' : 'progress_reported'),
        actor,
        at: '2026-10-18T09:30:00.000Z',
        note: '保留最近一次真实进展。',
      },
    ],
  };
}

function makeRoadmap(
  suffix: string,
  title: string,
  workIds: readonly string[],
  options: { readonly owner?: string; readonly status?: CollectiveRoadmapRecord['status'] } = {},
): CollectiveRoadmapRecord {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    roadmapId: `roadmap_${suffix.padEnd(8, 'x')}`,
    sourceEventId: `evt_project_${suffix.padEnd(8, 'x')}`,
    sourceLocation: { channelId: '产品方向' },
    title,
    purpose: `${title} 的目标是把真实结果交给共同体成员验收。`,
    accountableHumanId: options.owner ?? operator.humanId,
    workIds: [...workIds],
    status: options.status ?? 'active',
    revision: 2,
    createdAt: at,
    updatedAt: '2026-10-18T09:45:00.000Z',
    history: [
      { revision: 1, action: 'created', actor: operator, at },
      { revision: 2, action: 'works_changed', actor: operator, at: '2026-10-18T09:45:00.000Z' },
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

function baseProps() {
  return {
    currentHumanId: operator.humanId,
    humans,
    participants: [cat],
    humanNames: { [operator.humanId]: operator.displayName, [wulang.humanId]: wulang.displayName },
    onSetDependencies: vi.fn(),
    onSetStatus: vi.fn(),
    onCreateProject: vi.fn(async () => undefined),
    onCreateProjectTask: vi.fn(async () => undefined),
    onCommitWork: vi.fn(async () => undefined),
    onRequestWorkAccountability: vi.fn(async () => undefined),
    onRespondWorkAccountability: vi.fn(async () => undefined),
    bindingVotes: [],
    decisions: [],
    onCreateBindingVote: vi.fn(),
    onCastBindingVote: vi.fn(),
    onWithdrawBindingVote: vi.fn(),
    onSettleBindingVote: vi.fn(),
  };
}

async function clickButton(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button?.click());
}

async function openProject(title: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="打开项目 · ${title}"]`);
  expect(button, `project ${title}`).not.toBeNull();
  await act(async () => button?.click());
}

async function select(label: string, value: string) {
  const control = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(control, `select ${label}`).not.toBeNull();
  await act(async () => {
    if (!control) return;
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('gives list, board, and one Project their own page structure and primary action', async () => {
  const task = makeWork('surface', '交付页面结构');
  const project = makeRoadmap('surface', '完整可用版本', [task.workId]);
  await act(async () => root.render(<RoadmapWorkspace {...baseProps()} roadmaps={[project]} works={[task]} />));

  expect(container.querySelector('[aria-label="项目总览导航"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="项目待办"]')).not.toBeNull();
  expect(container.querySelectorAll('button.project-primary-action')).toHaveLength(1);
  expect(container.querySelector('button.project-primary-action')?.textContent).toBe('新建项目');

  await clickButton('看板');
  expect(container.querySelector('[aria-label="项目待办"]')).toBeNull();
  expect(container.querySelector('button.project-primary-action')?.textContent).toBe('新建任务');

  await clickButton('项目列表');
  await openProject(project.title);
  expect(container.querySelector('[aria-label="项目总览导航"]')).toBeNull();
  expect(container.querySelector('[aria-label="项目层级"]')?.textContent).toContain(`项目›${project.title}`);
  expect([...container.querySelectorAll('[aria-label="项目观察方式"] button')].map((item) => item.textContent)).toEqual(
    ['计划', '看板', '依赖图', '作品'],
  );
  expect(container.querySelector('[aria-label="项目待办"]')).toBeNull();
  expect(container.querySelectorAll('button.project-primary-action')).toHaveLength(1);
  expect(container.querySelector('button.project-primary-action')?.textContent).toBe('新建任务');
});

it('filters the Project list with truthful counts, owner selection, and a folded completed section', async () => {
  const activeTask = makeWork('active', '交付可验证接口', {
    outcome: '下一次交付是一份可打开的接口验证记录。',
    assigned: true,
  });
  const blockedTask = makeWork('blocked', '接通发布入口', {
    accountableHumanId: wulang.humanId,
    status: 'blocked',
    dependencies: [activeTask.workId],
  });
  const doneTask = makeWork('done', '归档旧版本', { status: 'completed' });
  const active = makeRoadmap('active', '当前项目', [activeTask.workId]);
  const blocked = makeRoadmap('blocked', '受阻项目', [blockedTask.workId], { owner: wulang.humanId });
  const completed = makeRoadmap('done', '已完成项目', [doneTask.workId], { status: 'completed' });
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        {...baseProps()}
        roadmaps={[active, blocked, completed]}
        works={[activeTask, blockedTask, doneTask]}
      />,
    ),
  );

  const filters = container.querySelector('[aria-label="项目列表筛选"]');
  expect([...(filters?.querySelectorAll('button') ?? [])].map((button) => button.textContent)).toEqual([
    '进行中 2',
    '与我相关 1',
    '有阻塞 1',
  ]);
  expect(container.querySelectorAll('[data-project-id]')).toHaveLength(2);
  expect(container.textContent).not.toContain('继续推进');
  expect(container.textContent).toContain('下一次交付是一份可打开的接口验证记录。');
  expect(container.textContent).toContain(`等待 ${activeTask.title}`);

  await clickButton('有阻塞 1');
  expect(container.querySelectorAll('[data-project-id]')).toHaveLength(1);
  expect(container.textContent).toContain(blocked.title);

  await clickButton('进行中 2');
  await select('按负责人筛选', wulang.humanId);
  expect(container.querySelectorAll('[data-project-id]')).toHaveLength(1);
  expect(container.textContent).toContain(blocked.title);

  await select('按负责人筛选', 'all');
  const setting = container.querySelector<HTMLDetailsElement>('[aria-label="项目列表显示设置"]');
  expect(setting).not.toBeNull();
  await act(async () => setting?.setAttribute('open', ''));
  const showCompleted = container.querySelector<HTMLInputElement>('input[aria-label="显示已完成项目"]');
  expect(showCompleted).not.toBeNull();
  await act(async () => showCompleted?.click());
  expect(container.querySelector('[aria-label="已完成项目"]')?.textContent).toContain(completed.title);
});

it('makes board filters, identity chips, and inline responsibility operate on canonical Works', async () => {
  const prerequisite = makeWork('prereq', '补齐共同接口', { unassigned: true });
  const blocked = makeWork('blocked', '发布新入口', {
    status: 'blocked',
    assigned: true,
    dependencies: [prerequisite.workId],
  });
  const independent = makeWork('independent', '整理帮助文档', { unassigned: true });
  const review = makeWork('review', '验收安装包', { status: 'result_ready', assigned: true });
  const project = makeRoadmap('board', '插件框架', [
    prerequisite.workId,
    blocked.workId,
    independent.workId,
    review.workId,
  ]);
  const props = baseProps();
  await act(async () =>
    root.render(
      <RoadmapWorkspace {...props} roadmaps={[project]} works={[prerequisite, blocked, independent, review]} />,
    ),
  );
  await clickButton('看板');

  const toolbar = container.querySelector('[aria-label="看板筛选"]');
  expect([...(toolbar?.querySelectorAll('button') ?? [])].map((button) => button.textContent)).toEqual([
    '全部任务 4',
    '与我相关 2',
    '被阻塞 1',
    '待确认 1',
  ]);
  expect(container.querySelector('[aria-label="看板显示设置"]')).not.toBeNull();
  expect(container.querySelector('[data-identity-kind="agent"]')?.textContent).toContain(cat.displayName);
  expect(container.querySelector('[data-identity-kind="human"]')?.textContent).toContain(operator.displayName);

  const prerequisiteCard = container.querySelector(`[data-roadmap-work-id="${prerequisite.workId}"]`);
  const independentCard = container.querySelector(`[data-roadmap-work-id="${independent.workId}"]`);
  expect(prerequisiteCard?.textContent).toContain(`正挡住 ${blocked.title}`);
  expect(independentCard?.textContent).not.toContain('正挡住');
  const inline = prerequisiteCard?.querySelector('[aria-label="卡内指定负责人"]');
  expect(inline).not.toBeNull();
  const responsibility = inline?.querySelector<HTMLSelectElement>('select');
  await act(async () => {
    if (!responsibility) return;
    responsibility.value = wulang.humanId;
    responsibility.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const send = [...(inline?.querySelectorAll('button') ?? [])].find((button) => button.textContent === '指定');
  await act(async () => send?.click());
  expect(props.onRequestWorkAccountability).toHaveBeenCalledWith(project, prerequisite, wulang.humanId);

  await clickButton('被阻塞 1');
  expect(container.querySelectorAll('[data-roadmap-work-id]')).toHaveLength(1);
  expect(container.textContent).toContain(blocked.title);
});

it('renders Plan as a dependency-ordered task table with real delivery, recency, and inline ownership', async () => {
  const prerequisite = makeWork('done', '接通基础能力', { status: 'completed' });
  const blocked = makeWork('blocked', '交付完整页面', {
    status: 'blocked',
    assigned: true,
    dependencies: [prerequisite.workId],
    outcome: '下一次交付是可在 390px 和 1440px 操作的页面。',
  });
  const unassigned = makeWork('unassigned', '补齐验收说明', { unassigned: true });
  const project = makeRoadmap('plan', '完整可用版本', [blocked.workId, unassigned.workId, prerequisite.workId]);
  await act(async () =>
    root.render(<RoadmapWorkspace {...baseProps()} roadmaps={[project]} works={[blocked, unassigned, prerequisite]} />),
  );
  await openProject(project.title);

  const plan = container.querySelector('[aria-label="项目任务计划"]');
  expect(plan).not.toBeNull();
  expect([...(plan?.querySelectorAll('.project-plan-columns > span') ?? [])].map((cell) => cell.textContent)).toEqual([
    '任务',
    '执行',
    '阻塞 / 前置',
    '下一次交付',
    '时间',
  ]);
  expect(container.querySelector('[aria-label="项目任务图"]')).toBeNull();
  const orderedIds = [...(plan?.querySelectorAll('[data-project-plan-work-id]') ?? [])].map((row) =>
    row.getAttribute('data-project-plan-work-id'),
  );
  expect(orderedIds.indexOf(prerequisite.workId)).toBeLessThan(orderedIds.indexOf(blocked.workId));
  expect(plan?.querySelector(`[data-project-plan-work-id="${blocked.workId}"]`)?.getAttribute('data-blocked')).toBe(
    'true',
  );
  expect(plan?.textContent).toContain('下一次交付是可在 390px 和 1440px 操作的页面。');
  expect(plan?.textContent).toContain('更新了进度');
  expect(plan?.querySelector('[aria-label="卡内指定负责人"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="已完成任务"]')?.textContent).toContain(prerequisite.title);
  expect([...container.querySelectorAll('[aria-label="项目筛选"] button')].map((button) => button.textContent)).toEqual(
    ['全部 3', '未完成 2', '与我相关 2'],
  );
});

it('keeps authorized Project context and activity beside the plan without exposing raw identifiers', async () => {
  const done = makeWork('done', '完成真实来源绑定', { status: 'completed' });
  const blocked = makeWork('blocked', '交付完整页面', {
    status: 'blocked',
    dependencies: [done.workId],
  });
  const project = makeRoadmap('context', '共同体项目', [done.workId, blocked.workId]);
  await act(async () =>
    root.render(<RoadmapWorkspace {...baseProps()} roadmaps={[project]} works={[done, blocked]} />),
  );
  await openProject(project.title);

  const context = container.querySelector('[aria-label="项目上下文与动态"]');
  expect(context?.textContent).toContain('猫接手这个项目的任务时，先读到这些');
  expect(context?.textContent).toContain(project.purpose);
  expect(context?.textContent).toContain(done.title);
  expect(context?.textContent).toContain(blocked.title);
  expect(context?.textContent).toContain('来自 #产品方向');
  expect(context?.textContent).toContain('调整了项目任务');
  expect(context?.textContent).toContain('更新了进度');
  expect(context?.textContent).not.toContain(project.roadmapId);
  expect(context?.textContent).not.toContain(blocked.workId);
});
