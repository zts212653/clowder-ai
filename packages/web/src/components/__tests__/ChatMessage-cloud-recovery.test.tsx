import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ChatMessage } from '../ChatMessage';

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: vi.fn(async () => new Response('{}', { status: 200 })),
}));

describe('ChatMessage wires exact Host delivery facts into recovery', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    vi.mocked(apiFetch).mockClear();
    primeCoCreatorConfigCache({ name: 'lang', aliases: [], mentionPatterns: ['@co-creator'] });
    useChatStore.setState({ currentThreadId: 'thread-1', messages: [], threads: [], isLoadingThreads: false });
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCoCreatorConfigCacheForTest();
  });

  function render(status: 'sent' | 'failed', receiptDispatchId = 'dispatch-1') {
    const source: Message = {
      id: 'source-1',
      type: 'user',
      from: { kind: 'user', userId: 'test-user' },
      content: '@gpt-pro hello',
      timestamp: 1,
    };
    const recovery: Message = {
      id: 'recovery',
      type: 'connector',
      from: { kind: 'external', connectorId: 'cloud-bridge-status' },
      content: 'Needs connection',
      timestamp: 2,
      replyTo: source.id,
      source: {
        connector: 'cloud-bridge-status',
        label: 'cloud',
        icon: 'cloud',
        meta: {
          cloudBridgeRecovery: {
            v: 1,
            kind: 'needs_binding',
            sourceMessageId: source.id,
            targetCatId: 'gpt-pro',
            dispatchInvocationId: 'dispatch-1',
          },
        },
      },
    };
    const receipt: Message = {
      id: 'receipt',
      type: 'connector',
      from: { kind: 'external', connectorId: 'cloud-bridge-status' },
      content: 'Delivery fact',
      timestamp: 3,
      replyTo: source.id,
      source: {
        connector: 'cloud-bridge-status',
        label: 'cloud',
        icon: 'cloud',
        meta: {
          cloudBridgeOutboundReceipt: {
            v: 1,
            sourceMessageId: source.id,
            sourceSender: { kind: 'user', id: 'owner' },
            targetCatId: 'gpt-pro',
            dispatchInvocationId: receiptDispatchId,
            status,
            transport: 'host',
            hostMessageId: 'host-message',
            idempotency: { keyKind: 'source_message_id', disposition: 'fresh' },
          },
        },
      },
    };
    act(() =>
      root.render(
        <ChatMessage
          message={source}
          threadId="thread-1"
          timelineMessages={[source, recovery, receipt]}
          getCatById={() => undefined}
        />,
      ),
    );
  }

  it.each([
    ['sent', '已发送到 ChatGPT'],
    ['failed', '这条消息未发送'],
  ] as const)('renders the %s terminal receipt without reopening a recovery probe', async (status, label) => {
    render(status);
    await act(async () => {});
    expect(container.textContent).toContain(label);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does not borrow a terminal fact from a different exact dispatch', async () => {
    render('sent', 'dispatch-old');
    await act(async () => {});
    expect(container.textContent).not.toContain('已发送到 ChatGPT');
    expect(apiFetch).toHaveBeenCalled();
  });
});
