// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveWorkCard } from '../CollectiveWorkCard.js';
import type { ChannelThread, CollectiveEventEnvelope, CollectiveWorkProjection } from '../client-types.js';
import { RoadmapPanel } from '../RoadmapPanel.js';
import { TopicPanel } from '../TopicPanel.js';
import { participant, roadmap, work } from './collaboration-cards.fixture.js';

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

it('turns a proposal into a linked card with one-click self/Cat acceptance and an explicit no-track path', async () => {
  const onCommit = vi.fn();
  const onDecline = vi.fn();
  await act(async () =>
    root.render(
      <CollectiveWorkCard
        work={work}
        works={[work]}
        currentHumanId={participant.humanId}
        sourceOwnerHumanId={participant.humanId}
        canSteward={false}
        participants={[participant]}
        humanNames={{ [participant.humanId]: 'You' }}
        onCommit={onCommit}
        onDecline={onDecline}
        onAcceptResult={vi.fn()}
        onComplete={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain('工作提议 · 来自这条消息');
  expect(container.textContent).toContain(work.title);
  expect(container.querySelector('input')).toBeNull();
  await click('交给 小太阳 · 砚砚');
  expect(onCommit).toHaveBeenCalledWith(work, participant);
  await click('先不跟踪');
  expect(onDecline).toHaveBeenCalledWith(work);
});

it('lets the accountable Human return exact feedback or accept the current result version', async () => {
  const dependency = {
    ...work,
    workId: 'work_bbbbbbbb',
    title: '确认验收范围',
    lifecycle: 'committed' as const,
    status: 'ready' as const,
  };
  const returned = {
    ...work,
    lifecycle: 'result_ready' as const,
    status: 'result_ready' as const,
    revision: 4,
    accountableHumanId: participant.humanId,
    assignment: {
      humanId: participant.humanId,
      connectionId: participant.connectionId,
      catId: participant.catId,
      displayName: participant.displayName,
      participationRevision: 1,
      assignedAt: work.createdAt,
    },
    dependencyWorkIds: [dependency.workId],
    resultEventId: 'evt_resultaa',
    resultRevision: 1,
  } satisfies CollectiveWorkProjection;
  const onAcceptResult = vi.fn();
  const onRequestRevision = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <CollectiveWorkCard
        work={returned}
        works={[returned, dependency]}
        currentHumanId={participant.humanId}
        sourceOwnerHumanId={participant.humanId}
        canSteward={false}
        participants={[participant]}
        humanNames={{ [participant.humanId]: 'You' }}
        onCommit={vi.fn()}
        onDecline={vi.fn()}
        onAcceptResult={onAcceptResult}
        onRequestRevision={onRequestRevision}
        onComplete={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain('小太阳 · 砚砚 推进 · You 负责');
  expect(container.textContent).toContain('前置 · 确认验收范围');
  expect(container.textContent).toContain('结果 v1 已回到原讨论');
  const feedback = container.querySelector<HTMLTextAreaElement>('[aria-label="修订反馈"]');
  expect(feedback).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(feedback, '请补上重启后的恢复证据。');
    feedback?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('退回修改');
  expect(onRequestRevision).toHaveBeenCalledWith(returned, '请补上重启后的恢复证据。');
  await click('确认结果并完成');
  expect(onAcceptResult).toHaveBeenCalledWith(returned);
});

it('shows proposal disposition only to an authorized Human and gives self-owned Work a real completion action', async () => {
  const memberHumanId = 'human_bbbbbbbb';
  const onComplete = vi.fn();
  await act(async () =>
    root.render(
      <CollectiveWorkCard
        work={work}
        works={[work]}
        currentHumanId={memberHumanId}
        sourceOwnerHumanId={participant.humanId}
        canSteward={false}
        participants={[]}
        humanNames={{ [participant.humanId]: 'You', [memberHumanId]: 'Member' }}
        onCommit={vi.fn()}
        onDecline={vi.fn()}
        onAcceptResult={vi.fn()}
        onComplete={onComplete}
      />,
    ),
  );
  expect(container.textContent).not.toContain('先不跟踪');

  const selfOwned = {
    ...work,
    lifecycle: 'committed' as const,
    status: 'ready' as const,
    revision: 2,
    accountableHumanId: memberHumanId,
  } satisfies CollectiveWorkProjection;
  await act(async () =>
    root.render(
      <CollectiveWorkCard
        work={selfOwned}
        works={[selfOwned]}
        currentHumanId={memberHumanId}
        sourceOwnerHumanId={participant.humanId}
        canSteward={false}
        participants={[]}
        humanNames={{ [memberHumanId]: 'Member' }}
        onCommit={vi.fn()}
        onDecline={vi.fn()}
        onAcceptResult={vi.fn()}
        onComplete={onComplete}
      />,
    ),
  );
  await click('标记完成');
  expect(onComplete).toHaveBeenCalledWith(selfOwned);

  await act(async () =>
    root.render(
      <CollectiveWorkCard
        work={{
          ...selfOwned,
          assignment: {
            humanId: memberHumanId,
            connectionId: participant.connectionId,
            catId: participant.catId,
            displayName: participant.displayName,
            participationRevision: 1,
            assignedAt: work.createdAt,
          },
        }}
        works={[selfOwned]}
        currentHumanId={memberHumanId}
        sourceOwnerHumanId={participant.humanId}
        canSteward={false}
        participants={[]}
        humanNames={{ [memberHumanId]: 'Member' }}
        onCommit={vi.fn()}
        onDecline={vi.fn()}
        onAcceptResult={vi.fn()}
        onComplete={onComplete}
      />,
    ),
  );
  expect(container.textContent).not.toContain('标记完成');
});

it('keeps reply-sourced Work under the exact Topic reply and lets Humans propose from another reply', async () => {
  const rootEvent: CollectiveEventEnvelope = {
    serviceInstanceId: participant.serviceInstanceId,
    collectiveId: participant.collectiveId,
    eventId: 'evt_rootreply',
    clientEventId: 'root-reply-source',
    sequence: 1,
    actor: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
    target: { kind: 'channel', channelId: 'general' },
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '先讨论完整交付。',
    acceptedAt: work.createdAt,
  };
  const firstReply: CollectiveEventEnvelope = {
    ...rootEvent,
    eventId: 'evt_replyaaa',
    clientEventId: 'first-reply',
    sequence: 2,
    target: { kind: 'message', eventId: rootEvent.eventId },
    location: { channelId: 'general', rootEventId: rootEvent.eventId },
    replyToEventId: rootEvent.eventId,
    body: '把权限边界先收成一项工作。',
  };
  const secondReply: CollectiveEventEnvelope = {
    ...firstReply,
    eventId: 'evt_replybbb',
    clientEventId: 'second-reply',
    sequence: 3,
    body: '再补一条真实恢复验证。',
  };
  const thread: ChannelThread = { root: rootEvent, replies: [firstReply, secondReply] };
  const replyWork = {
    ...work,
    sourceEventId: firstReply.eventId,
    sourceLocation: firstReply.location ?? { channelId: 'general' },
    title: '回复长出的工作',
  } satisfies CollectiveWorkProjection;
  const onProposeWork = vi.fn();

  await act(async () =>
    root.render(
      <TopicPanel
        thread={thread}
        namespace="fixture"
        delivery={{ kind: 'idle' }}
        onClose={vi.fn()}
        onReturnToSource={vi.fn()}
        onOpenMember={vi.fn()}
        onSend={vi.fn()}
        participants={[participant]}
        humans={[]}
        works={[replyWork]}
        allWorks={[replyWork]}
        currentHumanId={participant.humanId}
        humanNames={{ [participant.humanId]: 'You' }}
        canSteward
        onProposeWork={onProposeWork}
        onCommitWork={vi.fn()}
        onDeclineWork={vi.fn()}
        onAcceptWorkResult={vi.fn()}
        onCompleteWork={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain('回复长出的工作');
  const secondReplyInteraction = container.querySelector<HTMLElement>(
    `[data-message-interaction-event-id="${secondReply.eventId}"]`,
  );
  const more = secondReplyInteraction?.querySelector<HTMLButtonElement>('[aria-label="更多消息动作"]');
  await act(async () => more?.click());
  const proposeReply = [...(secondReplyInteraction?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.textContent?.trim() === '整理为工作',
  );
  expect(proposeReply).toBeDefined();
  await act(async () => proposeReply?.click());
  expect(onProposeWork).toHaveBeenCalledWith(secondReply.eventId);
});

it('renders one real Roadmap through route, dependency, and personal lenses', async () => {
  const second = {
    ...work,
    workId: 'work_bbbbbbbb',
    title: '完成团队验收',
    lifecycle: 'committed' as const,
    status: 'blocked' as const,
    accountableHumanId: participant.humanId,
    dependencyWorkIds: [work.workId],
  } satisfies CollectiveWorkProjection;
  await act(async () =>
    root.render(
      <RoadmapPanel
        roadmap={roadmap}
        works={[{ ...work, lifecycle: 'completed', status: 'completed' }, second]}
        currentHumanId={participant.humanId}
        onSetDependencies={vi.fn()}
        onSetStatus={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain(roadmap.title);
  expect(container.textContent).toContain('接通真实首页');
  expect(container.textContent).toContain('完成团队验收');
  await click('依赖关系');
  expect(container.textContent).toContain('完成团队验收');
  expect(container.textContent).toContain('等待 接通真实首页');
  await click('我的路线');
  expect(container.textContent).toContain('由我负责');
});
