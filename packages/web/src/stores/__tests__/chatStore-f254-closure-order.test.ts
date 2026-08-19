import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat-types';
import { useChatStore } from '../chatStore';

function makeMessage(id: string, type: 'user' | 'assistant', timestamp: number, catId?: string): ChatMessage {
  return {
    id,
    type,
    content: id,
    timestamp,
    ...(catId ? { catId } : {}),
  };
}

function makeLegacyClosure(id: string, timestamp: number, sourceMessageId?: string): ChatMessage {
  return {
    id,
    type: 'system',
    variant: 'info',
    catId: 'codex-sol',
    content: '历史未结责任',
    timestamp,
    extra: {
      systemKind: 'freshness_closure',
      freshnessClosure: {
        closureId: id,
        status: 'blocked',
        sourceInvocationId: 'inv-legacy',
        ...(sourceMessageId ? { sourceMessageId } : {}),
        originTriggerMessageId: null,
        updatedAt: timestamp,
        legacy: true,
      },
    },
  };
}

const INITIAL_STATE = {
  messages: [],
  isLoading: false,
  isLoadingHistory: false,
  hasMore: true,
  hasActiveInvocation: false,
  hasDraft: false,
  intentMode: null,
  targetCats: [],
  catStatuses: {},
  catInvocations: {},
  currentGame: null,
  threadStates: {},
  viewMode: 'single' as const,
  splitPaneThreadIds: [],
  splitPaneTargetId: null,
  currentThreadId: 'thread-active',
  currentProjectPath: 'default',
  threads: [],
  isLoadingThreads: false,
};

describe('F254 legacy closure placement', () => {
  beforeEach(() => {
    useChatStore.setState(INITIAL_STATE);
  });

  afterEach(() => {
    useChatStore.setState(INITIAL_STATE);
  });

  it('anchors a hydrated closure immediately after its exact source instead of the current tail', () => {
    useChatStore.getState().addMessage(makeMessage('source', 'assistant', 100, 'codex-sol'));
    useChatStore.getState().addMessage(makeMessage('new-user', 'user', 1_000));
    useChatStore.getState().addMessage(makeMessage('new-answer', 'assistant', 1_100, 'codex-sol'));

    useChatStore.getState().addMessage(makeLegacyClosure('freshness-closure:old', 200, 'source'));

    expect(useChatStore.getState().messages.map((message) => message.id)).toEqual([
      'source',
      'freshness-closure:old',
      'new-user',
      'new-answer',
    ]);
  });

  it('keeps an unanchored old closure at its own timestamp instead of appending below recent work', () => {
    useChatStore.getState().addMessage(makeMessage('old-user', 'user', 100));
    useChatStore.getState().addMessage(makeMessage('recent-answer', 'assistant', 1_000, 'codex-sol'));

    useChatStore.getState().addMessage(makeLegacyClosure('freshness-closure:old', 200));

    expect(useChatStore.getState().messages.map((message) => message.id)).toEqual([
      'old-user',
      'freshness-closure:old',
      'recent-answer',
    ]);
  });

  it('applies the same historical placement to background thread hydration', () => {
    useChatStore.getState().addMessageToThread('thread-bg', makeMessage('old-user', 'user', 100));
    useChatStore
      .getState()
      .addMessageToThread('thread-bg', makeMessage('recent-answer', 'assistant', 1_000, 'codex-sol'));
    const beforeHydration = useChatStore.getState().threadStates['thread-bg'];

    useChatStore.getState().addMessageToThread('thread-bg', makeLegacyClosure('freshness-closure:old', 200));

    const afterHydration = useChatStore.getState().threadStates['thread-bg'];
    expect(afterHydration?.messages.map((message) => message.id)).toEqual([
      'old-user',
      'freshness-closure:old',
      'recent-answer',
    ]);
    expect(afterHydration?.unreadCount).toBe(beforeHydration?.unreadCount);
    expect(afterHydration?.lastActivity).toBe(beforeHydration?.lastActivity);
  });
});
