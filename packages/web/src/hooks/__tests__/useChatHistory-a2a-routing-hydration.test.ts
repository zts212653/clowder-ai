/**
 * F322 S3: the v2 reply-side handoff is a read projection of the durable
 * `a2a_routing` message. Cold hydration must therefore retain its coordinates;
 * classic still renders the same persisted system row.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

function HookProbe({ threadId }: { threadId: string }) {
  const history = useChatHistory(threadId);
  return React.createElement('div', {
    ref: history.scrollContainerRef,
    style: { height: '100px', overflow: 'auto' },
  });
}

function HookHost({ threadId }: { threadId: string }) {
  return React.createElement(ThreadChatHistoryAdmissionProvider, null, React.createElement(HookProbe, { threadId }));
}

describe('F322 S3 — cold hydration preserves the durable a2a carrier', () => {
  const apiFetchMock = vi.mocked(apiFetch);
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
    useChatStore.setState({
      messages: [],
      hasMore: false,
      isLoadingHistory: false,
      currentThreadId: 'thread-a2a',
      threadStates: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
  });

  it('copies systemKind and a2aRouting into the hydrated system message', async () => {
    const a2aRouting = {
      fromCatId: 'f322-codex-probe',
      targetCatId: 'f322-codex-recipient',
      invocationId: 'parent-invocation',
    };
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'route-1',
            type: 'system',
            content: 'F322 Codex Probe → F322 Codex Recipient',
            timestamp: 1700000000000,
            extra: { systemKind: 'a2a_routing', a2aRouting },
          },
        ],
        tasks: [],
        hasMore: false,
      }),
    } as Response);

    await act(async () => root.render(React.createElement(HookHost, { threadId: 'thread-a2a' })));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const [message] = useChatStore.getState().messages;
    expect(message.extra?.systemKind).toBe('a2a_routing');
    expect(message.extra?.a2aRouting).toEqual(a2aRouting);
  });
});
