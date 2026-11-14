import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { ChatInput } from '../ChatInput';
import { getThreadDraft, syncDraftToStorage } from '../thread-drafts';

vi.mock('@/hooks/useVoiceInput', () => ({ useVoiceInput: () => ({ state: 'idle', transcript: '', error: null }) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: vi.fn(async () => new Response('{}')) }));
let root: Root;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  syncDraftToStorage('draft-prepare', undefined);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('waits for local persistence, preserves typing during that wait, and never refills on a lost network response', async () => {
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
  let prepared: (() => void) | undefined;
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
  await act(async () => syncDraftToStorage('draft-prepare', '已经发送的句子 继续写下一条'));
  await act(async () => prepared?.());
  expect(getThreadDraft('draft-prepare')).toBe(' 继续写下一条');
  const firstFinish = finish!;
  await act(async () => enter());
  expect(onSend).toHaveBeenCalledTimes(2);
  await act(async () => firstFinish(false));
  await act(async () => enter());
  expect(onSend).toHaveBeenCalledTimes(2);
  expect(getThreadDraft('draft-prepare')).toBe(' 继续写下一条');
  await act(async () => {
    prepared?.();
    finish!(false);
  });
});
