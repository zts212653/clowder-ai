import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { type BackgroundAgentMessage, handleBackgroundAgentMessage, useAgentMessages } from '@/hooks/useAgentMessages';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

type ActiveAgentMessage = Parameters<ReturnType<typeof useAgentMessages>['handleAgentMessage']>[0];

let captured: ReturnType<typeof useAgentMessages> | undefined;

function Harness() {
  captured = useAgentMessages();
  return null;
}

export function cleanStoreState(currentThreadId = 'thread-1') {
  useChatStore.setState({
    messages: [],
    isLoading: false,
    isLoadingHistory: false,
    hasMore: true,
    hasActiveInvocation: false,
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catInvocations: {},
    activeInvocations: {},
    currentGame: null,
    threadStates: {},
    viewMode: 'single',
    splitPaneThreadIds: [],
    splitPaneTargetId: null,
    currentThreadId,
    currentProjectPath: 'default',
    threads: [],
    isLoadingThreads: false,
  });
}

export function installActiveHarness(options: { beforeEach?: () => void } = {}) {
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
    captured = undefined;
    cleanStoreState();
    options.beforeEach?.();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  return {
    render() {
      act(() => {
        root.render(React.createElement(Harness));
      });
    },
    send(msg: ActiveAgentMessage) {
      act(() => {
        captured?.handleAgentMessage(msg);
      });
    },
  };
}

export function installBackgroundHarness() {
  let bgSeq = 0;

  beforeEach(() => {
    cleanStoreState('thread-active');
    bgSeq = 0;
  });

  return {
    dispatchBg(msg: BackgroundAgentMessage) {
      handleBackgroundAgentMessage(msg, {
        store: useChatStore.getState(),
        nextBgSeq: () => bgSeq++,
        addToast: () => {},
      });
    },
  };
}

/**
 * The turn's response as the server stores it at dispatch and publishes it through its
 * lifecycle snapshot: empty, processing, under its real id.
 */
export function seedProcessingResponse(threadId: string, id: string, catId: string, invocationId: string) {
  useChatStore.getState().addMessageToThread(threadId, {
    id,
    type: 'assistant',
    catId,
    content: '',
    origin: 'stream',
    isStreaming: true,
    timestamp: 1000,
    lifecycle: {
      kind: 'response',
      orderKey: `1000:${invocationId}`,
      invocationId,
      targetId: catId,
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 1000,
    },
  });
}

export function flatCodexStreamBubbles(): ChatMessage[] {
  return useChatStore
    .getState()
    .messages.filter((m: ChatMessage) => m.type === 'assistant' && m.origin === 'stream' && m.catId === 'codex');
}

export function threadCodexStreamBubbles(threadId: string): ChatMessage[] {
  return useChatStore
    .getState()
    .getThreadState(threadId)
    .messages.filter((m: ChatMessage) => m.type === 'assistant' && m.origin === 'stream' && m.catId === 'codex');
}
