import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageType } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], isLoading: false, getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: apiFetchMock }));

const { ChatMessage } = await import('../ChatMessage');

function makeClosureMessage(originTriggerMessageId: string | null, updatedAt: number): ChatMessageType {
  return {
    id: `freshness-closure:${originTriggerMessageId ?? 'legacy'}`,
    type: 'system',
    variant: 'info',
    catId: 'codex-sol',
    content: originTriggerMessageId ? '当前责任' : '历史未结责任',
    timestamp: updatedAt,
    extra: {
      freshnessClosure: {
        closureId: originTriggerMessageId ?? 'legacy',
        status: 'blocked',
        originTriggerMessageId,
        updatedAt,
        legacy: originTriggerMessageId === null,
      },
    },
  };
}

describe('F254 legacy closure presentation', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetchMock.mockReset();
    useChatStore.setState({ currentThreadId: 'thread-1', threads: [], messages: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the closure own recorded time and does not one-click retry legacy responsibility', () => {
    const updatedAt = Date.UTC(2026, 6, 11, 11, 45);

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: makeClosureMessage(null, updatedAt),
          getCatById: () => undefined,
        }),
      );
    });

    const recordedAt = container.querySelector('time[data-freshness-closure-recorded-at]');
    expect(recordedAt?.getAttribute('datetime')).toBe(new Date(updatedAt).toISOString());
    expect(container.textContent).toContain('历史责任');
    expect(container.textContent).toContain('等待迁移核销');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === '重试')).toBe(
      false,
    );
  });

  it('preserves explicit retry for a current attributable closure', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: makeClosureMessage('msg-current', Date.now()),
          getCatById: () => undefined,
        }),
      );
    });

    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === '重试')).toBe(true);
  });
});
