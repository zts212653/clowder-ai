/**
 * ADR-008 S8: Frontend message action tests
 *
 * Tests store-level removeMessage + socket event routing logic.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { type ChatMessage, useChatStore } from '@/stores/chatStore';

function makMsg(id: string, type: 'user' | 'assistant' = 'user'): ChatMessage {
  return { id, type, content: `msg-${id}`, timestamp: Date.now() };
}

describe('chatStore.removeMessage', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: [] });
  });

  it('removes a message by id', () => {
    const store = useChatStore.getState();
    store.addMessage(makMsg('a'));
    store.addMessage(makMsg('b'));
    store.addMessage(makMsg('c'));

    store.removeMessage('b');

    const ids = useChatStore.getState().messages.map((m) => m.id);
    expect(ids).toEqual(['a', 'c']);
  });

  it('is a no-op for nonexistent id', () => {
    const store = useChatStore.getState();
    store.addMessage(makMsg('a'));

    store.removeMessage('nonexistent');

    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it('handles removing from empty messages', () => {
    const store = useChatStore.getState();
    store.removeMessage('anything');
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('removeMessage then re-add works', () => {
    const store = useChatStore.getState();
    store.addMessage(makMsg('a'));
    store.removeMessage('a');
    store.addMessage(makMsg('a'));

    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0]?.id).toBe('a');
  });
});
