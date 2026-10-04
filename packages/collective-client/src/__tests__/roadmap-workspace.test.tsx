// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { roadmapActionsFor } from '../channel-collaboration.js';
import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from '../client-types.js';
import { RoadmapWorkspace } from '../RoadmapWorkspace.js';

const actor = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: 'You' };
const work: CollectiveWorkProjection = {
  v: 1,
  serviceInstanceId: 'svc_aaaaaaaa',
  collectiveId: 'col_aaaaaaaa',
  workId: 'work_aaaaaaaa',
  sourceEventId: 'evt_aaaaaaaa',
  sourceLocation: { channelId: 'general' },
  title: '接通真实首页',
  intendedOutcome: '默认页面使用真实频道与成员。',
  proposedBy: actor,
  accountableHumanId: actor.humanId,
  dependencyWorkIds: [],
  lifecycle: 'completed',
  status: 'completed',
  revision: 3,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:10:00.000Z',
  history: [{ revision: 1, action: 'proposed', actor, at: '2026-09-13T00:00:00.000Z' }],
};

function roadmap(
  roadmapId: string,
  title: string,
  options: Partial<Pick<CollectiveRoadmapRecord, 'accountableHumanId' | 'status' | 'workIds'>> = {},
): CollectiveRoadmapRecord {
  return {
    v: 1,
    serviceInstanceId: work.serviceInstanceId,
    collectiveId: work.collectiveId,
    roadmapId,
    sourceEventId: work.sourceEventId,
    sourceLocation: work.sourceLocation,
    title,
    purpose: `推进 ${title}`,
    accountableHumanId: options.accountableHumanId ?? actor.humanId,
    workIds: options.workIds ?? [],
    status: options.status ?? 'active',
    revision: 1,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
    history: [{ revision: 1, action: 'created', actor, at: work.createdAt }],
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
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it('shows every Channel Roadmap and lets its accountable Human complete or reopen the selected route', async () => {
  const active = roadmap('roadmap_aaaaaaaa', '候选版本', { workIds: [work.workId] });
  const completed = roadmap('roadmap_bbbbbbbb', '已交付版本', { status: 'completed', workIds: [work.workId] });
  const onSetStatus = vi.fn();
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        roadmaps={[active, completed]}
        works={[work]}
        currentHumanId={actor.humanId}
        onSetDependencies={vi.fn()}
        onSetStatus={onSetStatus}
        bindingVotes={[]}
        decisions={[]}
        onCreateBindingVote={vi.fn()}
        onCastBindingVote={vi.fn()}
        onWithdrawBindingVote={vi.fn()}
        onSettleBindingVote={vi.fn()}
      />,
    ),
  );

  expect(container.textContent).toContain('候选版本');
  expect(container.textContent).toContain('已交付版本');
  await click('完成路线');
  expect(onSetStatus).toHaveBeenCalledWith(active, 'completed');
  await click('已交付版本');
  expect(container.querySelector('[aria-label="Roadmap · 已交付版本"]')).not.toBeNull();
  await click('重新打开路线');
  expect(onSetStatus).toHaveBeenCalledWith(completed, 'active');
});

it('keeps each returned result version and its feedback visible in Work history', async () => {
  const revisedWork = {
    ...work,
    lifecycle: 'result_ready' as const,
    status: 'result_ready' as const,
    revision: 6,
    resultEventId: 'evt_resultv2',
    resultRevision: 2,
    history: [
      ...work.history,
      {
        revision: 2,
        action: 'result_returned' as const,
        actor,
        at: '2026-09-13T00:05:00.000Z',
      },
      {
        revision: 3,
        action: 'revision_requested' as const,
        actor,
        at: '2026-09-13T00:06:00.000Z',
        resultRevision: 1,
        note: '请补上重启后的恢复证据。',
      },
      {
        revision: 6,
        action: 'result_returned' as const,
        actor,
        at: '2026-09-13T00:10:00.000Z',
        resultRevision: 2,
      },
    ],
  } satisfies CollectiveWorkProjection;
  const route = roadmap('roadmap_aaaaaaaa', '候选版本', { workIds: [revisedWork.workId] });
  await act(async () =>
    root.render(
      <RoadmapWorkspace
        roadmaps={[route]}
        works={[revisedWork]}
        currentHumanId={actor.humanId}
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

  await click(revisedWork.title);
  const details = container.querySelector(`[aria-label="工作详情 · ${revisedWork.title}"]`);
  expect(details?.textContent).toContain('把结果带回原讨论 · 结果 v2');
  expect(details?.textContent).toContain('退回结果并提出修订 · 结果 v1');
  expect(details?.textContent).toContain('请补上重启后的恢复证据。');
});

it('offers only owned active routes and creates a separate route instead of showing an unauthorized join', () => {
  const ownerRoute = roadmap('roadmap_aaaaaaaa', 'You 的路线');
  const create = vi.fn(async () => undefined);
  const setWorks = vi.fn(async () => undefined);
  const ownerActions = roadmapActionsFor(work, [ownerRoute], actor.humanId, create, setWorks);
  expect(ownerActions.map((action) => action.label)).toEqual(['加入「You 的路线」']);
  ownerActions[0]?.onInvoke(work);
  expect(setWorks).toHaveBeenCalledWith(ownerRoute, [work.workId]);

  const memberActions = roadmapActionsFor(work, [ownerRoute], 'human_bbbbbbbb', create, setWorks);
  expect(memberActions.map((action) => action.label)).toEqual(['建立另一条路线']);
  memberActions[0]?.onInvoke(work);
  expect(create).toHaveBeenCalledWith(work);

  expect(roadmapActionsFor(work, [{ ...ownerRoute, workIds: [work.workId] }], actor.humanId, create, setWorks)).toEqual(
    [],
  );
});
