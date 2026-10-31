import { createCatId, type ProviderSubexecutionSemanticEvent } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { MessageStore } from '../../../../api/src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveSubexecutionLog } from '../../../../api/src/domains/concierge/live/live-subexecution-log.js';
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

  it('exposes standalone Live usage records from the actual Message writer while the root is still running', async () => {
    const threadId = 'thread-subexecution-history';
    const store = new MessageStore();
    const log = new LiveSubexecutionLog({
      scope: { userId: 'owner', threadId, catId: createCatId('codex61-sol'), callId: 'call' },
      rootThread: () => 'root',
      available: () => true,
      verify: async () => true,
      store,
      publish() {},
    });
    log.rootStarted('root', 'turn-root');
    const common = {
      type: 'app_server.subexecution' as const,
      subexecution_id: 'child',
      root_execution_id: 'root',
      parent_execution_id: 'root',
      root_turn_id: 'turn-root',
      parent_turn_id: 'turn-root',
      agent_path: '/root/reader',
      depth: 1,
    };
    await log.observe({ ...common, event_id: 'started', occurred_at: 1000, stage: 'started' });
    await log.observe({
      ...common,
      event_id: 'result',
      occurred_at: 1250,
      stage: 'message',
      turn_id: 'child-turn',
      content: 'Two distinct reports',
      message_phase: 'final_answer',
    });
    await log.observe({
      ...common,
      event_id: 'completed',
      occurred_at: 1500,
      stage: 'completed',
      turn_id: 'child-turn',
    });
    const records = await store.getByThread(threadId);
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: records, tasks: [], hasMore: false }),
    } as Response);
    await act(async () => {
      root.render(
        <ThreadChatHistoryAdmissionProvider>
          <HookProbe threadId={threadId} />
        </ThreadChatHistoryAdmissionProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const hydrated = useChatStore.getState().messages;
    expect(hydrated).toHaveLength(3);
    expect(hydrated.map((m) => m.metadata?.subexecutionEvents?.[0]?.stage)).toEqual([
      'started',
      'message',
      'completed',
    ]);
    expect(hydrated[1]?.content).toContain('Two distinct reports');
    expect(hydrated[2]?.content).toContain('结果引用：thread:thread-subexecution-history#');
    expect(hydrated[2]?.content).toContain('家内工具不可用');
    log.close();
  });
});
