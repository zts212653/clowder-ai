import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import {
  cloudReceiptTurn,
  cloudThreadId,
  cloudUnboundTurn,
} from '../../../test/browser/fixtures/f247-cloud-receipt-messages';
import { ChatMessage } from '../ChatMessage';
import { ShellPresentationContext } from '../shell/shell-presentation';
import { MessageNavigationProvider } from '../thread-chat/MessageNavigationContext';
import { packageRows } from './cloud-route-test-fixtures';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: vi.fn() }));
const navigate = vi.fn(() => true);
let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async () => new Response('{}'));
  navigate.mockClear();
  primeCoCreatorConfigCache({ name: 'You', aliases: [], mentionPatterns: ['@co-creator'] });
  useChatStore.setState({ currentThreadId: cloudThreadId, messages: [], threads: [], isLoadingThreads: false });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetCoCreatorConfigCacheForTest();
});

async function render(messages = cloudReceiptTurn(), shell: 'v2' | 'classic' = 'v2') {
  await act(async () =>
    root.render(
      <ShellPresentationContext.Provider value={shell}>
        <MessageNavigationProvider value={navigate}>
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              threadId={cloudThreadId}
              timelineMessages={messages}
              getCatById={() => undefined}
            />
          ))}
        </MessageNavigationProvider>
      </ShellPresentationContext.Provider>,
    ),
  );
}

describe('V2 cloud replies use the existing native receipt', () => {
  it('replaces the empty completion, live warning and large delivery card in the whole turn', async () => {
    const messages = cloudReceiptTurn();
    const before = JSON.stringify(messages);
    await render(messages);
    expect(container.textContent).toContain('咪呀！大尾巴');
    expect(container.querySelectorAll('[data-testid="message-dispatch-avatars"]')).toHaveLength(1);
    expect(container.textContent).not.toContain('已完成，没有返回可显示内容');
    expect(container.textContent).not.toContain('投递结果未知：');
    expect(container.textContent).not.toContain('云端猫投递');
    expect(container.textContent).not.toContain('已收到 Pro 回复');
    expect(JSON.stringify(messages)).toBe(before);
    expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('links the native receipt to the actual reply, preserving the raw unknown audit', async () => {
    await render();
    const native = container.querySelector('[data-dispatch-target="gpt-pro"]');
    expect(native?.textContent).toContain('收到，已回复');
    expect(native?.getAttribute('title')).toContain('Host 回执未确认');
    expect(native?.getAttribute('title')).toContain('dispatch77');
    await act(async () => (native?.querySelector('button') as HTMLButtonElement).click());
    expect(navigate).toHaveBeenCalledWith('reply81', { loadIfNeeded: true });
  });

  it.each([
    'wrong-dispatch',
    'wrong-thread',
    'wrong-source',
    'wrong-cat',
    'streaming',
    'recalled',
    'hidden',
    'empty',
  ])('keeps unresolved guidance and never links a %s reply as the current result', async (variant) => {
    const messages = cloudReceiptTurn();
    const answer = messages.at(-1)!;
    const proof = answer.extra!.cloudBridgeReturn!;
    if (variant === 'wrong-dispatch') answer.extra!.cloudBridgeReturn = { ...proof, dispatchInvocationId: 'old' };
    if (variant === 'wrong-thread') answer.extra!.cloudBridgeReturn = { ...proof, threadId: 'other' };
    if (variant === 'wrong-source') {
      answer.extra!.cloudBridgeReturn = { ...proof, sourceMessageId: 'other' };
      answer.replyTo = 'other';
    }
    if (variant === 'wrong-cat') answer.catId = 'other';
    if (variant === 'streaming') answer.isStreaming = true;
    if (variant === 'recalled')
      answer.extra = { ...answer.extra, recall: { version: 1, exposure: 'none', recalledAt: 150 } };
    if (variant === 'hidden') answer.visibility = 'whisper';
    if (variant === 'empty') answer.content = '';
    await render(messages);
    expect(container.textContent).toContain('投递结果未知');
    const native = container.querySelector('[data-dispatch-target="gpt-pro"]');
    expect(native?.textContent).not.toContain('已回复');
    expect(native?.querySelector('button')).toBeNull();
  });

  it('keeps a historical reply distinct from a verified current attempt', async () => {
    const messages = cloudReceiptTurn();
    delete messages.at(-1)!.extra!.cloudBridgeReturn;
    await render(messages);
    const native = container.querySelector('[data-dispatch-target="gpt-pro"]');
    expect(native?.textContent).toContain('这条消息已有回信');
    expect(native?.getAttribute('title')).toContain('发送批次仍待核对');
    expect(native?.textContent).not.toContain('收到，已回复');
    expect(container.textContent).not.toContain('云端猫投递');
  });

  it('does not use the only old receipt as authority when the current dispatch frame is outside the page', async () => {
    const messages = cloudReceiptTurn().filter((message) => message.id !== 'empty78');
    const source = messages[0];
    if (source.lifecycle?.kind !== 'input') throw new Error('fixture needs a dispatched source');
    source.lifecycle = {
      ...source.lifecycle,
      dispatchRefs: [{ targetId: 'gpt-pro', phase: 'settled', statusMessageId: 'new-frame' }],
    };
    await render(messages);
    expect(container.textContent).toContain('云端猫投递');
    expect(container.querySelector('[data-dispatch-target="gpt-pro"]')?.textContent).not.toContain('已回复');
  });

  it('keeps Classic presentation unchanged', async () => {
    await render(cloudReceiptTurn(), 'classic');
    expect(container.textContent).toContain('已完成，没有返回可显示内容');
    expect(container.textContent).toContain('云端猫投递');
    expect(container.textContent).toContain('已收到 Pro 回复');
  });

  it('uses the same native receipt for dot after its existing event reader confirms the exact reply', async () => {
    vi.mocked(apiFetch).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            threadId: cloudThreadId,
            stale: false,
            receivedAt: 110,
            readAt: 120,
            replyMessageId: 'reply81',
          }),
        ),
    );
    await render(cloudReceiptTurn('gpt-dot'));
    const native = container.querySelector('[data-dispatch-target="gpt-dot"]');
    expect(native?.textContent).toContain('收到，已回复');
    expect(container.textContent).not.toContain('云端猫投递');
    expect(container.textContent).not.toContain('已完成，没有返回可显示内容');
    await act(async () => (native?.querySelector('button') as HTMLButtonElement).click());
    expect(navigate).toHaveBeenCalledWith('reply81', { loadIfNeeded: true });
  });

  it('keeps the unbound Pro selector and requires a deliberate choice before binding', async () => {
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            path.endsWith('/list')
              ? packageRows([
                  { conversationId: 'conversation-one', displayTitle: '科研一起看' },
                  { conversationId: 'conversation-two', displayTitle: '周末聊设计' },
                ])
              : path.endsWith('/cloud-bindings')
                ? { bindings: {} }
                : {},
          ),
        ),
    );
    await render(cloudUnboundTurn());
    expect(container.textContent).toContain('选择 ChatGPT 会话');
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(container.querySelector<HTMLButtonElement>('[data-recovery-primary]')?.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[value="conversation-two"]')?.click());
    expect(container.querySelector<HTMLButtonElement>('[data-recovery-primary]')?.disabled).toBe(false);
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(
          ([path, init]) => init?.method === 'PATCH' || path.endsWith('/retry') || path === '/api/messages',
        ),
    ).toBe(false);
  });
});
