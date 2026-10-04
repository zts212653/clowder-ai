// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollectiveVoteProjection } from '../client-types.js';
import { InformalVoteCard, VoteCreator } from '../VoteCard.js';

const vote: CollectiveVoteProjection = {
  v: 1,
  serviceInstanceId: 'svc_aaaaaaaa',
  collectiveId: 'col_aaaaaaaa',
  voteId: 'vote_aaaaaaaa',
  sourceEventId: 'evt_aaaaaaaa',
  sourceLocation: { channelId: 'general' },
  kind: 'informal_poll',
  effect: 'preference_only',
  eligibility: 'current_members',
  ballotVisibility: 'named',
  question: '候选版本周四还是周五交付？',
  options: [
    { optionId: 'vote_option_aaaaaaaa', label: '周四' },
    { optionId: 'vote_option_bbbbbbbb', label: '周五' },
  ],
  ballots: [
    {
      humanId: 'human_aaaaaaaa',
      displayName: 'You',
      optionId: 'vote_option_aaaaaaaa',
      castAt: '2026-09-13T00:05:00.000Z',
    },
    {
      humanId: 'human_bbbbbbbb',
      displayName: 'Member',
      optionId: 'vote_option_bbbbbbbb',
      castAt: '2026-09-13T00:06:00.000Z',
    },
  ],
  createdBy: { humanId: 'human_aaaaaaaa', displayName: 'You' },
  closesAt: '2026-09-14T00:00:00.000Z',
  lifecycle: 'open',
  status: 'open',
  revision: 3,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:06:00.000Z',
  history: [
    {
      revision: 1,
      action: 'created',
      actor: { humanId: 'human_aaaaaaaa', displayName: 'You' },
      at: '2026-09-13T00:00:00.000Z',
    },
  ],
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

async function input(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  expect(element).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, value);
    element?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('renders named preference counts, lets a member change one ballot, and keeps close authority visible', async () => {
  const onCast = vi.fn();
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <InformalVoteCard
        vote={vote}
        currentHumanId="human_bbbbbbbb"
        canSteward={false}
        onCast={onCast}
        onClose={onClose}
      />,
    ),
  );
  expect(container.textContent).toContain('随手问问 · 不形成决定');
  expect(container.textContent).toContain('实名 · 当前成员可参与');
  expect(container.textContent).toContain('You');
  expect(container.textContent).toContain('Member');
  expect(container.querySelector('[aria-pressed="true"]')?.textContent).toContain('周五');
  expect(container.textContent).not.toContain('结束投票');
  await click('周四');
  expect(onCast).toHaveBeenCalledWith(vote, vote.options[0]?.optionId);

  await act(async () =>
    root.render(
      <InformalVoteCard
        vote={vote}
        currentHumanId="human_aaaaaaaa"
        canSteward={false}
        onCast={onCast}
        onClose={onClose}
      />,
    ),
  );
  await click('结束投票');
  expect(onClose).toHaveBeenCalledWith(vote);
});

it('creates a compact source-linked poll draft without exposing a binding mode', async () => {
  const onCreate = vi.fn(async () => undefined);
  await act(async () =>
    root.render(<VoteCreator sourceEventId="evt_aaaaaaaa" sourceBody={vote.question} onCreate={onCreate} />),
  );
  await click('发起随手投票');
  expect(container.textContent).toContain('只表达偏好，不会形成 Decision');
  expect(container.textContent).not.toContain('有约束力');
  await input('投票选项 1', '周四');
  await input('投票选项 2', '周五');
  await click('发布投票');
  expect(onCreate).toHaveBeenCalledWith(
    'evt_aaaaaaaa',
    expect.objectContaining({ question: vote.question, options: ['周四', '周五'] }),
  );
});
