import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { CloudBindingRecoveryCard } from '@/components/CloudBindingRecoveryCard';
import { CloudConversationLink } from '@/components/CloudConversationLink';
import { apiFetch } from '@/utils/api-client';
import {
  buttonByText,
  click,
  FakeHost,
  flush,
  jsonResponse,
  REVIEW,
  radioFor,
  STARS,
} from './cloud-route-test-fixtures';

/**
 * F202 h3c-1: a message's recovery card and the thread panel can be on screen together, over the same
 * binding. Their choices must not interfere, and a write in either shows in both.
 */

const mockApiFetch = vi.mocked(apiFetch);
let container: HTMLDivElement;
let root: Root;
let host: FakeHost;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  host = new FakeHost();
  host.bindings = { 'gpt-pro': STARS.chatUrl };
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation(async (path, init, options) => {
    const answer = host.handle(path, init, options);
    if (answer) return answer;
    if (String(path).endsWith('/retry-authority')) return jsonResponse({ code: 'QUEUE_MESSAGE_NOT_FOUND' }, 404);
    return jsonResponse({ error: 'not found' }, 404);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function showBoth() {
  await act(async () =>
    root.render(
      <>
        <div data-surface="panel">
          <CloudConversationLink threadId={host.threadId} />
        </div>
        <div data-surface="card">
          <CloudBindingRecoveryCard threadId={host.threadId} sourceMessageId="source-1" targetCatId="gpt-pro" />
        </div>
      </>,
    ),
  );
  await flush(5);
}

const panel = () => container.querySelector<HTMLElement>('[data-surface="panel"]') as HTMLElement;
const card = () => container.querySelector<HTMLElement>('[data-surface="card"]') as HTMLElement;

async function openCardChoices() {
  const toggle = buttonByText(card(), '选择其他会话');
  if (toggle) await click(toggle);
}

it('gives the panel and the card separate radio groups, so choosing in one leaves the other alone', async () => {
  await showBoth();
  await click(buttonByText(panel(), '更换'));
  await openCardChoices();

  const panelNames = new Set([...panel().querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => r.name));
  const cardNames = new Set([...card().querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => r.name));
  expect(panelNames.size).toBe(1);
  expect(cardNames.size).toBe(1);
  expect([...panelNames][0]).not.toBe([...cardNames][0]);

  await click(radioFor(panel(), REVIEW.conversationId));
  await click(radioFor(card(), STARS.conversationId));
  expect(radioFor(panel(), REVIEW.conversationId)?.checked).toBe(true);
  expect(radioFor(card(), STARS.conversationId)?.checked).toBe(true);
});

it('shows the panel’s write in the card', async () => {
  await showBoth();
  expect(card().textContent).toContain('已连接');

  await click(buttonByText(panel(), '更换'));
  await click(radioFor(panel(), REVIEW.conversationId));
  await click(buttonByText(panel(), '改用这个会话'));
  await flush(5);

  expect(panel().textContent).toContain(REVIEW.displayTitle);
  // The card read the binding again after the panel's write, with a read that starts after it.
  const cardReads = host.bindingReads().filter((read) => read.options !== undefined);
  expect(cardReads.length).toBeGreaterThan(0);
  await openCardChoices();
  const reviewRow = radioFor(card(), REVIEW.conversationId)?.closest('label');
  expect(reviewRow?.textContent).toContain('已连接当前对话');
});

it('shows the card’s write in the panel', async () => {
  host.bindings = {};
  await showBoth();
  expect(panel().querySelector('[data-route-status]')?.getAttribute('data-route-status')).toBe('unconnected');

  await openCardChoices();
  await click(radioFor(card(), REVIEW.conversationId));
  await click(card().querySelector<HTMLButtonElement>('[data-recovery-primary]'));
  await flush(5);

  expect(host.bindings['gpt-pro']).toBe(REVIEW.chatUrl);
  expect(panel().querySelector('[data-route-status]')?.getAttribute('data-route-status')).toBe('connected');
  expect(panel().textContent).toContain(REVIEW.displayTitle);
});

it('gives every recovery card its own radio group too', async () => {
  host.bindings = {};
  await act(async () =>
    root.render(
      <>
        <CloudBindingRecoveryCard threadId={host.threadId} sourceMessageId="source-1" targetCatId="gpt-pro" />
        <CloudBindingRecoveryCard threadId={host.threadId} sourceMessageId="source-2" targetCatId="gpt-pro" />
      </>,
    ),
  );
  await flush(5);

  const names = new Set([...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => r.name));
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(6);
  expect(names.size).toBe(2);
});
