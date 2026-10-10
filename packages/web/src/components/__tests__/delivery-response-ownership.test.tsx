import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { AppendedInputReceipts } from '../AppendedInputReceipts';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ({ name: 'owner' }) }));
vi.mock('@/hooks/useThreadScopedSelectors', () => ({
  useThreadLiveness: () => ({ activeInvocations: { opus: { catId: 'opus', startedAt: 1000 } } }),
  useThreadMessages: () => [],
}));
vi.mock('@/utils/focusLineageMessage', () => ({ focusLineageMessage: vi.fn() }));

Object.assign(globalThis, { React });

describe('delivered input belongs to the member response', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'thread-1', queue: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not keep a delivered input in Queue while its member is still processing', () => {
    act(() => root.render(<QueuePanel threadId="thread-1" />));
    expect(container.textContent).toBe('');
  });

  it('keeps the appended source under a failed response without a separate read outcome', () => {
    const source: ChatMessage = {
      id: 'appended-source',
      from: { kind: 'user', userId: 'owner' },
      type: 'user',
      content: '顺便看一下那个测试',
      timestamp: 2000,
      lifecycle: {
        kind: 'input',
        orderKey: '2000:appended-source',
        dispatchRefs: [{ targetId: 'opus', phase: 'settled', statusMessageId: 'response-1', dispatchedAt: 2000 }],
      },
    };
    const response: ChatMessage = {
      id: 'response-1',
      from: { kind: 'agent', catId: 'opus' },
      type: 'assistant',
      catId: 'opus',
      content: '成员处理失败',
      timestamp: 1000,
      lifecycle: {
        kind: 'response',
        orderKey: '1000:response-1',
        invocationId: 'turn-1',
        targetId: 'opus',
        inputEntryIds: ['initial-entry', 'appended-entry'],
        inputMessageIds: ['initial-source', source.id],
        status: 'failed',
        startedAt: 1000,
        completedAt: 3000,
      },
    };
    act(() =>
      root.render(
        <AppendedInputReceipts response={response} timelineMessages={[source]} getCatById={() => undefined} />,
      ),
    );
    const row = container.querySelector('[data-appended-input-id="appended-source"]');
    expect(row?.textContent).toContain(source.content);
    expect(row?.textContent).not.toMatch(/读取|已读|未读/);
  });
});
