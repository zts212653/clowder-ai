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
    purpose: `让 ${title} 从讨论长成可回查的路线。`,
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

  expect(
    [...container.querySelectorAll('[aria-label="Roadmap 观察方式"] button')].map((item) => item.textContent),
  ).toEqual(['阶段路线', '依赖关系', '我的路线']);
  expect(controlLabels('Roadmap 呈现方式')).toEqual(['工作图', '状态看板']);
  expect(controlLabels('Roadmap 显示范围')).toEqual(['当前重点', '全部工作']);

  const focusTree = container.querySelector('[aria-label="Roadmap 工作图"]');
  expect(focusTree).not.toBeNull();
  expect(focusTree?.querySelectorAll('[data-roadmap-work-id]')).toHaveLength(3);
  expect(focusTree?.textContent).toContain(foundation.title);
  expect(focusTree?.textContent).toContain(narrative.title);
  expect(focusTree?.textContent).toContain(mobile.title);
  expect(focusTree?.textContent).not.toContain(memberWork.title);

  await click('状态看板');
  const focusBoard = container.querySelector('[aria-label="Roadmap 状态看板"]');
  expect(focusBoard?.querySelectorAll('[data-roadmap-work-id]')).toHaveLength(3);
  await click('全部工作');
  expect(
    container.querySelector('[aria-label="Roadmap 状态看板"]')?.querySelectorAll('[data-roadmap-work-id]'),
  ).toHaveLength(4);
  expect(container.querySelector('[aria-label="Roadmap 观察方式"] [aria-current="page"]')?.textContent).toBe(
    '阶段路线',
  );

  await click('依赖关系');
  const graph = container.querySelector('[aria-label="依赖工作图"]');
  expect(graph).not.toBeNull();
  if (!graph) throw new Error('Expected the dependency projection');
  expect(graph.querySelectorAll('[data-dependency-level="0"]')).toHaveLength(3);
  expect(graph.querySelectorAll('[data-dependency-level="1"]')).toHaveLength(1);
  expect(
    new Set(
      [...graph.querySelectorAll('[data-roadmap-work-id]')].map((item) => item.getAttribute('data-roadmap-work-id')),
    ).size,
  ).toBe(4);
  expect(graph.textContent).toContain(`等待 ${foundation.title}`);

  await click(mobile.title);
  const detail = container.querySelector(`[aria-label="工作详情 · ${mobile.title}"]`);
  expect(detail?.textContent).toContain('You 负责');
  expect(detail?.textContent).toContain('小星星 · 砚砚 推进');
  expect(detail?.textContent).toContain('#插件共建 · 话题');
  expect(detail?.textContent).toContain('调整了前置工作');
  expect(container.textContent).toContain('重新打开了路线');
  expect(container.textContent).not.toContain('今天已冻结');
  await click('查看来源消息');
  expect(onOpenSource).toHaveBeenCalledWith(
    mobile,
    expect.objectContaining({ roadmapId: primary.roadmapId, lens: 'dependencies', workId: mobile.workId }),
  );

  await click('我的路线');
  const mine = container.querySelector('[aria-label="我的路线"]');
  expect(mine).not.toBeNull();
  expect(mine?.textContent).toContain(foundation.title);
  expect(mine?.textContent).toContain(narrative.title);
  expect(mine?.textContent).toContain(mobile.title);
  expect(mine?.textContent).not.toContain(memberWork.title);
});
