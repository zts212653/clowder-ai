import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messages = [
  { id: 'u1', type: 'user', content: 'retry please', timestamp: 1 },
  { id: 's1', type: 'system', variant: 'error', content: 'authentication failed', timestamp: 2 },
  { id: 'c1', type: 'connector', content: 'connector diagnosis', timestamp: 3 },
  { id: 'a1', type: 'assistant', content: 'recovered', timestamp: 4 },
] as const;
const handleSend = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useThreadScopedSelectors', () => ({
  useThreadMessages: () => messages,
  useThreadLiveness: () => ({
    hasActive: false,
    activeInvocations: {},
    catStatuses: {},
    catInvocations: {},
    intentMode: null,
    targetCats: [],
  }),
}));

vi.mock('@/hooks/useChatHistory', () => ({
  useChatHistory: () => ({
    handleScroll: vi.fn(),
    scrollContainerRef: { current: null },
    messagesEndRef: { current: null },
    isLoadingHistory: false,
    hasMore: false,
  }),
}));

vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend, uploadStatus: 'idle', uploadError: null }),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: vi.fn() }),
}));

vi.mock('@/hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => ({
    api: 'connected',
    socket: 'connected',
    upstream: 'connected',
    isReadonly: false,
    checkedAt: 0,
    forwardingBlocked: false,
    updateRequired: false,
  }),
}));

vi.mock('../ThreadChatRuntimeProvider', () => ({
  useThreadChatRuntime: () => ({ socketConnected: true }),
}));

vi.mock('../../ChatMessageRow', () => ({
  ChatMessageRow: ({
    message,
    sendContext,
    confirmations,
  }: {
    message: (typeof messages)[number];
    sendContext?: string;
    confirmations?: unknown[];
  }) => (
    <article
      data-thread-chat-message-id={message.id}
      data-thread-chat-message-type={message.type}
      data-thread-chat-message-variant={'variant' in message ? message.variant : ''}
      data-send-context={sendContext}
      data-confirmation-count={confirmations?.length ?? 0}
    >
      {message.content}
    </article>
  ),
}));

vi.mock('../../ChatInput', () => ({
  ChatInput: ({ threadId }: { threadId: string }) => <textarea aria-label={`composer-${threadId}`} />,
}));

import type { CardConfirmationEntry } from '../../rich/CardBlock';
import { ThreadChatSurface } from '../ThreadChatSurface';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  handleSend.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function manifest(scope: Element): string[] {
  return Array.from(scope.querySelectorAll('[data-thread-chat-message-id]')).map((node) =>
    [
      node.getAttribute('data-thread-chat-message-id'),
      node.getAttribute('data-thread-chat-message-type'),
      node.getAttribute('data-thread-chat-message-variant'),
      node.textContent,
    ].join('|'),
  );
}

describe('ThreadChatSurface density contract', () => {
  it('keeps the complete semantic message manifest and composer in both densities', async () => {
    const messageConfirmations = new Map<string, CardConfirmationEntry[]>([
      ['a1', [{ id: 'confirmation-1', messageId: 'a1', status: 'confirmed', action: { kind: 'confirm' } }]],
    ]);
    await act(async () => {
      root.render(
        <div>
          <section data-density-host="full">
            <ThreadChatSurface threadId="thread-parity" density="full" messageConfirmations={messageConfirmations} />
          </section>
          <section data-density-host="compact">
            <ThreadChatSurface threadId="thread-parity" density="compact" messageConfirmations={messageConfirmations} />
          </section>
        </div>,
      );
    });

    const full = container.querySelector('[data-density-host="full"]');
    const compact = container.querySelector('[data-density-host="compact"]');
    if (!full || !compact) throw new Error('both density hosts must render');
    expect(manifest(full)).toEqual(manifest(compact));
    expect(manifest(compact)).toEqual([
      'u1|user||retry please',
      's1|system|error|authentication failed',
      'c1|connector||connector diagnosis',
      'a1|assistant||recovered',
    ]);
    expect(full?.querySelector('textarea[aria-label="composer-thread-parity"]')).not.toBeNull();
    expect(compact?.querySelector('textarea[aria-label="composer-thread-parity"]')).not.toBeNull();
    expect(full.querySelector('[data-thread-chat-message-id="a1"]')?.getAttribute('data-confirmation-count')).toBe('1');
    expect(compact.querySelector('[data-thread-chat-message-id="a1"]')?.getAttribute('data-confirmation-count')).toBe(
      '1',
    );
  });

  it('routes an interactive rich action only through the surface that rendered it', async () => {
    await act(async () => {
      root.render(
        <div>
          <section data-density-host="full">
            <ThreadChatSurface threadId="thread-parity" density="full" />
          </section>
          <section data-density-host="compact">
            <ThreadChatSurface threadId="thread-parity" density="compact" />
          </section>
        </div>,
      );
    });

    const compactContext = container
      .querySelector('[data-density-host="compact"] [data-send-context]')
      ?.getAttribute('data-send-context');
    expect(compactContext).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:interactive-send', {
          detail: { text: '确认', sendContext: compactContext },
        }),
      );
    });

    expect(handleSend).toHaveBeenCalledOnce();
    expect(handleSend).toHaveBeenCalledWith('确认');
  });

  it('admits a legacy unscoped command only through the matching full surface', async () => {
    await act(async () => {
      root.render(
        <div>
          <ThreadChatSurface threadId="thread-parity" density="full" acceptUnscopedInteractiveSend />
          <ThreadChatSurface threadId="thread-parity" density="compact" />
        </div>,
      );
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:interactive-send', {
          detail: { text: '投票通知', targetThreadId: 'thread-other' },
        }),
      );
    });
    expect(handleSend).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:interactive-send', {
          detail: { text: '投票通知', targetThreadId: 'thread-parity' },
        }),
      );
    });
    expect(handleSend).toHaveBeenCalledOnce();
    expect(handleSend).toHaveBeenCalledWith('投票通知');
  });
});
