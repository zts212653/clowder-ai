import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  __resetChatScrollMemoryForTest,
  describeChatReadingAnchor,
  findChatReadingSuccessor,
  readChatScrollState,
  resolveChatReadingAnchor,
  saveChatScrollState,
} from '../chat-scroll-memory';

beforeEach(() => {
  localStorage.clear();
  __resetChatScrollMemoryForTest();
});

describe('browser-local thread reading memory', () => {
  it('chooses the next timeline survivor including equal-score ids, without carrying the deleted bubble key', () => {
    const point = (id: string, timestamp: number): ChatMessage => ({ id, timestamp, type: 'user', content: id });
    const anchor = { messageId: 'm2', viewportOffsetPx: -20, timelineOrderAt: 100, bubbleKey: 'deleted-bubble' };
    expect(
      findChatReadingSuccessor(anchor, [point('m4', 101), point('m1', 100), point('m3', 100), point('draft-new', 100)]),
    ).toEqual({ messageId: 'm3', viewportOffsetPx: -20, timelineOrderAt: 100, bubbleKey: undefined });
    expect(findChatReadingSuccessor({ ...anchor, timelineOrderAt: undefined }, [point('m4', 101)])).toBeUndefined();
    expect(findChatReadingSuccessor(anchor, [point('m1', 100)])).toBeUndefined();
  });
  it('retains exact identity and signed offset after a cold page with no expiry', () => {
    const state = {
      top: 1234,
      anchor: 'offset' as const,
      messageAnchor: { messageId: 'exact-id', viewportOffsetPx: -88 },
    };
    saveChatScrollState('one/world:thread', state);
    __resetChatScrollMemoryForTest();
    vi.useFakeTimers();
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000);
    expect(readChatScrollState('one/world:thread')).toEqual(state);
    expect(readChatScrollState('another-thread')).toBeUndefined();
    vi.useRealTimers();
  });

  it.each([
    'broken json',
    '{"v":2,"state":{"top":100,"anchor":"bottom"}}',
    '{"v":1,"state":{"top":-1,"anchor":"bottom"}}',
    '{"v":1,"state":{"top":1,"anchor":"offset","messageAnchor":{"messageId":"x","viewportOffsetPx":"oops"}}}',
    '{"v":1,"state":{"top":1,"anchor":"offset","messageAnchor":{"messageId":"","viewportOffsetPx":0}}}',
  ])('ignores invalid persisted geometry: %s', (raw) => {
    localStorage.setItem('cat-cafe:thread-scroll:corrupt', raw);
    expect(readChatScrollState('corrupt')).toBeUndefined();
  });

  it('keeps same-session navigation usable when browser storage is unavailable', () => {
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Denied');
    });
    expect(() => saveChatScrollState('unavailable', { top: 800, anchor: 'bottom' })).not.toThrow();
    expect(readChatScrollState('unavailable')).toEqual({ top: 800, anchor: 'bottom' });
    failure.mockRestore();
  });

  it('resolves a cold transient id only through a unique identity from the bubble owner', () => {
    const transient: ChatMessage = {
      id: 'draft-transient',
      type: 'assistant',
      catId: 'codex',
      content: 'private body',
      timestamp: 100,
      extra: { stream: { turnInvocationId: 'same-turn' } },
    };
    const anchor = describeChatReadingAnchor({ messageId: transient.id, viewportOffsetPx: -20 }, [transient]);
    saveChatScrollState('rekeyed', { top: 400, anchor: 'offset', messageAnchor: anchor });
    expect(localStorage.getItem('cat-cafe:thread-scroll:rekeyed')).not.toContain(transient.content);
    __resetChatScrollMemoryForTest();
    const persisted = readChatScrollState('rekeyed');
    if (persisted?.anchor !== 'offset' || !persisted.messageAnchor) throw new Error('Missing persisted anchor');
    const formal = { ...transient, id: 'stored-message' };
    expect(resolveChatReadingAnchor(persisted.messageAnchor, [formal])).toMatchObject({
      messageId: formal.id,
      viewportOffsetPx: -20,
      timelineOrderAt: 100,
    });
    expect(resolveChatReadingAnchor(persisted.messageAnchor, [formal, { ...formal, id: 'another' }])).toBeUndefined();
    expect(
      resolveChatReadingAnchor(persisted.messageAnchor, [
        {
          ...formal,
          extra: { ...formal.extra, isExplicitPost: true },
        },
      ]),
    ).toBeUndefined();
  });
});
