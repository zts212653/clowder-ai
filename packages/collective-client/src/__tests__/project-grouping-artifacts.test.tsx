// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from '../client-types.js';
import type { SharedArtifact } from '../collective-artifact-client.js';
import { RoadmapWorkspace } from '../RoadmapWorkspace.js';

const operator = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: 'You' };
const wulang = { kind: 'human' as const, humanId: 'human_bbbbbbbb', displayName: '吴浪' };
const at = '2026-10-18T00:00:00.000Z';

function work(
  suffix: string,
  title: string,
  options: { readonly accountableHumanId?: string; readonly assigned?: boolean; readonly unassigned?: boolean } = {},
): CollectiveWorkProjection {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: `work_${suffix.padEnd(8, 'a')}`,
    sourceEventId: `evt_${suffix.padEnd(8, 'a')}`,
    sourceLocation: { channelId: '产品方向' },
    title,
    intendedOutcome: `${title} 有可验收结果。`,
    proposedBy: operator,
    ...(!options.unassigned ? { accountableHumanId: options.accountableHumanId ?? operator.humanId } : {}),
    ...(options.assigned
      ? {
          assignment: {
            humanId: options.accountableHumanId ?? operator.humanId,
            connectionId: `con_${suffix.padEnd(8, 'a')}`,
            catId: 'codex-sol',
            displayName: '小太阳 · 砚砚',
            participationRevision: 1,
            assignedAt: at,
          },
        }
      : {}),
    dependencyWorkIds: [],
    lifecycle: 'committed',
    status: options.unassigned ? 'unassigned' : 'ready',
    revision: 2,
    createdAt: at,
    updatedAt: at,
    history: [],
  };
}

function roadmap(id: string, title: string, workIds: readonly string[]): CollectiveRoadmapRecord {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    roadmapId: id,
    sourceEventId: `evt_${id}`,
    sourceLocation: { channelId: '产品方向' },
    title,
    purpose: `${title} 的完成标准。`,
    accountableHumanId: operator.humanId,
    workIds: [...workIds],
    status: 'active',
    revision: 2,
    createdAt: at,
    updatedAt: at,
    history: [{ revision: 1, action: 'created', actor: operator, at }],
  };
}

function artifact(workId: string): SharedArtifact {
  return {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    artifactId: 'artifact_aaaaaaaa',
    contentRef: 'content_aaaaaaaa',
    publishedByHumanId: operator.humanId,
    title: '项目验收说明.md',
    mediaType: 'text/markdown',
    sourceEventId: 'evt_artifact000',
    sourceLocation: { channelId: '产品方向' },
    workId,
    revision: 1,
    versions: [
      {
        ownerRevision: 2,
        blobDigest: `sha256:${'a'.repeat(64)}`,
        receiptRef: 'receipt_aaaaaaaa',
        recordedAt: '2026-10-18T01:00:00.000Z',
      },
    ],
    versionCount: 2,
    availability: 'available',
    accessRevision: 1,
    canApply: false,
    createdAt: at,
    updatedAt: '2026-10-18T01:00:00.000Z',
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

function baseProps() {
  return {
    currentHumanId: operator.humanId,
    humanNames: { [operator.humanId]: operator.displayName, [wulang.humanId]: wulang.displayName },
    onSetDependencies: vi.fn(),
    onSetStatus: vi.fn(),
    bindingVotes: [],
    decisions: [],
    onCreateBindingVote: vi.fn(),
    onCastBindingVote: vi.fn(),
    onWithdrawBindingVote: vi.fn(),
    onSettleBindingVote: vi.fn(),
  };
}

it('keeps canonical Tasks deduplicated while the global board groups by executor, accountable Human, or Project', async () => {
  const assigned = work('assigned', '猫执行的任务', { assigned: true });
  const human = work('human', '吴浪自己推进', { accountableHumanId: wulang.humanId });
  const unassigned = work('unassigned', '等待负责人', { unassigned: true });
  const primary = roadmap('roadmap_primarya', '完整版本', [assigned.workId, unassigned.workId]);
  const secondary = roadmap('roadmap_secondaa', '发布准备', [assigned.workId, human.workId]);
  await act(async () =>
    root.render(
      <RoadmapWorkspace {...baseProps()} roadmaps={[primary, secondary]} works={[assigned, human, unassigned]} />,
    ),
  );

  await click('看板');
  const board = container.querySelector('[aria-label="项目看板"]');
  expect(board?.querySelectorAll('[data-roadmap-work-id]')).toHaveLength(3);
  const summary = container.querySelector<HTMLElement>('summary[aria-label="更改看板分组"]');
  expect(summary?.textContent).toContain('显示设置 · 泳道按执行');
  await act(async () => summary?.click());
  await click('按负责人');
  expect(
    [...container.querySelectorAll('[data-project-lane]')].map((node) =>
      node.getAttribute('aria-label')?.replace(/的任务$/, ''),
    ),
  ).toEqual(['未分配', 'You', '吴浪']);
  expect(board?.querySelectorAll('[data-roadmap-work-id]')).toHaveLength(3);

  await act(async () => summary?.click());
  await click('按项目');
  expect(container.textContent).toContain('关联多个项目');
  expect(board?.querySelectorAll(`[data-roadmap-work-id="${assigned.workId}"]`)).toHaveLength(1);
  expect(board?.querySelectorAll('[data-roadmap-work-id]')).toHaveLength(3);
});

it('uses the frozen single-Project views and opens the latest authorized Artifact from the same Work truth', async () => {
  const current = work('artifact', '交付验收说明', { assigned: true });
  const project = roadmap('roadmap_primarya', '完整版本', [current.workId]);
  const currentArtifact = artifact(current.workId);
  const onOpenArtifact = vi.fn();
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        {...baseProps()}
        roadmaps={[project]}
        works={[current]}
        artifacts={[currentArtifact]}
        artifactStatus="ready"
        onOpenArtifact={onOpenArtifact}
      />,
    ),
  );

  const row = container.querySelector(`[data-project-id="${project.roadmapId}"]`);
  expect(row?.textContent).toContain(currentArtifact.title);
  await click(project.title);
  expect([...container.querySelectorAll('[aria-label="项目观察方式"] button')].map((item) => item.textContent)).toEqual(
    ['计划', '看板', '依赖图', '作品'],
  );
  expect([...container.querySelectorAll('[aria-label="项目筛选"] button')].map((item) => item.textContent)).toEqual([
    '全部 1',
    '未完成 1',
    '与我相关 1',
  ]);
  await click('作品');
  expect(container.querySelector('[aria-label="项目作品"]')?.textContent).toContain(currentArtifact.title);
  await click(currentArtifact.title);
  expect(onOpenArtifact).toHaveBeenCalledWith(currentArtifact);
});

it('distinguishes an unreadable Artifact source from a Project that simply has no Artifact yet', async () => {
  const current = work('artifact', '交付验收说明');
  const project = roadmap('roadmap_primarya', '完整版本', [current.workId]);
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        {...baseProps()}
        roadmaps={[project]}
        works={[current]}
        artifacts={[]}
        artifactStatus="access_denied"
      />,
    ),
  );
  await click(project.title);
  await click('作品');
  expect(container.querySelector('[aria-label="项目作品"]')?.textContent).toContain('你无权读取这个项目的作品');

  await act(async () =>
    root.render(
      <RoadmapWorkspace
        {...baseProps()}
        roadmaps={[project]}
        works={[current]}
        artifacts={[]}
        artifactStatus="ready"
      />,
    ),
  );
  expect(container.querySelector('[aria-label="项目作品"]')?.textContent).toContain('这个项目还没有作品');
});

it('shows Human-run and Cat-run Tasks together instead of treating every unassigned Cat as no executor', async () => {
  const humanRun = work('human', '吴浪本人推进', { accountableHumanId: wulang.humanId });
  const catRun = work('cat', '猫执行交付', { accountableHumanId: operator.humanId, assigned: true });
  const project = roadmap('roadmap_mixedaaa', '混合执行项目', [humanRun.workId, catRun.workId]);
  await act(async () =>
    root.render(<RoadmapWorkspace {...baseProps()} roadmaps={[project]} works={[humanRun, catRun]} />),
  );

  const people = container.querySelector(`[data-project-id="${project.roadmapId}"] .project-list-people`);
  expect(
    [...(people?.querySelectorAll('[data-identity-kind="human"]') ?? [])].map((node) => {
      const labels = node.querySelectorAll(':scope > span');
      return `${labels.item(labels.length - 1).textContent}${node.querySelector(':scope > small')?.textContent}`;
    }),
  ).toEqual(['You负责', '吴浪执行']);
  expect(people?.querySelector('[data-identity-kind="agent"]')?.textContent).toBe('小太阳 · 砚砚执行');
  expect(people?.textContent).not.toContain('由负责人推进或尚未分配');
});

it('lets a Human switch from one person’s Project attention to every pending item', async () => {
  const unassigned = work('unassigned', '等待 You 指派', { unassigned: true });
  const returned = {
    ...work('returned', '等待吴浪验收', { accountableHumanId: wulang.humanId }),
    lifecycle: 'result_ready' as const,
    status: 'result_ready' as const,
    history: [
      {
        revision: 2,
        action: 'result_returned' as const,
        actor: operator,
        at: '2026-10-18T01:00:00.000Z',
      },
    ],
  };
  const project = roadmap('roadmap_attention', '待办汇总项目', [unassigned.workId, returned.workId]);
  await act(async () =>
    root.render(<RoadmapWorkspace {...baseProps()} roadmaps={[project]} works={[unassigned, returned]} />),
  );

  const attention = container.querySelector('[aria-label="项目待办"]');
  expect(attention?.textContent).toContain(unassigned.title);
  expect(attention?.textContent).not.toContain(returned.title);
  const all = attention?.querySelector<HTMLButtonElement>('button[aria-label="全部待办"]');
  expect(all).not.toBeNull();
  await act(async () => all?.click());
  expect(all?.getAttribute('aria-pressed')).toBe('true');
  expect(attention?.textContent).toContain(unassigned.title);
  expect(attention?.textContent).toContain(returned.title);
});
