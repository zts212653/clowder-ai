import type { ProviderSubexecutionSemanticEvent } from '@cat-cafe/shared';
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
  return <div ref={history.scrollContainerRef} />;
}

const childEvent: ProviderSubexecutionSemanticEvent = {
  v: 1,
  id: 'subexecution:child-hydrated:final',
  kind: 'subexecution',
  occurredAt: 120,
  stage: 'message',
  subexecutionId: 'child-hydrated',
  rootExecutionId: 'root-session',
  parentExecutionId: 'root-session',
  rootTurnId: 'root-turn',
  parentTurnId: 'root-turn',
  turnId: 'child-turn',
  agentPath: '/root/review_delta',
  nickname: 'Bohr',
  depth: 1,
  content: 'child final remains separately attributed after refresh',
  messagePhase: 'final_answer',
};

describe('F307 child identity history hydration', () => {
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
      currentThreadId: 'thread-subexecution-history',
      threadStates: {},
    });
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'root-final-hydrated',
            type: 'assistant',
            catId: 'codex-sol',
            content: 'root final remains primary after refresh',
            metadata: {
              provider: 'openai',
              model: 'gpt-5.6-sol',
              sessionId: 'root-session',
              subexecutionEvents: [childEvent],
            },
            timestamp: 130,
          },
        ],
        tasks: [],
        hasMore: false,
      }),
    } as Response);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
  });

  it('retains the exact child identity alongside the root final on F5 hydration', async () => {
    await act(async () => {
      root.render(
        <ThreadChatHistoryAdmissionProvider>
          <HookProbe threadId="thread-subexecution-history" />
        </ThreadChatHistoryAdmissionProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const hydrated = useChatStore.getState().messages[0];
    expect(hydrated?.content).toBe('root final remains primary after refresh');
    expect(hydrated?.metadata?.subexecutionEvents).toEqual([childEvent]);
  });
});
