// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Composer } from '../Composer.js';
import type { CollectiveParticipant } from '../client-types.js';

const participant: CollectiveParticipant = {
  serviceInstanceId: 'svc_aaaaaaaa',
  collectiveId: 'col_aaaaaaaa',
  connectionId: 'con_aaaaaaaa',
  endpointId: 'ep_aaaaaaaa',
  endpointLabel: 'You 的 Café',
  humanId: 'human_aaaaaaaa',
  humanDisplayName: 'You',
  catId: 'codex-astra',
  displayName: '砚砚',
  participationRevision: 1,
  channelIds: ['general'],
  availability: 'declared',
};
let container: HTMLDivElement;
let root: Root;
const send = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  send.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = async (participants = [participant]) =>
  act(async () =>
    root.render(
      <Composer
        placeholder="在频道里说点什么"
        channelId="general"
        namespace="mention-test"
        participants={participants}
        delivery={{ kind: 'idle' }}
        onSend={send}
      />,
    ),
  );
async function type(value: string) {
  await act(async () => {
    const input = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose() {
  const option = container.querySelector<HTMLButtonElement>('[role="option"]');
  expect(option?.textContent).toContain('砚砚');
  await act(async () => option!.click());
}

it('selects a current channel member with @ and submits its exact recipient independently of location', async () => {
  await render();
  await type('@砚');
  expect(container.querySelector('[role="listbox"]')).not.toBeNull();
  await choose();
  await type('请一起看这段讨论');
  await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(send).toHaveBeenCalledWith(
    '请一起看这段讨论',
    {
      kind: 'agent',
      humanId: 'human_aaaaaaaa',
      agentId: 'codex-astra',
      connectionId: 'con_aaaaaaaa',
      participationRevision: 1,
    },
    false,
    false,
  );
});

it('does not retarget a selected cat after its participation revision changes', async () => {
  await render();
  await type('@砚');
  await choose();
  await type('继续这项工作');
  await render([{ ...participant, participationRevision: 2 }]);
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/重新选择/);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
});

it('blocks an unconfirmed second mention instead of sending it to the previous cat', async () => {
  await render();
  await type('@砚');
  await choose();
  await type('这段请 @另外一只猫 看看');
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
});

it('lets a Human explicitly ask for a bounded response without naming or entrusting a Cat', async () => {
  await render();
  await type('这件事谁家在做？');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="更多输入选项"]')!.click());
  const responseRequest = [...container.querySelectorAll('label')].find((label) =>
    label.textContent?.includes('希望伙伴回应'),
  );
  expect(responseRequest).toBeDefined();
  const checkbox = responseRequest?.querySelector<HTMLInputElement>('input');
  expect(checkbox).toBeDefined();
  await act(async () => checkbox?.click());
  await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  expect(send).toHaveBeenCalledWith('这件事谁家在做？', { kind: 'channel' }, false, true);
});
