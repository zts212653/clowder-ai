import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { deleteSendAttempt, type SendAttempt, saveSendAttempt } from '@/utils/send-attempt-db';
import { ChatInput } from '../ChatInput';
import { observeComposerDraft } from '../composer-draft-flush-registry';
import { getThreadDraft, syncDraftToStorage } from '../thread-drafts';

vi.mock('@/hooks/useVoiceInput', () => ({ useVoiceInput: () => ({ state: 'idle', transcript: '', error: null }) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: vi.fn(async () => new Response('{}')) }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  observeApiSessionOwner(null);
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async () => new Response('{}'));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  syncDraftToStorage('draft-prepare', undefined);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it.each([
  true,
  false,
])('retains the correct recovery owner when clearing the remote draft fails: local attempt %s', async (localDurableAttempt) => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const text = '这份正文已经移交给持久气泡';
  const threadId = 'draft-prepare';
  useChatStore.setState({
    currentThreadId: threadId,
    hasActiveInvocation: false,
    activeInvocations: {},
    catInvocations: {},
    targetCats: [],
    pendingChatInsert: null,
    replyToMessage: null,
  });
  syncDraftToStorage(threadId, text);
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'DELETE'
      ? new Response('{}', { status: 503 })
      : new Response(JSON.stringify({ draft: { text, revision: 1 }, revision: 1 })),
  );
  let prepared: ((localDurableAttempt: boolean) => void) | undefined;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ChatInput
        threadId={threadId}
        localSendFeedback
        onSend={(...args) => {
          prepared = args[7];
          return new Promise(() => {});
        }}
      />,
    ),
  );
  await act(async () =>
    host
      .querySelector('textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
  await act(async () => prepared?.(localDurableAttempt));
  await act(async () => {
    await vi.waitFor(() =>
      expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true),
    );
  });
  expect(getThreadDraft(threadId)).toBe(localDurableAttempt ? '' : text);
});

it.each([
  false,
  true,
])('preserves typing during local persistence and never refills on a lost response: prepend %s', async (prepend) => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useChatStore.setState({
    currentThreadId: 'draft-prepare',
    hasActiveInvocation: false,
    activeInvocations: {},
    catInvocations: {},
    targetCats: [],
    pendingChatInsert: null,
    replyToMessage: null,
  });
  syncDraftToStorage('draft-prepare', '已经发送的句子');
  let prepared: ((localDurableAttempt: boolean) => void) | undefined;
  let finish: (accepted: boolean) => void;
  const onSend = vi.fn<Parameters<typeof ChatInput>[0]['onSend']>((...args) => {
    prepared = args[7];
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ChatInput threadId="draft-prepare" localSendFeedback onSend={onSend} />));
  const enter = () =>
    host
      .querySelector('textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await act(async () => {
    enter();
    enter();
  });
  expect(onSend).toHaveBeenCalledOnce();
  expect(getThreadDraft('draft-prepare')).toBe('已经发送的句子');
  const remaining = prepend ? '继续写下一条 ' : ' 继续写下一条';
  await act(async () =>
    syncDraftToStorage('draft-prepare', prepend ? remaining + '已经发送的句子' : '已经发送的句子' + remaining),
  );
  await act(async () => prepared?.(true));
  expect(getThreadDraft('draft-prepare')).toBe(remaining);
  const firstFinish = finish!;
  await act(async () => enter());
  expect(onSend).toHaveBeenCalledTimes(2);
  await act(async () => firstFinish(false));
  await act(async () => enter());
  expect(onSend).toHaveBeenCalledTimes(2);
  expect(getThreadDraft('draft-prepare')).toBe(remaining);
  await act(async () => {
    prepared?.(true);
    finish!(false);
  });
});

it.each([
  { owner: 'restore-owner', revision: 1, typed: '', expected: '' },
  { owner: 'restore-owner', revision: 1, typed: '下一条新输入', expected: '下一条新输入' },
  { owner: 'restore-owner', revision: 2, typed: '', expected: '远端正文' },
  { owner: 'another-owner', revision: 1, typed: '', expected: '远端正文' },
  { owner: 'restore-owner', revision: 1, typed: '', serverText: '不同的草稿', expected: '不同的草稿' },
  { owner: 'restore-owner', revision: 1, typed: '', serverReply: 'new-reply', expected: '远端正文' },
  { owner: 'restore-owner', revision: 1, typed: '', noRevision: true, expected: '远端正文' },
  { owner: 'restore-owner', revision: 1, typed: '', canceled: true, expected: '' },
])('restores drafts by exact owner and revision: $owner / $revision / $typed', async ({
  owner,
  revision,
  typed,
  expected,
  serverText = '远端正文',
  serverReply,
  noRevision,
  canceled,
}) => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const threadId = 'draft-prepare';
  const attempt: SendAttempt = {
    id: 'restore-attempt',
    ownerUserId: 'restore-owner',
    threadId,
    content: '远端正文',
    files: [],
    timestamp: 10,
    status: canceled ? 'canceled' : 'unknown',
    composerDraftRevision: noRevision ? undefined : 1,
  };
  await saveSendAttempt(attempt);
  observeApiSessionOwner(owner);
  useChatStore.setState({ currentThreadId: threadId, replyToMessage: null });
  syncDraftToStorage(threadId, typed);
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify({ draft: { text: serverText, revision, replyTo: serverReply }, revision })),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  try {
    await act(async () => root.render(<ChatInput threadId={threadId} localSendFeedback onSend={() => false} />));
    // Resolve the actual owner's hydration and its IndexedDB lookup, not a fixed delay.
    await act(async () => {
      await vi.waitFor(() => expect(observeComposerDraft(threadId)?.ready).toBe(true));
    });
    expect(getThreadDraft(threadId) ?? '').toBe(expected);
  } finally {
    await deleteSendAttempt(attempt);
  }
});
import 'fake-indexeddb/auto';
