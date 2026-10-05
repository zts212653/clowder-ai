// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelMessage } from '../ChannelMessage.js';
import type { ChannelThread, CollectiveEventEnvelope, CollectiveParticipant } from '../client-types.js';
import { TopicPanel } from '../TopicPanel.js';

const participant: CollectiveParticipant = {
  serviceInstanceId: 'svc_aaaaaaaa',
  collectiveId: 'col_aaaaaaaa',
  connectionId: 'con_aaaaaaaa',
  endpointId: 'ep_aaaaaaaa',
  endpointLabel: 'You 的 Café',
  humanId: 'human_aaaaaaaa',
  humanDisplayName: 'You',
  catId: 'codex-sol',
  displayName: '小太阳 · 砚砚',
  participationRevision: 1,
  channelIds: ['general'],
  availability: 'declared',
};

const rootEvent: CollectiveEventEnvelope = {
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  eventId: 'evt_rootaaaa',
  clientEventId: 'message-interaction-root',
  sequence: 1,
  actor: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
  target: { kind: 'channel', channelId: 'general' },
  location: { channelId: 'general' },
  recipient: { kind: 'channel' },
  body: '喵',
  acceptedAt: '2026-09-19T12:00:00.000Z',
};

const replyEvent: CollectiveEventEnvelope = {
  ...rootEvent,
  eventId: 'evt_replyaaa',
  clientEventId: 'message-interaction-reply',
  sequence: 2,
  target: { kind: 'message', eventId: rootEvent.eventId },
  location: { channelId: 'general', rootEventId: rootEvent.eventId },
  recipient: { kind: 'channel' },
  replyToEventId: rootEvent.eventId,
  body: '收到，我接着做。',
};

const thread: ChannelThread = { root: rootEvent, replies: [replyEvent] };

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

function button(scope: ParentNode, label: string) {
  const target = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label,
  );
  if (!target) throw new Error(`Expected button: ${label}`);
  return target;
}

function interactionFor(eventId: string) {
  const interaction = container.querySelector<HTMLElement>(`[data-message-interaction-event-id="${eventId}"]`);
  if (!interaction) throw new Error(`Expected message interaction: ${eventId}`);
  return interaction;
}

async function click(target: HTMLButtonElement) {
  await act(async () => target.click());
}

describe.each([
  {
    host: 'Channel',
    render: async () => {
      await act(async () =>
        root.render(
          <ChannelMessage
            thread={{ root: rootEvent, replies: [] }}
            onOpenTopic={vi.fn()}
            onMention={vi.fn()}
            onOpenMember={vi.fn()}
            currentHumanId={participant.humanId}
            humanNames={{ [participant.humanId]: 'You' }}
            onSetReaction={vi.fn()}
            onProposeWork={vi.fn()}
            onCreateVote={vi.fn(async () => undefined)}
          />,
        ),
      );
    },
  },
  {
    host: 'Topic root',
    render: async () => {
      await act(async () =>
        root.render(
          <TopicPanel
            thread={{ root: rootEvent, replies: [] }}
            namespace="fixture"
            delivery={{ kind: 'idle' }}
            onClose={vi.fn()}
            onReturnToSource={vi.fn()}
            onOpenMember={vi.fn()}
            onSend={vi.fn(async () => undefined)}
            participants={[participant]}
            humans={[]}
            works={[]}
            allWorks={[]}
            currentHumanId={participant.humanId}
            humanNames={{ [participant.humanId]: 'You' }}
            canSteward
            onProposeWork={vi.fn()}
            onCommitWork={vi.fn()}
            onDeclineWork={vi.fn()}
            onAcceptWorkResult={vi.fn()}
            onCompleteWork={vi.fn()}
            onCreateVote={vi.fn(async () => undefined)}
            onSetReaction={vi.fn()}
          />,
        ),
      );
    },
  },
])('$host interaction parity', ({ render }) => {
  it('keeps a one-character empty state compact and exposes the same primary toolbar', async () => {
    await render();

    expect(container.querySelector('.reaction-bar')).toBeNull();
    expect(container.querySelector('.vote-create-action')).toBeNull();
    expect(container.textContent).not.toContain('发起随手投票');
    expect(container.textContent).not.toContain('整理为工作');

    const interaction = interactionFor(rootEvent.eventId);
    expect(button(interaction, '添加回应')).toBeDefined();
    expect(button(interaction, '回复 You')).toBeDefined();
    expect(button(interaction, '更多消息动作')).toBeDefined();
  });

  it('closes its secondary menu on Escape and outside press, restoring focus to the exact trigger', async () => {
    await render();
    const interaction = interactionFor(rootEvent.eventId);
    const more = button(interaction, '更多消息动作');
    await click(more);
    expect(interaction.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(interaction.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);

    await click(more);
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(interaction.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});

it('consumes the first Escape before a parent Topic shell can close', async () => {
  await act(async () =>
    root.render(
      <ChannelMessage
        thread={{ root: rootEvent, replies: [] }}
        onOpenTopic={vi.fn()}
        onMention={vi.fn()}
        onOpenMember={vi.fn()}
        currentHumanId={participant.humanId}
        humanNames={{ [participant.humanId]: 'You' }}
        onSetReaction={vi.fn()}
        onProposeWork={vi.fn()}
        onCreateVote={vi.fn(async () => undefined)}
      />,
    ),
  );
  await click(button(container, '更多消息动作'));
  const parentEscape = vi.fn();
  window.addEventListener('keydown', parentEscape);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  window.removeEventListener('keydown', parentEscape);
  expect(parentEscape).not.toHaveBeenCalled();
});

it('keeps Topic message actions distinct from the Composer input options', async () => {
  await act(async () =>
    root.render(
      <TopicPanel
        thread={{ root: rootEvent, replies: [] }}
        namespace="fixture"
        delivery={{ kind: 'idle' }}
        onClose={vi.fn()}
        onReturnToSource={vi.fn()}
        onOpenMember={vi.fn()}
        onSend={vi.fn(async () => undefined)}
        participants={[participant]}
        humans={[]}
        works={[]}
        allWorks={[]}
        currentHumanId={participant.humanId}
        humanNames={{ [participant.humanId]: 'You' }}
        canSteward
        onProposeWork={vi.fn()}
        onCommitWork={vi.fn()}
        onDeclineWork={vi.fn()}
        onAcceptWorkResult={vi.fn()}
        onCompleteWork={vi.fn()}
        onCreateVote={vi.fn(async () => undefined)}
        onSetReaction={vi.fn()}
      />,
    ),
  );

  expect(container.querySelectorAll('button[aria-label="更多消息动作"]')).toHaveLength(1);
  expect(container.querySelectorAll('button[aria-label="更多输入选项"]')).toHaveLength(1);
});

it('binds Topic actions and reaction picker to the exact reply event', async () => {
  const onProposeWork = vi.fn();
  const onSetReaction = vi.fn(async () => undefined);
  const onCreateVote = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <TopicPanel
        thread={thread}
        replyRequest={{ eventId: thread.root.eventId }}
        namespace="fixture"
        delivery={{ kind: 'idle' }}
        onClose={vi.fn()}
        onReturnToSource={vi.fn()}
        onOpenMember={vi.fn()}
        onSend={vi.fn(async () => undefined)}
        participants={[participant]}
        humans={[]}
        works={[]}
        allWorks={[]}
        currentHumanId={participant.humanId}
        humanNames={{ [participant.humanId]: 'You' }}
        canSteward
        onProposeWork={onProposeWork}
        onCommitWork={vi.fn()}
        onDeclineWork={vi.fn()}
        onAcceptWorkResult={vi.fn()}
        onCompleteWork={vi.fn()}
        onCreateVote={onCreateVote}
        onSetReaction={onSetReaction}
      />,
    ),
  );

  expect(document.activeElement).toBe(container.querySelector('textarea[aria-label="回复 You 的消息"]'));

  const replyInteraction = interactionFor(replyEvent.eventId);

  const reactionTrigger = button(replyInteraction, '添加回应');
  const moreTrigger = button(replyInteraction, '更多消息动作');
  await click(reactionTrigger);
  await click(button(replyInteraction, '用 🐾 回应'));
  expect(onSetReaction).toHaveBeenCalledWith(replyEvent.eventId, '🐾', true);
  expect(document.activeElement).toBe(moreTrigger);

  await click(moreTrigger);
  await click(button(replyInteraction, '整理为工作'));
  expect(onProposeWork).toHaveBeenCalledWith(replyEvent.eventId);

  await click(button(replyInteraction, '更多消息动作'));
  await click(button(replyInteraction, '发起随手投票'));
  const draft = replyInteraction.querySelector<HTMLFormElement>('[aria-label="随手问问草稿"]');
  if (!draft) throw new Error('Expected informal vote draft');
  const question = draft.querySelector<HTMLInputElement>('[aria-label="投票问题"]');
  if (!question) throw new Error('Expected informal vote question');
  expect(question.value).toBe(replyEvent.body);
});
