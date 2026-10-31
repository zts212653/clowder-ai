import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMsg } from '@/hooks/agent-messages/types';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { reconcileThreadWithServer } from '@/hooks/useSocket';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';

vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));
const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: mockApiFetch }));

describe('one response owns the terminal outcome across recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  let handle: (msg: AgentMsg) => void;
  beforeAll(() => Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true }));
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  function Harness() {
    handle = useAgentMessages().handleAgentMessage;
    return null;
  }
  beforeEach(() => {
    mockApiFetch.mockReset();
    useChatStore.setState({
      currentThreadId: 'active',
      messages: [],
      threadStates: {},
      activeInvocations: {},
      catInvocations: {},
      catStatuses: {},
      targetCats: [],
      isLoading: false,
      hasActiveInvocation: false,
      intentMode: null,
      threads: [],
      isLoadingThreads: false,
    });
    useToastStore.setState({ toasts: [] });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function seed(threadId: string) {
    const store = useChatStore.getState();
    store.addMessageToThread(threadId, {
      id: 'response',
      type: 'assistant',
      catId: 'opus',
      content: 'already streamed',
      timestamp: 1,
      isStreaming: true,
      lifecycle: {
        kind: 'response',
        invocationId: 'turn',
        targetId: 'opus',
        orderKey: '1:response',
        inputEntryIds: ['entry'],
        inputMessageIds: ['source'],
        status: 'processing',
        startedAt: 1,
      },
    });
    store.addThreadActiveInvocation(threadId, 'parent', 'opus', 'execute', 1);
    store.setThreadCatInvocation(threadId, 'opus', { invocationId: 'parent', turnInvocationId: 'turn' });
  }
  function rows(threadId: string) {
    return useChatStore.getState().getThreadState(threadId).messages;
  }
  function terminal(threadId: string, messageId: string | undefined = 'response') {
    return {
      type: 'error',
      threadId,
      messageId,
      catId: 'opus',
      invocationId: 'parent',
      turnInvocationId: 'turn',
      error: 'provider failed',
      isFinal: true,
      timestamp: 2,
    } as AgentMsg;
  }

  it.each(['active', 'background'])('failure and repeated late done keep only the named response in %s', (threadId) => {
    seed(threadId);
    act(() => {
      handle(terminal(threadId));
      handle(terminal(threadId));
      handle({ ...terminal(threadId), type: 'done', content: '', error: undefined });
    });
    expect(rows(threadId).map((m) => m.id)).toEqual(['response']);
    expect(rows(threadId)[0]).toMatchObject({ content: 'already streamed', isStreaming: false });
    expect(useChatStore.getState().getThreadState(threadId).activeInvocations).toEqual({});
  });

  it.each(['active', 'background'])('admission failure without a response has one visible result in %s', (threadId) => {
    const event = terminal(threadId);
    delete event.messageId;
    act(() => {
      handle(event);
      handle(event);
    });
    expect(rows(threadId)).toHaveLength(1);
    expect(rows(threadId)[0]).toMatchObject({ type: 'system', variant: 'error' });
    expect(rows(threadId)[0]?.content).toContain('provider failed');
  });

  it('silence alone never changes the result or creates a wait-window message', () => {
    vi.useFakeTimers();
    seed('active');
    act(() => {
      handle({
        type: 'text',
        threadId: 'active',
        messageId: 'response',
        catId: 'opus',
        invocationId: 'parent',
        turnInvocationId: 'turn',
        content: ' tail',
        timestamp: 2,
      });
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(rows('active').map((m) => m.id)).toEqual(['response']);
    expect(rows('active')[0]?.isStreaming).toBe(true);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it.each([
    'active',
    'background',
  ])('unknown canonical state preserves the response and running identity in %s', async (threadId) => {
    seed(threadId);
    const before = useChatStore.getState().getThreadState(threadId).activeInvocations;
    mockApiFetch.mockResolvedValue(new Response(JSON.stringify({ queue: [] }), { status: 200 }));
    await act(async () => reconcileThreadWithServer(threadId, () => false, 'Unknown'));
    expect(useChatStore.getState().getThreadState(threadId).activeInvocations).toEqual(before);
    expect(rows(threadId)[0]?.isStreaming).toBe(true);
    expect(rows(threadId).map((m) => m.id)).toEqual(['response']);
  });

  it.each([
    'active',
    'background',
  ])('cold hydration and finished-server repair converge without another history row in %s', async (threadId) => {
    seed(threadId);
    mockApiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          queue: [],
          activeInvocations: [{ catId: 'opus', executionId: 'parent', turnInvocationId: 'turn', startedAt: 1 }],
        }),
        { status: 200 },
      ),
    );
    await act(async () => reconcileThreadWithServer(threadId, () => false, 'Hydration'));
    expect(useChatStore.getState().getThreadState(threadId).catInvocations.opus).toMatchObject({
      invocationId: 'parent',
      turnInvocationId: 'turn',
    });
    mockApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ queue: [], activeInvocations: [] }), { status: 200 }),
    );
    await act(async () => reconcileThreadWithServer(threadId, () => false, 'Reconnect'));
    act(() => handle({ ...terminal(threadId), type: 'done', error: undefined }));
    expect(rows(threadId)).toHaveLength(1);
    expect(rows(threadId)[0]).toMatchObject({ id: 'response', content: 'already streamed', isStreaming: false });
  });

  it.each(['active', 'background'])('served facts are attached to the response the event names in %s', (threadId) => {
    seed(threadId);
    act(() =>
      handle({
        type: 'system_info',
        threadId,
        catId: 'opus',
        messageId: 'response',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'opus',
          model: 'model-1',
          provider: 'provider-1',
          usage: { inputTokens: 10, outputTokens: 2 },
          served: {
            servedModel: 'model-served',
            servedModelSource: 'ws_response_object',
            upstreamTurnStateLength: 312,
          },
        }),
      }),
    );
    expect(rows(threadId)).toHaveLength(1);
    expect(rows(threadId)[0]?.metadata).toMatchObject({
      model: 'model-1',
      provider: 'provider-1',
      servedModel: 'model-served',
      servedModelSource: 'ws_response_object',
      upstreamTurnStateLength: 312,
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });

  it('an old child terminal cannot clear a newer child under the same parent', () => {
    seed('active');
    useChatStore.getState().setCatInvocation('opus', { turnInvocationId: 'new-child' });
    act(() => handle(terminal('active')));
    expect(useChatStore.getState().catInvocations.opus).toMatchObject({
      invocationId: 'parent',
      turnInvocationId: 'new-child',
    });
    expect(useChatStore.getState().activeInvocations).toHaveProperty('parent');
    expect(rows('active')).toHaveLength(1);
  });
});
