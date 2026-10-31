// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChannelMessage } from '../ChannelMessage.js';
import type { ChannelThread, CollectiveEventEnvelope, CollectiveReactionSummary } from '../client-types.js';

const event: CollectiveEventEnvelope = {
  serviceInstanceId: 'svc_aaaaaaaa',
  collectiveId: 'col_aaaaaaaa',
  eventId: 'evt_aaaaaaaa',
  clientEventId: 'reaction-message',
  sequence: 1,
  actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'You' },
  target: { kind: 'channel', channelId: 'general' },
  location: { channelId: 'general' },
  recipient: { kind: 'channel' },
  body: '我们继续把这个方向做实。',
  acceptedAt: '2026-09-13T20:00:00.000Z',
};
const thread: ChannelThread = { root: event, replies: [] };
const reaction: CollectiveReactionSummary = {
  serviceInstanceId: event.serviceInstanceId,
  collectiveId: event.collectiveId,
  eventId: event.eventId,
  emoji: '🐾',
  humanIds: ['human_aaaaaaaa', 'human_bbbbbbbb'],
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

it('shows named persistent reactions and sets an explicit desired state instead of blind toggling', async () => {
  const onSetReaction = vi.fn();
  await act(async () =>
    root.render(
      <ChannelMessage
        thread={thread}
        onOpenTopic={vi.fn()}
        onMention={vi.fn()}
        onOpenMember={vi.fn()}
        currentHumanId="human_aaaaaaaa"
        humanNames={{ human_aaaaaaaa: 'You', human_bbbbbbbb: 'Member' }}
        reactions={[reaction]}
        onSetReaction={onSetReaction}
      />,
    ),
  );

  const paw = container.querySelector<HTMLButtonElement>('button.reaction-chip');
  expect(paw).not.toBeNull();
  expect(paw?.getAttribute('aria-label')).toBe('🐾 · You、Member');
  expect(paw?.getAttribute('aria-pressed')).toBe('true');
  expect(paw?.textContent).toContain('2');
  await act(async () => paw?.click());
  expect(onSetReaction).toHaveBeenCalledWith(event.eventId, '🐾', false);

  const open = container.querySelector<HTMLButtonElement>('[aria-label="添加回应"]');
  await act(async () => open?.click());
  const thumb = [...container.querySelectorAll<HTMLButtonElement>('.reaction-picker button')].find(
    (button) => button.getAttribute('aria-label') === '用 👍 回应',
  );
  expect(thumb).not.toBeNull();
  await act(async () => thumb?.click());
  expect(onSetReaction).toHaveBeenCalledWith(event.eventId, '👍', true);
  expect(document.activeElement).toBe(container.querySelector('[aria-label="更多消息动作"]'));
});

it('returns focus to the stable add control when the final chip disappears', async () => {
  const onSetReaction = vi.fn(async () => undefined);
  const render = (reactions: CollectiveReactionSummary[]) =>
    root.render(
      <ChannelMessage
        thread={thread}
        onOpenTopic={vi.fn()}
        onMention={vi.fn()}
        onOpenMember={vi.fn()}
        reactions={reactions}
        currentHumanId="human_aaaaaaaa"
        humanNames={{ human_aaaaaaaa: 'You' }}
        onSetReaction={onSetReaction}
      />,
    );
  await act(async () => render([{ ...reaction, humanIds: ['human_aaaaaaaa'] }]));
  const chip = container.querySelector<HTMLButtonElement>('.reaction-chip');
  const more = container.querySelector<HTMLButtonElement>('[aria-label="更多消息动作"]');
  chip?.focus();
  expect(document.activeElement).toBe(chip);
  await act(async () => chip?.click());
  await act(async () => render([]));
  expect(document.activeElement).toBe(more);
});

it('shows visible pending and retry state for the first touch-more reaction without double submission', async () => {
  let rejectFirst: ((reason: Error) => void) | undefined;
  const onSetReaction = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    )
    .mockResolvedValueOnce(undefined);
  const render = (reactions: CollectiveReactionSummary[]) =>
    root.render(
      <ChannelMessage
        thread={{ root: { ...event, body: '喵' }, replies: [] }}
        onOpenTopic={vi.fn()}
        onMention={vi.fn()}
        onOpenMember={vi.fn()}
        reactions={reactions}
        currentHumanId="human_aaaaaaaa"
        humanNames={{ human_aaaaaaaa: 'You' }}
        onSetReaction={onSetReaction}
      />,
    );
  await act(async () => render([]));

  const more = container.querySelector<HTMLButtonElement>('[aria-label="更多消息动作"]');
  expect(more).not.toBeNull();
  await act(async () => more?.click());
  const reactionMenuItem = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === '用表情回应',
  );
  expect(reactionMenuItem).not.toBeNull();
  await act(async () => reactionMenuItem?.click());
  const reactionChoice = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === '用 🐾 回应',
    );
  const firstChoice = reactionChoice();
  expect(firstChoice).not.toBeNull();
  await act(async () => firstChoice?.click());
  await act(async () => Promise.resolve());

  expect(onSetReaction).toHaveBeenCalledTimes(1);
  expect(container.querySelector('.reaction-bar')?.getAttribute('aria-busy')).toBe('true');
  expect(container.querySelector('.reaction-pending')?.textContent).toContain('🐾 回应正在保存');

  await act(async () => more?.click());
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === '用表情回应')
      ?.click(),
  );
  const pendingChoice = reactionChoice();
  expect(pendingChoice?.disabled).toBe(true);
  await act(async () => pendingChoice?.click());
  expect(onSetReaction).toHaveBeenCalledTimes(1);

  await act(async () => rejectFirst?.(new Error('offline')));
  expect(container.querySelector('.reaction-bar')?.getAttribute('aria-busy')).toBe('false');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('回应未保存，请重试。');
  expect(reactionChoice()).toBeUndefined();
  expect(document.activeElement).toBe(more);

  await act(async () => more?.click());
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === '用表情回应')
      ?.click(),
  );
  await act(async () => reactionChoice()?.click());
  expect(onSetReaction).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => render([{ ...reaction, humanIds: ['human_aaaaaaaa'] }]));
  expect(container.querySelector('.reaction-chip')?.textContent).toBe('🐾1');
});
