import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { cloudThreadId } from '../../../test/browser/fixtures/f247-cloud-receipt-messages';
import { authorizedRows, unboundTurn } from '../../../test/browser/fixtures/f247-unbound-turn';
import { ChatMessage } from '../ChatMessage';
import { ShellPresentationContext } from '../shell/shell-presentation';
import { packageRows } from './cloud-route-test-fixtures';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));
let root: Root, container: HTMLDivElement;
let dispatch: ReturnType<typeof useAgentMessages>['handleAgentMessage'];
let binding: Record<string, string>;

function Harness() {
  dispatch = useAgentMessages().handleAgentMessage;
  const messages = useChatStore((state) => state.messages);
  return (
    <ShellPresentationContext.Provider value="v2">
      {messages.map((message) => (
        <ChatMessage
          key={message.id}
          message={message}
          threadId={cloudThreadId}
          timelineMessages={messages}
          getCatById={() => undefined}
        />
      ))}
    </ShellPresentationContext.Provider>
  );
}
beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  binding = {};
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async (path, init) => {
      if (path.endsWith('/cloud-bindings')) {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as { catId: string; chatUrl: string };
          binding = { ...binding, [body.catId]: body.chatUrl };
        }
        return new Response(JSON.stringify({ bindings: binding }));
      }
      return new Response(JSON.stringify(path.endsWith('/list') ? packageRows(authorizedRows()) : {}));
    });
  primeCoCreatorConfigCache({ name: 'You', aliases: [], mentionPatterns: ['@co-creator'] });
  useChatStore.setState({
    currentThreadId: cloudThreadId,
    messages: [],
    threads: [],
    isLoadingThreads: false,
    activeInvocations: {},
    catInvocations: {},
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetCoCreatorConfigCacheForTest();
});
async function render(messages: Message[]) {
  useChatStore.setState({ messages });
  await act(async () => root.render(<Harness />));
}
const cards = () => container.querySelectorAll('[data-testid="cloud-binding-recovery-card"]');
const writes = () =>
  vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH' || init?.method === 'PUT');

it('receives the real hook event after initial render and offers the human selector without reload', async () => {
  const [source, response, live] = unboundTurn('user', true);
  await render([source, response]);
  expect(cards()).toHaveLength(0);
  await act(async () =>
    dispatch({
      type: 'system_info',
      catId: 'gpt-pro',
      threadId: cloudThreadId,
      invocationId: 'dispatch77',
      messageId: response.id,
      content: JSON.stringify(live.extra!.systemInfo!.payload),
    }),
  );
  expect(cards()).toHaveLength(1);
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(21);
  expect(container.querySelector<HTMLButtonElement>('[data-recovery-primary]')?.textContent).toBe('连接并发送');
  expect(container.querySelector<HTMLButtonElement>('[data-recovery-primary]')?.disabled).toBe(true);
  expect(container.textContent).not.toContain('收到，已回复');
  const option = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
  await act(async () => option.click());
  expect(writes()).toHaveLength(0);
  await act(async () => useChatStore.setState({ messages: unboundTurn('user') }));
  expect(cards()).toHaveLength(1);
  expect(container.querySelector<HTMLInputElement>(`input[value="${option.value}"]`)?.checked).toBe(true);
});

it.each([
  true,
  false,
])('cat-originated %s-live failure offers owner connection only, never user retry', async (live) => {
  const turn = unboundTurn('cat', live),
    original = JSON.stringify(turn);
  await render(turn);
  expect(cards()).toHaveLength(1);
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(21);
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click());
  expect(writes()).toHaveLength(0);
  const primary = container.querySelector<HTMLButtonElement>('[data-recovery-primary]');
  expect(primary?.textContent).toBe('连接此会话');
  await act(async () => primary?.click());
  expect(writes()).toHaveLength(1);
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith('/retry') || path === '/api/messages')).toBe(
    false,
  );
  expect(container.textContent).toContain('没有重发');
  expect(JSON.stringify(turn)).toBe(original);
});

it('does not infer an unbound route from a cat failure when the owner read says already bound', async () => {
  binding = { 'gpt-pro': `https://chatgpt.com/c/${authorizedRows()[0].conversationId}` };
  await render(unboundTurn('cat'));
  expect(cards()).toHaveLength(0);
  expect(container.textContent).toContain('云端猫投递');
  expect(writes()).toHaveLength(0);
});

it('shows the owner restriction without offering choices to a reader without owner access', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 403 }));
  await render(unboundTurn('cat'));
  expect(container.textContent).toContain('仅对话所有者可以连接会话');
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(writes()).toHaveLength(0);
});
