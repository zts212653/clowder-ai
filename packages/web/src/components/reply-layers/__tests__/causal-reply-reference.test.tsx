import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { createFakeHubSocket, withHubSocket } from '@/test-utils/fake-hub-socket';
import { MessageNavigationProvider } from '../../thread-chat/MessageNavigationContext';
import { CausalReplyReference } from '../CausalReplyReference';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: request }));
vi.mock('../../MessageActions', () => ({ MessageActions: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../CatNameplate', () => ({ CatNameplate: () => null }));

const reference = { anchorMessageId: 'S', targetMessageId: 'R', targetCatId: 'codex', kind: 'reply' as const };
const reply = { id: 'R', type: 'assistant', catId: 'codex', content: '此前过程。\n\n实际结果。', timestamp: 1 };
const wire = (message = reply) => new Response(JSON.stringify({ messages: [message], hasMore: true }));

describe('bounded canonical message reference reading', () => {
  let host: HTMLDivElement;
  let root: Root;
  let connection: ReturnType<typeof createFakeHubSocket>;
  const back = vi.fn(() => true);
  const close = vi.fn();
  const reveal = vi.fn();
  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    connection = createFakeHubSocket();
    root = withHubSocket(createRoot(host), connection.hub);
    request.mockReset();
    back.mockClear();
    close.mockClear();
    reveal.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    ['message_deleted', 'message_hard_deleted', 'message_recalled', 'message_restored'].forEach((event) =>
      expect(connection.listenerCount(event)).toBe(0),
    );
    host.remove();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(socketConnected = true, targetStatus = 'done') {
    await act(async () =>
      root.render(
        <MessageNavigationProvider value={back}>
          <CausalReplyReference
            reference={reference}
            threadId="reference-thread"
            getCatById={() => undefined}
            forwardingDisabled={false}
            socketConnected={socketConnected}
            targetStatus={targetStatus}
            onClose={close}
            onReveal={reveal}
          />
        </MessageNavigationProvider>,
      ),
    );
  }
  it('reads one exact anchor without changing History or following hasMore, then returns to S', async () => {
    request.mockResolvedValue(wire());
    const before = useChatStore.getState().messages;
    await render();
    expect(request).toHaveBeenCalledOnce();
    const query = new URL(String(request.mock.calls[0]?.[0]), 'https://isolated.test').searchParams;
    expect(query.get('threadId')).toBe('reference-thread');
    expect(query.get('anchorMessageId')).toBe('R');
    expect(query.get('limit')).toBe('1');
    expect(host.textContent).toContain('实际结果');
    expect(host.textContent).toContain('完整文字原文');
    expect(useChatStore.getState().messages).toBe(before);
    expect(host.querySelector('[data-message-id]')).toBeNull();
    act(() =>
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === '返回补充消息')
        ?.click(),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledWith('S');
    expect(reveal).toHaveBeenCalledOnce();
  });
  it('re-reads the canonical result after reconnect and execution state change', async () => {
    request
      .mockResolvedValueOnce(wire())
      .mockResolvedValueOnce(wire({ ...reply, content: '重连后的结果。' }))
      .mockResolvedValueOnce(wire({ ...reply, content: '最终结果。' }));
    await render(false, 'streaming');
    await render(true, 'streaming');
    expect(host.textContent).toContain('重连后的结果');
    await render(true, 'done');
    expect(host.textContent).toContain('最终结果');
    expect(request).toHaveBeenCalledTimes(3);
    expect(reveal).toHaveBeenCalledOnce();
  });
  it.each([
    'recalled',
    'unavailable',
    'http-recalled',
  ] as const)('does not expose cached text when the canonical read is %s', async (outcome) => {
    request.mockResolvedValue(
      outcome === 'recalled'
        ? new Response(JSON.stringify({ messages: [{ ...reply, extra: { recall: { version: 1 } } }] }))
        : new Response('{}', { status: outcome === 'http-recalled' ? 410 : 403 }),
    );
    await render();
    expect(host.textContent).not.toContain('实际结果');
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      outcome.includes('recalled') ? '消息已撤回' : '消息暂不可用',
    );
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([
    'message_deleted',
    'message_hard_deleted',
    'message_recalled',
  ] as const)('clears an unloaded R immediately on the existing page connection: %s', async (event) => {
    request.mockResolvedValue(wire());
    await render();
    act(() => connection.deliver(event, { threadId: 'other-thread', messageId: 'R' }));
    expect(host.textContent).toContain('实际结果');
    act(() => connection.deliver(event, { threadId: 'reference-thread', messageId: 'R', verdict: 'exposed' }));
    expect(host.textContent).not.toContain('实际结果');
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      event === 'message_recalled' ? '消息已撤回' : '消息暂不可用',
    );
    expect(request).toHaveBeenCalledOnce();
  });
  it('does not resurrect a recalled body when an older HTTP read completes', async () => {
    let resolve: ((response: Response) => void) | undefined;
    request.mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    await render();
    act(() =>
      connection.deliver('message_recalled', { threadId: 'reference-thread', messageId: 'R', verdict: 'exposed' }),
    );
    await act(async () => resolve?.(wire()));
    expect(host.textContent).not.toContain('实际结果');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('消息已撤回');
  });
  it('re-reads an explicitly restored canonical message through the existing connection', async () => {
    request.mockResolvedValueOnce(wire()).mockResolvedValueOnce(wire({ ...reply, content: '恢复后的原文。' }));
    await render();
    act(() => connection.deliver('message_deleted', { threadId: 'reference-thread', messageId: 'R' }));
    await act(async () => connection.deliver('message_restored', { threadId: 'reference-thread', messageId: 'R' }));
    expect(host.textContent).toContain('恢复后的原文');
    expect(request).toHaveBeenCalledTimes(2);
    expect(reveal).toHaveBeenCalledOnce();
  });
});
