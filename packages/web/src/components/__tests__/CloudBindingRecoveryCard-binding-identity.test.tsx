import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { CloudBindingRecoveryCard } from '@/components/CloudBindingRecoveryCard';
import { announceCloudBindingChange } from '@/components/cloud-binding-events';
import { apiFetch } from '@/utils/api-client';
import {
  buttonByText,
  type Candidate,
  click,
  FakeHost,
  flush,
  gate,
  jsonResponse,
  REVIEW,
  radioFor,
  STARS,
  UNTITLED,
} from './cloud-route-test-fixtures';

/**
 * F202 h3c-1 (astra `d2f132f5c4` P2): the same recovery card can be shown for another identity — thread,
 * message, cat — while an operation of the previous one is still out. Nothing that operation started,
 * nor any read of the previous identity's binding, may reach the card as it is now.
 */

const mockApiFetch = vi.mocked(apiFetch);
let container: HTMLDivElement;
let root: Root;
let one: FakeHost;
let two: FakeHost;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  one = new FakeHost('thread-one');
  one.bindings = { 'gpt-pro': STARS.chatUrl };
  two = new FakeHost('thread-two');
  two.bindings = { 'gpt-pro': UNTITLED.chatUrl };
  mockApiFetch.mockReset();
  // No retry authority: the connect-only path, with no delivery polling to hide a gap.
  mockApiFetch.mockImplementation(async (path, init, options) => {
    const answer = one.handle(path, init, options) ?? two.handle(path, init, options);
    if (answer) return answer;
    return jsonResponse({ code: 'QUEUE_MESSAGE_NOT_FOUND' }, 404);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function showCard(threadId: string, targetCatId = 'gpt-pro') {
  await act(async () =>
    root.render(
      <CloudBindingRecoveryCard threadId={threadId} sourceMessageId={`${threadId}-source`} targetCatId={targetCatId} />,
    ),
  );
  await flush(5);
}

async function openChoices() {
  const toggle = buttonByText(container, '选择其他会话');
  if (toggle) await click(toggle);
}

/** The conversation the card marks as connected to its thread. */
async function marked(): Promise<string | undefined> {
  await openChoices();
  const rows = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  return rows.find((row) => row.closest('label')?.textContent?.includes('已连接当前对话'))?.value;
}

async function connect(conversation: Candidate) {
  await openChoices();
  await click(radioFor(container, conversation.conversationId));
  await click(container.querySelector<HTMLButtonElement>('[data-recovery-primary]'));
}

it('a write of the previous thread that lands late does not reach the card now showing another', async () => {
  const oldAnswer = gate();
  one.patchPlan = [{ commitThenHold: oldAnswer.promise }];
  await showCard('thread-one');
  await connect(REVIEW);
  expect(one.bindings['gpt-pro']).toBe(REVIEW.chatUrl);

  await showCard('thread-two');
  expect(await marked()).toBe(UNTITLED.conversationId);
  await act(async () => oldAnswer.open());
  await flush(8);

  expect(two.bindings['gpt-pro']).toBe(UNTITLED.chatUrl);
  expect(await marked()).toBe(UNTITLED.conversationId);
});

it('a write of the previous thread that fails late does not read that thread into the card', async () => {
  const oldFailure = gate();
  one.patchPlan = [{ commitThenFail: oldFailure.promise }];
  await showCard('thread-one');
  await connect(REVIEW);

  await showCard('thread-two');
  expect(await marked()).toBe(UNTITLED.conversationId);
  const readsBefore = one.bindingReads().length;
  await act(async () => oldFailure.open());
  await flush(8);

  expect(one.bindingReads().length).toBe(readsBefore);
  expect(await marked()).toBe(UNTITLED.conversationId);
});

it('a read of the previous thread’s binding still in flight does not land in the card', async () => {
  await showCard('thread-one');
  const oldRead = gate();
  one.readPlan = [{ gate: oldRead.promise }];
  one.bindings['gpt-pro'] = REVIEW.chatUrl;
  await act(async () => announceCloudBindingChange('thread-one', 'thread-panel'));

  await showCard('thread-two');
  expect(await marked()).toBe(UNTITLED.conversationId);
  await act(async () => oldRead.open());
  await flush(8);

  expect(await marked()).toBe(UNTITLED.conversationId);
});

it('a write for another cat of the same thread does not reach the card once it shows this cat', async () => {
  one.bindings = { 'gpt-pro': STARS.chatUrl, 'cloud-alt': UNTITLED.chatUrl };
  const oldAnswer = gate();
  one.patchPlan = [{ commitThenHold: oldAnswer.promise }];
  await showCard('thread-one', 'gpt-pro');
  await connect(REVIEW);

  await showCard('thread-one', 'cloud-alt');
  expect(await marked()).toBe(UNTITLED.conversationId);
  await act(async () => oldAnswer.open());
  await flush(8);

  expect(one.bindings['cloud-alt']).toBe(UNTITLED.chatUrl);
  expect(await marked()).toBe(UNTITLED.conversationId);
});

it('the previous identity’s operation ending does not take the current identity’s write with it', async () => {
  const oldAnswer = gate();
  const newAnswer = gate();
  one.patchPlan = [{ commitThenHold: oldAnswer.promise }];
  two.patchPlan = [{ commitThenHold: newAnswer.promise }];
  await showCard('thread-one');
  await connect(REVIEW);

  await showCard('thread-two');
  await connect(STARS);
  expect(two.bindings['gpt-pro']).toBe(STARS.chatUrl);
  // Another surface writes thread two after the card's write landed, while its answer is still out.
  two.bindings['gpt-pro'] = REVIEW.chatUrl;
  await act(async () => announceCloudBindingChange('thread-two', 'thread-panel'));

  await act(async () => oldAnswer.open());
  await flush(4);
  await act(async () => newAnswer.open());
  await flush(8);

  // The answer (STARS) is stale; the card read thread two back instead.
  expect(await marked()).toBe(REVIEW.conversationId);
});
