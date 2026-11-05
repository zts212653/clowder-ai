import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { CloudBindingRecoveryCard } from '@/components/CloudBindingRecoveryCard';
import { CloudConversationLink } from '@/components/CloudConversationLink';
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
 * F202 h3c-1 (astra `a7caa34d99` P2-1): the recovery card and the thread panel write the same binding.
 * Whatever order their writes and answers arrive in, the card ends on the binding the Host holds —
 * never on an older answer, never by cutting its own operation short.
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
  // No retry authority: the card takes its connect-only path, with no delivery polling to hide a gap.
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

/** The conversation the card marks as the one connected to this thread. */
async function cardConnected(): Promise<string | undefined> {
  await openCardChoices();
  const rows = [...card().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  return rows.find((row) => row.closest('label')?.textContent?.includes('已连接当前对话'))?.value;
}

async function panelChangesTo(conversation: Candidate) {
  await click(buttonByText(panel(), '更换'));
  await click(radioFor(panel(), conversation.conversationId));
  await click(buttonByText(panel(), '改用这个会话'));
}

async function cardConnects(conversation: Candidate) {
  await openCardChoices();
  await click(radioFor(card(), conversation.conversationId));
  await click(card().querySelector<HTMLButtonElement>('[data-recovery-primary]'));
}

it('a panel write while the card’s own write is out does not leave the card on the older answer', async () => {
  await showBoth();
  const cardAnswer = gate();
  host.patchPlan = [{ commitThenHold: cardAnswer.promise }];

  await cardConnects(REVIEW);
  expect(host.bindings['gpt-pro']).toBe(REVIEW.chatUrl);
  await panelChangesTo(UNTITLED);
  expect(host.bindings['gpt-pro']).toBe(UNTITLED.chatUrl);

  await act(async () => cardAnswer.open());
  await flush(8);

  expect(await cardConnected()).toBe(UNTITLED.conversationId);
  expect(panel().querySelector('[data-route-status]')?.getAttribute('data-route-status')).toBe('connected');
  expect(panel().textContent).toContain(UNTITLED.conversationId);
});

it('a card write that fails while the panel writes still ends on the binding the Host holds', async () => {
  await showBoth();
  const cardFailure = gate();
  host.patchPlan = [{ commitThenFail: cardFailure.promise }];

  await cardConnects(REVIEW);
  await panelChangesTo(UNTITLED);
  await act(async () => cardFailure.open());
  await flush(8);

  expect(host.bindings['gpt-pro']).toBe(UNTITLED.chatUrl);
  expect(await cardConnected()).toBe(UNTITLED.conversationId);
});

it('a card write whose answer was lost is read back: it may have landed after all', async () => {
  await showBoth();
  host.patchPlan = ['lost'];

  await cardConnects(REVIEW);
  await flush(8);

  expect(host.bindings['gpt-pro']).toBe(REVIEW.chatUrl);
  expect(await cardConnected()).toBe(REVIEW.conversationId);
  const readBack = host.bindingReads().at(-1);
  expect(readBack?.options).toEqual({ afterCurrentGet: true });
});

it('a panel write during the card’s title refresh is not undone by the refresh’s older reading', async () => {
  await showBoth();
  const refreshRead = gate();
  host.readPlan = [{ gate: refreshRead.promise }];

  await click(buttonByText(card(), '刷新名称与发送状态'));
  await panelChangesTo(UNTITLED);
  await act(async () => refreshRead.open());
  await flush(8);

  expect(host.calls.some((call) => call.path.endsWith('/refresh-titles'))).toBe(true);
  expect(await cardConnected()).toBe(UNTITLED.conversationId);
});

it('a second change while the card is still reading the first is the one the card ends on', async () => {
  await showBoth();
  const firstRead = gate();

  await panelChangesTo(REVIEW);
  // The card's read of the first change is still out when the panel writes again.
  host.readPlan = [{ gate: firstRead.promise }];
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('cat-cafe:cloud-binding-changed', { detail: { threadId: host.threadId, source: 'elsewhere' } }),
    );
  });
  await panelChangesTo(UNTITLED);
  await act(async () => firstRead.open());
  await flush(8);

  expect(await cardConnected()).toBe(UNTITLED.conversationId);
});
