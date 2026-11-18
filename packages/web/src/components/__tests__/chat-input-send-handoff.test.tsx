import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useChatStore } from '@/stores/chatStore';
import { withSendAttempts } from '@/stores/send-attempt-projection';
import { putSendAttempt, useSendAttemptStore } from '@/stores/send-attempt-store';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import * as attemptDb from '@/utils/send-attempt-db';
import { ChatInput } from '../ChatInput';
import { observeComposerDraft } from '../composer-draft-flush-registry';
import { SendAttemptStatus } from '../SendAttemptStatus';
import { syncDraftToStorage, threadImageDrafts } from '../thread-drafts';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch }));
vi.mock('@/hooks/useChatCommands', () => ({ useChatCommands: () => ({ processCommand: async () => false }) }));
vi.mock('@/hooks/useVoiceInput', () => ({ useVoiceInput: () => ({ state: 'idle', transcript: '', error: null }) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));

const threadId = 'send-handoff';
const text = '这份正文和附件只应展示在一处';
let root: Root;
let host: HTMLDivElement;
let pending: Promise<boolean> | undefined;
let releaseSave: () => void;
let rejectSave: (error: Error) => void;
let responses: ((response: Response) => void)[];
let posts: FormData[];
let cleaning = false;

function Conversation({ currentThread = threadId }) {
  const { handleSend, uploadStatus, uploadError } = useSendMessage(currentThread);
  const attempts = useSendAttemptStore((state) => state.attempts);
  const messages = withSendAttempts([], attempts, currentThread);
  return (
    <>
      {messages.map((message) => (
        <article key={message.id}>
          {message.content}
          {message.contentBlocks?.flatMap((block, index) =>
            block.type === 'image' ? <img key={index} src={block.url} alt={block.alt} /> : [],
          )}
          {message.sendAttempt && <SendAttemptStatus attempt={message.sendAttempt} threadId={currentThread} />}
        </article>
      ))}
      <ChatInput
        threadId={currentThread}
        localSendFeedback
        uploadStatus={uploadStatus}
        uploadError={uploadError}
        onSend={(content, files, whisper, replyTo, contexts, targets, disposition, onPrepared) => {
          pending = handleSend(content, files, undefined, whisper, replyTo, contexts, targets, {
            consumeComposerDraft: true,
            localAttempt: true,
            onPrepared,
            messageDisposition: disposition,
          });
          return pending;
        }}
      />
    </>
  );
}

beforeEach(async () => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observeApiSessionOwner('handoff-owner');
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = () => 'blob:handoff';
      static revokeObjectURL = () => {};
    },
  );
  pending = undefined;
  cleaning = false;
  responses = [];
  posts = [];
  apiFetch.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/messages' && init?.method === 'POST') {
      posts.push(init.body as FormData);
      if (cleaning) return new Response('{}', { status: 400 });
      return new Promise<Response>((resolve) => responses.push(resolve));
    }
    return new Response('{}');
  });
  const persist = attemptDb.saveSendAttempt;
  const saving = new Promise<void>((resolve, reject) => {
    releaseSave = resolve;
    rejectSave = reject;
  });
  vi.spyOn(attemptDb, 'saveSendAttempt').mockImplementationOnce(async (attempt) => {
    await saving;
    await persist(attempt);
  });
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
  threadImageDrafts.set(threadId, [new File(['image bytes'], 'original.png', { type: 'image/png' })]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Conversation />));
});

afterEach(async () => {
  cleaning = true;
  await act(async () => {
    releaseSave();
    responses.forEach((resolve) => resolve(new Response('{}', { status: 400 })));
    await pending;
  });
  act(() => root.unmount());
  host.remove();
  await Promise.all(useSendAttemptStore.getState().attempts.map(attemptDb.deleteSendAttempt));
  useSendAttemptStore.setState({ attempts: [] });
  syncDraftToStorage(threadId, undefined);
  threadImageDrafts.delete(threadId);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('keeps immediate feedback and transfers the snapshot only after persistence, preserving new typing', async () => {
  const input = host.querySelector('textarea')!;
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(host.querySelectorAll('article')).toHaveLength(1);
  expect(host.querySelector('article')?.textContent).not.toContain(text);
  expect(host.querySelector('article img')).toBeNull();
  expect(host.querySelector('article')?.textContent).toContain('正在准备发送');
  expect(input.value).toBe(text);
  expect(host.textContent).not.toContain('附件上传中');
  expect(posts).toHaveLength(0);
  await act(async () => syncDraftToStorage(threadId, `${text}\n下一条输入`));
  await act(async () => {
    releaseSave();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
  });
  expect(host.querySelectorAll('article')).toHaveLength(1);
  expect(host.querySelector('article')?.textContent).toContain(text);
  expect(host.querySelector('article img')).not.toBeNull();
  expect(input.value).toBe('\n下一条输入');
  expect(host.textContent).not.toContain('附件上传中');
  expect(posts[0]?.get('content')).toBe(text);
  expect(posts[0]?.get('images')).toMatchObject({ name: 'original.png' });
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(host.querySelectorAll('article')).toHaveLength(1);
  expect(posts).toHaveLength(1);
});

it('retains a failed preparation in the composer without a second resend or copy entry', async () => {
  const input = host.querySelector('textarea')!;
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await act(async () => {
    rejectSave(new Error('storage unavailable'));
    await pending;
  });
  expect(input.value).toBe(text);
  expect(host.querySelector('article')?.textContent).not.toContain(text);
  expect(host.querySelector('article img')).toBeNull();
  expect(host.querySelector('article [data-send-status="failed"]')).not.toBeNull();
  expect(host.querySelector('article button')).toBeNull();
  expect(posts).toHaveLength(0);
});

it('keeps an already transferred snapshot visible while retry persistence is pending', async () => {
  await act(async () => {
    host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    releaseSave();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    responses.shift()!(new Response('{"error":"busy"}', { status: 429 }));
    await pending;
  });
  await act(async () => syncDraftToStorage(threadId, '下一条输入'));
  const persist = attemptDb.saveSendAttempt;
  const retrySave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  vi.spyOn(attemptDb, 'saveSendAttempt').mockImplementationOnce(async (attempt) => {
    await retrySave;
    await persist(attempt);
  });
  await act(async () => host.querySelector<HTMLButtonElement>('article button')!.click());
  expect(host.querySelector('article [data-send-status="preparing"]')).not.toBeNull();
  expect(host.querySelector('article')?.textContent).toContain(text);
  expect(host.querySelector('article img')).not.toBeNull();
  expect(host.querySelector('textarea')?.value).toBe('下一条输入');
  await act(async () => {
    releaseSave();
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    responses.shift()!(new Response('{}', { status: 400 }));
  });
  expect(posts[1]?.get('idempotencyKey')).toBe(posts[0]?.get('idempotencyKey'));
  expect(host.querySelectorAll('article')).toHaveLength(1);
});

it('restores a refused handoff only in its own composer without clearing the next thread', async () => {
  const request = apiFetch.getMockImplementation()!;
  apiFetch.mockImplementation((path: string, init?: RequestInit) =>
    path === `/api/threads/${threadId}/composer-draft` && !init?.method
      ? Promise.resolve(new Response(JSON.stringify({ draft: { text, revision: 1 }, revision: 1 })))
      : request(path, init),
  );
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Conversation />));
  await act(async () => vi.waitFor(() => expect(observeComposerDraft(threadId)?.revision).toBe(1)));
  await act(async () =>
    host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  const nextThread = 'next-handoff-thread';
  await act(async () => {
    syncDraftToStorage(nextThread, '另一会话的新草稿');
    useChatStore.setState({ currentThreadId: nextThread });
    root.render(<Conversation currentThread={nextThread} />);
  });
  await act(async () => {
    releaseSave();
    await pending;
  });
  expect(posts).toHaveLength(0);
  expect(host.querySelector('textarea')?.value).toBe('另一会话的新草稿');
  await act(async () => {
    useChatStore.setState({ currentThreadId: threadId });
    root.render(<Conversation />);
  });
  await act(async () => vi.waitFor(() => expect(observeComposerDraft(threadId)?.ready).toBe(true)));
  expect(host.querySelector('textarea')?.value).toBe(text);
  expect(host.querySelector('[aria-label="Remove original.png"]')).not.toBeNull();
  expect(host.querySelector('article')?.textContent).not.toContain(text);
  expect(host.querySelector('article img')).toBeNull();
  expect(host.querySelector('article button')).toBeNull();
  syncDraftToStorage(nextThread, undefined);
});

it('retires only the old preparation notice durably when the composer sends again', async () => {
  await act(async () =>
    host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  await act(async () => {
    rejectSave(new Error('storage unavailable'));
    await pending;
  });
  const failed = useSendAttemptStore.getState().attempts[0]!;
  await attemptDb.saveSendAttempt(failed);
  const held = { ...failed, id: 'bubble-owned-failure', content: '另一条已交接的失败消息', contentInComposer: false };
  await act(async () => {
    await attemptDb.saveSendAttempt(held);
    putSendAttempt(held);
  });
  await act(async () => {
    host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    responses.shift()!(new Response('{"status":"queued","userMessageId":"resend-accepted"}', { status: 202 }));
    await pending;
    await vi.waitFor(() => expect(host.querySelectorAll('article')).toHaveLength(2));
  });
  expect(host.querySelector('textarea')?.value).toBe('');
  expect(host.querySelectorAll('[data-send-status="failed"]')).toHaveLength(1);
  expect(host.textContent).toContain(held.content);
  const restored = await attemptDb.loadSendAttempts(failed.ownerUserId, threadId);
  expect(restored.some((item) => item.id === failed.id)).toBe(false);
  expect(restored.some((item) => item.id === held.id)).toBe(true);
});
