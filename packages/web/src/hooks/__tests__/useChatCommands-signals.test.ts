import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatCommands } from '../useChatCommands';

const mocks = vi.hoisted(() => {
  const mockAddMessage = vi.fn();
  const mockApiFetch = vi.fn();
  const useChatStoreMock = Object.assign(
    () => ({ addMessageToThread: (_threadId: string, message: Record<string, unknown>) => mockAddMessage(message) }),
    {
      getState: () => ({ currentThreadId: 'thread-1' }),
    },
  );

  return { mockAddMessage, mockApiFetch, useChatStoreMock };
});

vi.mock('@/stores/chatStore', () => ({
  useChatStore: mocks.useChatStoreMock,
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'user-1',
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.mockApiFetch(...args),
}));

interface HarnessProps {
  onReady: (fn: (input: string) => Promise<boolean>) => void;
}

function Harness({ onReady }: HarnessProps) {
  const { processCommand } = useChatCommands();

  React.useEffect(() => {
    onReady(processCommand);
  }, [onReady, processCommand]);

  return null;
}

function getLatestSystemMessageContent(): string | null {
  const calls = mocks.mockAddMessage.mock.calls as Array<[Record<string, unknown>]>;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const message = calls[i][0];
    if (message.type === 'system' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return null;
}

async function setupProcessCommand(root: Root): Promise<(input: string) => Promise<boolean>> {
  let processCommand: ((input: string) => Promise<boolean>) | null = null;

  await act(async () => {
    root.render(
      React.createElement(Harness, {
        onReady: (fn) => {
          processCommand = fn;
        },
      }),
    );
  });

  if (!processCommand) {
    throw new Error('processCommand not initialized');
  }

  return processCommand;
}

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('useChatCommands /signals', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.mockAddMessage.mockClear();
    mocks.mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('handles /signals by fetching inbox list', async () => {
    const processCommand = await setupProcessCommand(root);

    mocks.mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          items: [
            {
              id: 'signal_1',
              title: 'Claude 5 roadmap',
              source: 'anthropic-news',
              tier: 1,
              fetchedAt: '2026-02-19T08:00:00.000Z',
            },
          ],
        }),
    });

    let handled = false;
    await act(async () => {
      handled = await processCommand('/signals');
    });

    expect(handled).toBe(true);
    expect(mocks.mockApiFetch).toHaveBeenCalledWith('/api/signals/inbox?limit=20');
    expect(getLatestSystemMessageContent()).toContain('Claude 5 roadmap');
  });

  it('handles /signals search <query>', async () => {
    const processCommand = await setupProcessCommand(root);

    mocks.mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          total: 1,
          items: [
            {
              id: 'signal_2',
              title: 'Claude 5 evals',
              source: 'anthropic-news',
              tier: 1,
              fetchedAt: '2026-02-19T09:00:00.000Z',
            },
          ],
        }),
    });

    let handled = false;
    await act(async () => {
      handled = await processCommand('/signals search evals');
    });

    expect(handled).toBe(true);
    expect(mocks.mockApiFetch).toHaveBeenCalledWith('/api/signals/search?q=evals&limit=20');
    expect(getLatestSystemMessageContent()).toContain('Claude 5 evals');
  });

  it('handles /signals sources by listing source states', async () => {
    const processCommand = await setupProcessCommand(root);

    mocks.mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          sources: [
            {
              id: 'anthropic-news',
              name: 'Anthropic Newsroom',
              enabled: true,
              tier: 1,
              category: 'official',
              fetch: { method: 'webpage' },
              schedule: { frequency: 'daily' },
            },
          ],
        }),
    });

    let handled = false;
    await act(async () => {
      handled = await processCommand('/signals sources');
    });

    expect(handled).toBe(true);
    expect(mocks.mockApiFetch).toHaveBeenCalledWith('/api/signals/sources');
    expect(getLatestSystemMessageContent()).toContain('anthropic-news');
  });

  it('handles /signals stats', async () => {
    const processCommand = await setupProcessCommand(root);

    mocks.mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          todayCount: 2,
          weekCount: 5,
          unreadCount: 3,
          byTier: { '1': 5 },
          bySource: { 'anthropic-news': 3, 'openai-news-rss': 2 },
        }),
    });

    let handled = false;
    await act(async () => {
      handled = await processCommand('/signals stats');
    });

    expect(handled).toBe(true);
    expect(mocks.mockApiFetch).toHaveBeenCalledWith('/api/signals/stats');
    expect(getLatestSystemMessageContent()).toContain('today=2');
    expect(getLatestSystemMessageContent()).toContain('week=5');
  });

  it('handles /signals sources <id> on|off toggle', async () => {
    const processCommand = await setupProcessCommand(root);

    mocks.mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          source: {
            id: 'anthropic-news',
            enabled: false,
          },
        }),
    });

    let handled = false;
    await act(async () => {
      handled = await processCommand('/signals sources anthropic-news off');
    });

    expect(handled).toBe(true);
    expect(mocks.mockApiFetch).toHaveBeenCalledWith('/api/signals/sources/anthropic-news', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(getLatestSystemMessageContent()).toContain('anthropic-news');
    expect(getLatestSystemMessageContent()).toContain('disabled');
  });
});
