import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

const block = { id: 'f022-card', kind: 'card' as const, v: 1 as const, title: 'F022' };
const laterBlock = { id: 'f022-later-card', kind: 'card' as const, v: 1 as const, title: 'F022 later' };
const owner = { catId: 'opus', invocationId: 'parent-1', turnInvocationId: 'turn-1' };

function message(id: string, origin: 'stream' | 'callback', turnInvocationId = 'turn-1') {
  return {
    id,
    type: 'assistant' as const,
    catId: 'opus',
    content: id,
    origin,
    timestamp: Date.now(),
    extra: {
      stream: { invocationId: 'parent-1', turnInvocationId },
      ...(origin === 'callback' ? { isExplicitPost: true } : {}),
      ...(origin === 'stream' ? { rich: { v: 1 as const, blocks: [block] } } : {}),
    },
  };
}

describe('rich block preview ownership', () => {
  beforeEach(() => {
    useChatStore.setState({ currentThreadId: 'active', messages: [], threadStates: {} });
  });

  it('moves two stream previews to their successive definitive callback messages', () => {
    const store = useChatStore.getState();
    const stream = message('stream-current', 'stream');
    store.addMessage({ ...stream, extra: { ...stream.extra, rich: { v: 1, blocks: [block, laterBlock] } } });
    store.addMessage(message('callback-a', 'callback'));
    store.addMessage(message('callback-b', 'callback'));
    store.appendRichBlock('callback-a', block, owner);
    store.appendRichBlock('callback-b', laterBlock, owner);

    const messages = useChatStore.getState().messages;
    expect(messages.find((m) => m.id === 'stream-current')?.extra?.rich?.blocks).toEqual([]);
    expect(messages.find((m) => m.id === 'callback-a')?.extra?.rich?.blocks).toEqual([block]);
    expect(messages.find((m) => m.id === 'callback-b')?.extra?.rich?.blocks).toEqual([laterBlock]);
  });

  it('moves only the matching turn preview in a background thread', () => {
    const store = useChatStore.getState();
    store.addMessageToThread('background', message('stream-current', 'stream'));
    store.addMessageToThread('background', message('stream-other-turn', 'stream', 'turn-older'));
    store.addMessageToThread('background', message('callback-owner', 'callback'));
    store.appendRichBlockToThread('background', 'callback-owner', block, owner);

    const messages = useChatStore.getState().getThreadState('background').messages;
    expect(messages.find((m) => m.id === 'stream-current')?.extra?.rich?.blocks).toEqual([]);
    expect(messages.find((m) => m.id === 'stream-other-turn')?.extra?.rich?.blocks).toEqual([block]);
    expect(messages.find((m) => m.id === 'callback-owner')?.extra?.rich?.blocks).toEqual([block]);
  });

  it('moves a direct invocation preview when the stream omits a redundant turn id', () => {
    const store = useChatStore.getState();
    const stream = message('stream-direct', 'stream');
    store.addMessage({
      ...stream,
      extra: { ...stream.extra, stream: { invocationId: 'direct-1' } },
    });
    store.addMessage(message('callback-direct', 'callback'));
    store.appendRichBlock('callback-direct', block, {
      catId: 'opus',
      invocationId: 'direct-1',
      turnInvocationId: 'direct-1',
    });

    const messages = useChatStore.getState().messages;
    expect(messages.find((m) => m.id === 'stream-direct')?.extra?.rich?.blocks).toEqual([]);
    expect(messages.find((m) => m.id === 'callback-direct')?.extra?.rich?.blocks).toEqual([block]);
  });
  it.each(['active', 'background'])('replaces a revised widget without duplicating it in %s', (threadId) => {
    const store = useChatStore.getState();
    const widget = { id: 'widget', kind: 'html_widget' as const, v: 1 as const, html: '<p>Draft</p>' };
    store.addMessageToThread(threadId, {
      ...message('response', 'stream'),
      extra: { rich: { v: 1, blocks: [block, widget, laterBlock] } },
    });
    const revised = { ...widget, html: '<p>Corrected</p>' };
    store.appendRichBlockToThread(threadId, 'response', revised);
    const rich = useChatStore.getState().getThreadState(threadId).messages[0]?.extra?.rich;
    expect(rich?.blocks).toEqual([block, revised, laterBlock]);
    store.appendRichBlockToThread(threadId, 'response', { ...revised });
    expect(useChatStore.getState().getThreadState(threadId).messages[0]?.extra?.rich?.blocks).toEqual(rich?.blocks);
  });
});
