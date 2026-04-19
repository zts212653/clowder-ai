import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat-types';
import { useChatStore } from '../chatStore';

function makeAssistant(id: string): ChatMessage {
  return {
    id,
    type: 'assistant',
    catId: 'antig-opus',
    content: '',
    origin: 'stream',
    timestamp: Date.now(),
  };
}

describe('chatStore thinking dedupe', () => {
  beforeEach(() => {
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
      currentGame: null,
      threadStates: {},
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentThreadId: 'thread-thinking',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
  });

  it('does not append an identical consecutive thinking block', () => {
    const store = useChatStore.getState();
    store.addMessage(makeAssistant('msg-1'));

    store.setMessageThinking('msg-1', 'First thought');
    store.setMessageThinking('msg-1', 'First thought');

    const msg = useChatStore.getState().messages.find((m) => m.id === 'msg-1')!;
    expect(msg.thinking).toBe('First thought');
  });

  it('does not append an identical consecutive thinking block that contains the separator', () => {
    const store = useChatStore.getState();
    store.addMessage(makeAssistant('msg-1'));
    const thought = 'First thought\n\n---\n\nInner divider';

    store.setMessageThinking('msg-1', thought);
    store.setMessageThinking('msg-1', thought);

    const msg = useChatStore.getState().messages.find((m) => m.id === 'msg-1')!;
    expect(msg.thinking).toBe(thought);
  });

  it('still appends a distinct later thinking block with separator', () => {
    const store = useChatStore.getState();
    store.addMessage(makeAssistant('msg-1'));

    store.setMessageThinking('msg-1', 'First thought');
    store.setMessageThinking('msg-1', 'Second thought');

    const msg = useChatStore.getState().messages.find((m) => m.id === 'msg-1')!;
    expect(msg.thinking).toBe('First thought\n\n---\n\nSecond thought');
  });

  it('still appends a distinct later chunk when the previous chunk ends with the same suffix', () => {
    const store = useChatStore.getState();
    store.addMessage(makeAssistant('msg-1'));
    const firstThought = 'Intro\n\n---\n\nShared tail';

    store.setMessageThinking('msg-1', firstThought);
    store.setMessageThinking('msg-1', 'Shared tail');

    const msg = useChatStore.getState().messages.find((m) => m.id === 'msg-1')!;
    expect(msg.thinking).toBe(`${firstThought}\n\n---\n\nShared tail`);
  });

  it('keeps current thinking intact when stale thinkingChunks disagree with the rendered text', () => {
    useChatStore.setState({
      messages: [
        {
          ...makeAssistant('msg-1'),
          thinking: 'A\n\n---\n\nB\n\n---\n\nC',
          thinkingChunks: ['A', 'B'],
        },
      ],
    });

    useChatStore.getState().setMessageThinking('msg-1', 'B');

    const msg = useChatStore.getState().messages.find((m) => m.id === 'msg-1')!;
    expect(msg.thinking).toBe('A\n\n---\n\nB\n\n---\n\nC\n\n---\n\nB');
    expect(msg.thinkingChunks).toEqual(['A\n\n---\n\nB\n\n---\n\nC', 'B']);
  });
});
