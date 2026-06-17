import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { resetThreadRuntimeSingleton } from '@/hooks/thread-runtime-singleton';
import {
  type BackgroundAgentMessage,
  type BackgroundStreamRef,
  handleBackgroundAgentMessage,
  useAgentMessages,
} from '@/hooks/useAgentMessages';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { resetSharedReplacedInvocations } from '../shared-replaced-invocations';

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
    resetThreadRuntimeSingleton();
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
  const bgStreamRefs = new Map<string, BackgroundStreamRef>();
  const bgFinalizedRefs = new Map<string, string>();
  const bgPendingCallbacks = new Map<string, BackgroundAgentMessage>();
  let bgSeq = 0;

  beforeEach(() => {
    cleanStoreState('thread-active');
    bgStreamRefs.clear();
    bgFinalizedRefs.clear();
    bgPendingCallbacks.clear();
    bgSeq = 0;
    resetSharedReplacedInvocations();
  });

  return {
    bgStreamRefs,
    dispatchBg(msg: BackgroundAgentMessage) {
      handleBackgroundAgentMessage(msg, {
        store: useChatStore.getState(),
        bgStreamRefs,
        finalizedBgRefs: bgFinalizedRefs,
        pendingCallbacks: bgPendingCallbacks,
        nextBgSeq: () => bgSeq++,
        addToast: () => {},
        clearDoneTimeout: () => {},
      });
    },
  };
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
