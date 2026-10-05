// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BindingVoteSection } from '../BindingVoteCard.js';
import type {
  CollectiveBindingVoteProjection,
  CollectiveDecisionRecord,
  CollectiveRoadmapRecord,
} from '../client-types.js';

const roadmap: CollectiveRoadmapRecord = {
  v: 1,
  serviceInstanceId: 'svc_aaaaaaaa',
  collectiveId: 'col_aaaaaaaa',
  roadmapId: 'roadmap_aaaaaaaa',
  sourceEventId: 'evt_aaaaaaaa',
  sourceLocation: { channelId: 'general' },
  title: '候选版本路线',
  purpose: '明确路线判断。',
  accountableHumanId: 'human_aaaaaaaa',
  workIds: ['work_aaaaaaaa'],
  status: 'active',
  revision: 2,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:05:00.000Z',
  history: [],
};
const vote: CollectiveBindingVoteProjection = {
  v: 1,
  serviceInstanceId: roadmap.serviceInstanceId,
  collectiveId: roadmap.collectiveId,
  bindingVoteId: 'binding_vote_aaaaaaaa',
  sourceEventId: roadmap.sourceEventId,
  sourceLocation: roadmap.sourceLocation,
  kind: 'binding_vote',
  question: '候选版本按哪个日期交付？',
  options: [
    { optionId: 'vote_option_aaaaaaaa', label: '周四' },
    { optionId: 'vote_option_bbbbbbbb', label: '周五' },
  ],
  ballots: [
    {
      humanId: 'human_bbbbbbbb',
      displayName: 'Member',
      choice: { kind: 'option', optionId: 'vote_option_bbbbbbbb' },
      castAt: '2026-09-13T00:10:00.000Z',
    },
  ],
  target: { kind: 'roadmap', roadmapId: roadmap.roadmapId, roadmapRevision: roadmap.revision },
  authority: {
    kind: 'roadmap_accountable_human',
    humanId: roadmap.accountableHumanId,
    scope: 'decision_only',
    evidenceRef: `roadmap:${roadmap.roadmapId}@${roadmap.revision}:accountable:${roadmap.accountableHumanId}`,
  },
  rules: {
    version: 1,
    eligibleVoters: [
      { humanId: 'human_aaaaaaaa', displayName: 'You' },
      { humanId: 'human_bbbbbbbb', displayName: 'Member' },
    ],
    quorumCount: 2,
    passCount: 2,
    allowAbstain: true,
    settlement: 'deadline_or_all_ballots',
  },
  closesAt: '2026-09-14T00:00:00.000Z',
  lifecycle: 'open',
  status: 'open',
  revision: 2,
  createdAt: '2026-09-13T00:06:00.000Z',
  updatedAt: '2026-09-13T00:10:00.000Z',
  history: [],
};

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

it('shows the frozen authority and majority rule while supporting option, abstain, and withdrawal', async () => {
  const onCast = vi.fn();
  const onWithdraw = vi.fn();
  await act(async () =>
    root.render(
      <BindingVoteSection
        roadmap={roadmap}
        votes={[vote]}
        decisions={[]}
        currentHumanId="human_bbbbbbbb"
        onCreate={vi.fn()}
        onCast={onCast}
        onWithdraw={onWithdraw}
        onSettle={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain('有约束力的路线判断');
  expect(container.textContent).toContain('2 位冻结投票人 · 2 人参与且同一选项 2 票才通过');
  expect(container.textContent).toContain('只生成 Decision，不自动改变路线');
  expect(container.textContent).not.toContain('结算为 Decision');
  await click('周四');
  expect(onCast).toHaveBeenCalledWith(vote, { kind: 'option', optionId: vote.options[0]?.optionId });
  await click('弃权');
  expect(onCast).toHaveBeenCalledWith(vote, { kind: 'abstain' });
  await click('撤回我的票');
  expect(onWithdraw).toHaveBeenCalledWith(vote);
});

it('lets only the frozen authority settle and renders the resulting Decision without claiming a Roadmap mutation', async () => {
  const result = {
    outcome: 'passed' as const,
    winningOptionId: vote.options[0]?.optionId ?? 'vote_option_aaaaaaaa',
    eligibleCount: 2,
    participationCount: 2,
    supportCount: 2,
    settledAt: '2026-09-13T00:12:00.000Z',
  };
  const settled = {
    ...vote,
    ballots: [
      ...vote.ballots,
      {
        humanId: 'human_aaaaaaaa',
        displayName: 'You',
        choice: { kind: 'option' as const, optionId: vote.options[0]?.optionId ?? 'vote_option_aaaaaaaa' },
        castAt: result.settledAt,
      },
    ],
    lifecycle: 'settled' as const,
    status: 'settled' as const,
    decisionId: 'decision_aaaaaaaa',
    result,
  } satisfies CollectiveBindingVoteProjection;
  const decision = {
    v: 1 as const,
    serviceInstanceId: roadmap.serviceInstanceId,
    collectiveId: roadmap.collectiveId,
    decisionId: settled.decisionId,
    bindingVoteId: settled.bindingVoteId,
    sourceEventId: settled.sourceEventId,
    sourceLocation: settled.sourceLocation,
    statement: '周四',
    target: settled.target,
    authority: settled.authority,
    rules: settled.rules,
    result,
    createdAt: result.settledAt,
  } satisfies CollectiveDecisionRecord;
  await act(async () =>
    root.render(
      <BindingVoteSection
        roadmap={roadmap}
        votes={[settled]}
        decisions={[decision]}
        currentHumanId="human_aaaaaaaa"
        onCreate={vi.fn()}
        onCast={vi.fn()}
        onWithdraw={vi.fn()}
        onSettle={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain('Decision · 周四');
  expect(container.textContent).toContain('路线未被自动修改');
});

it('does not offer Decision settlement after the frozen Roadmap authority becomes invalid', async () => {
  const onSettle = vi.fn();
  await act(async () =>
    root.render(
      <BindingVoteSection
        roadmap={roadmap}
        votes={[
          {
            ...vote,
            status: 'invalidated',
            invalidationReason: 'roadmap_authority_changed',
            ballots: [
              ...vote.ballots,
              {
                humanId: 'human_aaaaaaaa',
                displayName: 'You',
                choice: { kind: 'abstain' as const },
                castAt: '2026-09-13T00:11:00.000Z',
              },
            ],
          },
        ]}
        decisions={[]}
        currentHumanId="human_aaaaaaaa"
        onCreate={vi.fn()}
        onCast={vi.fn()}
        onWithdraw={vi.fn()}
        onSettle={onSettle}
      />,
    ),
  );
  expect(container.textContent).toContain('本轮失效且不缩小分母');
  expect(container.textContent).not.toContain('结算为 Decision');
  await click('确认本轮失效');
  expect(onSettle).toHaveBeenCalled();
});
