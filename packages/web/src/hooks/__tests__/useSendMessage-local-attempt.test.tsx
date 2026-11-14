import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useChatStore } from '@/stores/chatStore';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import * as attemptDb from '@/utils/send-attempt-db';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('@/hooks/useChatCommands', () => ({ useChatCommands: () => ({ processCommand: async () => false }) }));

let root: Root;
let host: HTMLDivElement;
let rejectSend: (error: Error) => void;
let pending: Promise<boolean> | undefined;
let send: ReturnType<typeof useSendMessage>['handleSend'];
const threadId = 'pending-send-proof';
function Conversation() {
  const history = useChatHistory(threadId);
  send = useSendMessage(threadId).handleSend;
  return (
    <main ref={history.scrollContainerRef}>
      {history.messages.map((message) => (
        <article key={message.id} data-kind={message.type}>
          {message.content}
        </article>
      ))}
    </main>
  );
}
afterEach(async () => {
  await act(async () => {
    if (rejectSend) {
      rejectSend(new Error('cleanup'));
      await pending;
    }
  });
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('shows a recoverable user bubble before HTTP completes, without publishing it into History', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observeApiSessionOwner('send-proof-owner');
  useChatStore.setState({ currentThreadId: threadId, messages: [], queue: [], threadStates: {}, hasMore: false });
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/api/messages' && init?.method === 'POST')
      return new Promise((_resolve, reject) => {
        rejectSend = reject;
      });
    return Promise.resolve(
      new Response(
        JSON.stringify({ messages: [], hasMore: false, queue: [], tasks: [], cats: [], activeInvocations: [] }),
      ),
    );
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ThreadChatHistoryAdmissionProvider>
        <Conversation />
      </ThreadChatHistoryAdmissionProvider>,
    ),
  );
  const prepared = vi.fn();
  await act(async () => {
    pending = send('这是刚刚发出的补充消息', undefined, undefined, undefined, undefined, undefined, undefined, {
      localAttempt: true,
      onPrepared: prepared,
    });
    await vi.waitFor(() => expect(prepared).toHaveBeenCalledOnce());
  });
  expect(host.querySelectorAll('[data-kind="user"]')).toHaveLength(1);
  expect(host.textContent).toContain('这是刚刚发出的补充消息');
  expect(useChatStore.getState().messages).toEqual([]);
  expect(prepared).toHaveBeenCalledOnce();
  await act(async () => {
    rejectSend(new TypeError('response lost'));
    await pending;
  });
  expect(host.querySelectorAll('[data-kind="user"]')).toHaveLength(1);
  expect(host.textContent).toContain('这是刚刚发出的补充消息');
  expect(useChatStore.getState().messages).toEqual([]);
  const postCount = apiFetch.mock.calls.filter(
    ([path, init]) => path === '/api/messages' && init?.method === 'POST',
  ).length;
  vi.spyOn(attemptDb, 'saveSendAttempt').mockRejectedValueOnce(
    new DOMException('quota exceeded', 'QuotaExceededError'),
  );
  const notPrepared = vi.fn();
  await act(async () => {
    expect(
      await send('本地保存失败时不要发到网络', undefined, undefined, undefined, undefined, undefined, undefined, {
        localAttempt: true,
        onPrepared: notPrepared,
      }),
    ).toBe(false);
  });
  expect(notPrepared).not.toHaveBeenCalled();
  expect(
    apiFetch.mock.calls.filter(([path, init]) => path === '/api/messages' && init?.method === 'POST'),
  ).toHaveLength(postCount);
});
