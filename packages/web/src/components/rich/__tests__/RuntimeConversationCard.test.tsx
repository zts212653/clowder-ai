import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { RichBlocks } from '../RichBlocks';
import { RuntimeConversationCard } from '../RuntimeConversationCard';
import { readConversationRecord } from '../runtime-conversation-model';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { binding, block, cardRef, record, request } from './runtime-conversation-test-fixtures';

const BoundBlocks = RichBlocks as React.ComponentType<
  React.ComponentProps<typeof RichBlocks> & { runtimeInteractionCard: typeof binding }
>;
let root: Root;
let container: HTMLDivElement;
let sends: string[];
const onSend = (event: Event) => sends.push((event as CustomEvent<{ text: string }>).detail.text);
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sends = [];
  useChatStore.setState({ replyToMessage: null });
  window.addEventListener('cat-cafe:interactive-send', onSend);
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (url === '/api/session') return response({ userId: 'owner' });
    if (options?.method === 'POST')
      return response({
        interaction: {
          ...record,
          revision: 7,
          status: 'answered',
          terminal: {
            operationId: JSON.parse(String(options.body)).operationId,
            status: 'answered',
            reasonCode: 'answered',
            settledAt: 10000,
            response: { kind: 'selection', selectedIds: ['alpha'] },
            responseMessageId: 'answer-one',
          },
        },
      });
    return response({ interaction: record });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.removeEventListener('cat-cafe:interactive-send', onSend);
  vi.unstubAllGlobals();
  vi.mocked(apiFetch).mockReset();
});
function response(body: unknown, status = 200): Response {
  return { ok: status === 200, status, json: async () => body } as Response;
}
function button(text: string) {
  const b = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  expect(b).toBeDefined();
  if (!b) throw new Error(text);
  return b;
}
async function render() {
  await act(async () =>
    root.render(
      <BoundBlocks
        blocks={[block]}
        messageId={cardRef.messageId}
        sourceThreadId={cardRef.threadId}
        catId="codex61-sol"
        runtimeInteractionCard={binding}
      />,
    ),
  );
}
it('shows the actual public default selection as a gray result, without a response writer', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    url === '/api/session'
      ? response({ userId: 'owner' })
      : response({
          interaction: {
            ...record,
            status: 'answered',
            terminal: {
              status: 'answered',
              reasonCode: 'defaulted',
              settledAt: 10000,
              response: { kind: 'selection', selectedIds: ['alpha'] },
            },
          },
        }),
  );
  await render();
  const result = container.querySelector('[data-testid="decision-result-label"]');
  expect(result?.textContent).toMatch(/^(?:Chose “Alpha”|已选「Alpha」)/);
  expect(container.querySelector('[data-testid="decision-result-dot"]')?.getAttribute('data-status')).toBe('closed');
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
it('submits the server-bound original block through one canonical CAS writer, never ordinary chat/block-state', async () => {
  await render();
  await act(async () => button('Alpha').click());
  await act(async () => button('确认选择').click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe('/api/runtime-interactions/conversation-one/respond');
  const body = JSON.parse(String(posts[0][1]?.body));
  expect(body).toMatchObject({ expectedRevision: 5, cardRef, response: { kind: 'selection', selectedIds: ['alpha'] } });
  expect(body.operationId).toEqual(expect.any(String));
  expect(body.operationId.length).toBeGreaterThan(0);
  expect(sends).toEqual([]);
  expect(container.querySelector('[data-testid=conversation-decision-result]')?.textContent).toContain('已选「Alpha」');
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('block-state'))).toBe(false);
});
it('does not turn an unbound ordinary guide or navigation card into a runtime decision', async () => {
  await act(async () => root.render(<RichBlocks blocks={[block]} messageId="ordinary" sourceThreadId="thread-one" />));
  await act(async () => button('Alpha').click());
  await act(async () => button('确认选择').click());
  expect(sends).toHaveLength(1);
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/runtime-interactions/'))).toBe(false);
});

it.each([
  'foreign-owner',
  'foreign-thread',
  'foreign-message',
  'foreign-cat',
  'different-question',
  'missing-digest',
  'missing-publication',
  'missing-source',
  'provider-binding',
] as const)('refuses %s without admitting an ordinary fallback', async (kind) => {
  const bad = {
    ...record,
    request: { ...request, owner: { ...request.owner }, presentation: { ...block } },
    cardRef: { ...cardRef },
  };
  if (kind === 'foreign-owner') bad.request.owner.userId = 'other';
  if (kind === 'foreign-thread') bad.cardRef!.threadId = 'elsewhere';
  if (kind === 'foreign-message') bad.cardRef!.messageId = 'copy';
  if (kind === 'foreign-cat') bad.request.owner.catId = 'other';
  if (kind === 'different-question') bad.request.presentation.title = 'Changed question';
  if (kind === 'missing-digest') delete (bad.cardRef as unknown as Record<string, unknown>).blockDigest;
  if (kind === 'missing-publication') delete (bad.cardRef as unknown as Record<string, unknown>).publishedAt;
  if (kind === 'missing-source') delete (bad as unknown as Record<string, unknown>).source;
  if (kind === 'provider-binding')
    (bad as unknown as Record<string, unknown>).returnBinding = { kind: 'provider_waiter' };
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    url === '/api/session' ? response({ userId: 'owner' }) : response({ interaction: bad }),
  );
  await render();
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('[data-testid="runtime-conversation-card"] button')]
      .filter((b) => !b.disabled)
      .map((b) => b.textContent),
  ).toEqual(['重新读取']);
  expect(vi.mocked(apiFetch).mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
  expect(sends).toEqual([]);
});
it('binds text to the original reply and retains the complete CAS coordinates', async () => {
  await render();
  await act(async () => button('用文字回答').click());
  expect(useChatStore.getState().replyToMessage).toMatchObject({
    id: cardRef.messageId,
    threadId: cardRef.threadId,
    runtimeAnswerContext: { interactionId: binding.interactionId, expectedRevision: 5, cardRef, ownerUserId: 'owner' },
  });
  expect(vi.mocked(apiFetch).mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
});
it('checks the live Inbox read again after the canonical GET and before the POST', async () => {
  let current = true;
  const get = vi.mocked(apiFetch).getMockImplementation();
  if (!get) throw new Error('mock');
  await act(async () =>
    root.render(
      <RuntimeConversationCard
        block={block}
        binding={binding}
        messageId={cardRef.messageId}
        sourceThreadId={cardRef.threadId}
        catId="codex61-sol"
        host={{ ownerUserId: 'owner', revision: 5, cardRef, readCurrent: true, verifyCurrentRead: () => current }}
      />,
    ),
  );
  vi.mocked(apiFetch).mockImplementation(async (url, opts) => {
    const result = await get(url, opts);
    if (url !== '/api/session' && !opts?.method) current = false;
    return result;
  });
  await act(async () => button('Alpha').click());
  await act(async () => button('确认选择').click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
});
it('rejects a terminal-looking record whose source provenance is missing', () => {
  expect(
    readConversationRecord({
      ...record,
      status: 'answered',
      terminal: { status: 'answered', settledAt: 1000 },
      source: undefined,
    }),
  ).toBeNull();
});
it('a controlled confirm block exposes only the producer-declared choices', async () => {
  const confirm = { ...block, interactiveType: 'confirm' as const, options: [{ id: 'continue', label: 'Continue' }] };
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    url === '/api/session'
      ? response({ userId: 'owner' })
      : response({ interaction: { ...record, request: { ...request, presentation: confirm } } }),
  );
  await act(async () =>
    root.render(
      <RuntimeConversationCard
        block={confirm}
        binding={binding}
        messageId={cardRef.messageId}
        sourceThreadId={cardRef.threadId}
        catId="codex61-sol"
      />,
    ),
  );
  const choices = [...container.querySelectorAll<HTMLButtonElement>('[data-message-navigation-response] button')]
    .filter((b) => !b.disabled)
    .map((b) => b.textContent?.trim());
  expect(choices).toEqual(['Continue']);
});
