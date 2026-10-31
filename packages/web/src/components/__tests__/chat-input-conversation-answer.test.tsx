import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ChatInput } from '../ChatInput';
import { cardRef, record } from '../rich/__tests__/runtime-conversation-test-fixtures';
import { syncContextAttachmentDraftToStorage, syncDraftToStorage, threadReplyDrafts } from '../thread-drafts';

vi.mock('@/hooks/useVoiceInput', () => ({ useVoiceInput: () => ({ state: 'idle', transcript: '', error: null }) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root, container: HTMLDivElement;
const context = {
  interactionId: record.request.interactionId,
  expectedRevision: 5,
  operationId: 'bound-text-once',
  ownerUserId: 'owner',
  cardRef,
};
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useActiveExecutionStore.getState().reset();
  useChatStore.setState({
    currentThreadId: cardRef.threadId,
    hasActiveInvocation: false,
    activeInvocations: {},
    catInvocations: {},
    targetCats: [],
    pendingChatInsert: null,
    replyToMessage: null,
  });
  syncDraftToStorage(cardRef.threadId, 'Please use Alpha');
  syncContextAttachmentDraftToStorage(cardRef.threadId, []);
  threadReplyDrafts.delete(cardRef.threadId);
  useChatStore.getState().setReplyTo({
    id: cardRef.messageId,
    threadId: cardRef.threadId,
    content: 'Which environment?',
    senderCatId: 'codex61-sol',
    runtimeAnswerContext: context,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url === '/api/session') return json({ userId: 'owner' });
    if (String(url).endsWith('/respond'))
      return json({
        interaction: {
          ...record,
          status: 'answered',
          revision: 7,
          terminal: {
            status: 'answered',
            reasonCode: 'answered',
            settledAt: 10000,
            operationId: context.operationId,
            response: { kind: 'text' },
            responseMessageId: 'answer-text',
          },
        },
      });
    if (String(url).startsWith('/api/runtime-interactions/')) return json({ interaction: record });
    return json({ draft: null });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  syncDraftToStorage(cardRef.threadId, undefined);
  threadReplyDrafts.delete(cardRef.threadId);
  useChatStore.setState({ replyToMessage: null });
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
});
const json = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body }) as Response;
async function enter() {
  await act(async () =>
    container
      .querySelector('textarea')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
}
it.each([
  'classic',
  'v2',
] as const)('the %s composer binds text to one canonical answer and never double-sends ordinary chat', async (presentation) => {
  const send = vi.fn();
  await act(async () =>
    root.render(<ChatInput presentation={presentation} threadId={cardRef.threadId} onSend={send} />),
  );
  expect(container.textContent).toContain('Which environment?');
  await enter();
  expect(send).not.toHaveBeenCalled();
  const posts = vi
    .mocked(apiFetch)
    .mock.calls.filter(([url, options]) => String(url).endsWith('/respond') && options?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0][1]?.body))).toEqual({
    cardRef,
    expectedRevision: 5,
    operationId: context.operationId,
    response: { kind: 'text', text: 'Please use Alpha' },
  });
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  expect(useChatStore.getState().replyToMessage).toBeNull();
});
it('keeps the original text and reply context when the canonical writer rejects a stale answer', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation();
  if (!original) throw new Error('mock');
  vi.mocked(apiFetch).mockImplementation((url, options) =>
    String(url).endsWith('/respond') ? Promise.resolve(json({ error: 'stale' }, 409)) : original(url, options),
  );
  const send = vi.fn();
  await act(async () => root.render(<ChatInput presentation="v2" threadId={cardRef.threadId} onSend={send} />));
  await enter();
  expect(send).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Please use Alpha');
  expect(useChatStore.getState().replyToMessage?.runtimeAnswerContext).toEqual(context);
});
