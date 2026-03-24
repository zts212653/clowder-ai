/**
 * F096: chatStore.updateRichBlock action tests
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

describe('F096: chatStore.updateRichBlock', () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages();
  });

  it('updates a rich block by id within a message', () => {
    const store = useChatStore.getState();
    store.addMessage({
      id: 'msg-1',
      type: 'assistant',
      content: 'pick one',
      timestamp: Date.now(),
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              id: 'i1',
              kind: 'interactive' as const,
              v: 1 as const,
              interactiveType: 'select' as const,
              options: [{ id: 'o1', label: 'A' }],
            },
          ],
        },
      },
    });

    store.updateRichBlock('msg-1', 'i1', { disabled: true, selectedIds: ['o1'] });

    const msg = useChatStore.getState().messages.find((m) => m.id === 'msg-1');
    const block = msg?.extra?.rich?.blocks[0] as unknown as Record<string, unknown>;
    expect(block?.disabled).toBe(true);
    expect(block?.selectedIds).toEqual(['o1']);
  });

  it('does not affect other blocks in the same message', () => {
    const store = useChatStore.getState();
    store.addMessage({
      id: 'msg-2',
      type: 'assistant',
      content: 'two blocks',
      timestamp: Date.now(),
      extra: {
        rich: {
          v: 1,
          blocks: [
            { id: 'b1', kind: 'card' as const, v: 1 as const, title: 'Unchanged' },
            {
              id: 'i2',
              kind: 'interactive' as const,
              v: 1 as const,
              interactiveType: 'confirm' as const,
              options: [{ id: '__confirm__', label: '确认' }],
            },
          ],
        },
      },
    });

    store.updateRichBlock('msg-2', 'i2', { disabled: true, selectedIds: ['__confirm__'] });

    const msg = useChatStore.getState().messages.find((m) => m.id === 'msg-2');
    expect(msg?.extra?.rich?.blocks[0]?.kind).toBe('card');
    expect((msg?.extra?.rich?.blocks[0] as unknown as Record<string, unknown>)?.disabled).toBeUndefined();
    expect((msg?.extra?.rich?.blocks[1] as unknown as Record<string, unknown>)?.disabled).toBe(true);
  });

  it('no-op when message not found', () => {
    const store = useChatStore.getState();
    // Should not throw
    store.updateRichBlock('nonexistent', 'b1', { disabled: true });
    expect(useChatStore.getState().messages.length).toBe(0);
  });
});
