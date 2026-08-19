/**
 * F167 Phase Q — hold-ball lifecycle status refresh.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ConnectorBubble } from '../ConnectorBubble';

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: vi.fn(),
}));

describe('ConnectorBubble hold status lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockApiFetch = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockApiFetch.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function flushEffects() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function holdMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'm-hold-refresh',
      type: 'connector',
      content: 'hold is pending',
      timestamp: 1_780_000_000_000,
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        icon: 'hold-ball',
        meta: { taskId: 'hold-ball-refresh' },
      },
      ...overrides,
    };
  }

  it('refreshes status when the same hold bubble receives a newer connector message', async () => {
    mockApiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'active', cancelable: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'retired_by_event', cancelable: false }), { status: 200 }),
      );

    const initial = holdMessage();
    act(() => {
      root.render(React.createElement(ConnectorBubble, { message: initial }));
    });
    await flushEffects();

    expect(container.textContent).toContain('取消持球');

    act(() => {
      root.render(
        React.createElement(ConnectorBubble, {
          message: holdMessage({
            ...initial,
            content: 'review feedback arrived',
            timestamp: initial.timestamp + 1,
          }),
        }),
      );
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/callbacks/hold-ball/hold-ball-refresh/status');
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/callbacks/hold-ball/hold-ball-refresh/status');
    expect(container.textContent).toContain('已被事件唤醒');
    expect(container.textContent).not.toContain('取消持球');
  });
});
