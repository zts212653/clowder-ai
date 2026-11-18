// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  __resetChatScrollMemoryForTest,
  captureChatReadingRef,
  describeChatReadingAnchor,
  findChatReadingSuccessor,
  readChatReadingRef,
  readChatScrollState,
  resolveChatReadingAnchor,
  saveChatScrollState,
} from '../chat-scroll-memory';

beforeEach(() => {
  localStorage.clear();
  __resetChatScrollMemoryForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser-local thread reading memory', () => {
  it.each([false, true])('captures an HTTP reading ref without randomUUID, storage denied=%s', (denied) => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    if (denied)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('Denied');
      });
    const original = {
      threadId: 'http-source',
      position: {
        top: 320,
        anchor: 'offset' as const,
        messageAnchor: { messageId: 'exact-source', viewportOffsetPx: 42 },
      },
    };
    const point = captureChatReadingRef(original);
    expect(point?.persisted).toBe(!denied);
    expect(point?.ref).toMatch(/^chat-reading:http-source:[0-9a-f-]{36}$/);
    if (!point) throw new Error('Expected the original reading owner ref');
    expect(readChatReadingRef(point.ref)).toEqual(original);
  });
  it('retains a specific source-card anchor through a fresh module cache instead of reducing it to its message', () => {
    const saved = {
      top: 800,
      anchor: 'offset' as const,
      messageAnchor: {
        messageId: 'exact-source',
        viewportOffsetPx: -400,
        richBlockId: 'original-card',
        richBlockViewportOffsetPx: 200,
      },
    };
    saveChatScrollState('rich-source', saved);
    __resetChatScrollMemoryForTest();
    expect(readChatScrollState('rich-source')).toEqual(saved);
  });
  it('chooses the next timeline survivor including equal-score ids, without carrying the deleted bubble key', () => {
    const point = (id: string, timestamp: number): ChatMessage => ({ id, timestamp, type: 'user', content: id });
    const anchor = { messageId: 'm2', viewportOffsetPx: -20, timelineOrderAt: 100, bubbleKey: 'deleted-bubble' };
    expect(
      findChatReadingSuccessor(anchor, [point('m4', 101), point('m1', 100), point('m3', 100), point('draft-new', 100)]),
    ).toEqual({ messageId: 'm3', viewportOffsetPx: -20, timelineOrderAt: 100 });
    expect(findChatReadingSuccessor({ ...anchor, timelineOrderAt: undefined }, [point('m4', 101)])).toBeUndefined();
    expect(findChatReadingSuccessor(anchor, [point('m1', 100)])).toBeUndefined();
  });
  it('retains exact identity and signed offset after a cold page with no expiry', () => {
    const state = {
      top: 1234,
      anchor: 'offset' as const,
      messageAnchor: {
        messageId: 'exact-id',
        viewportOffsetPx: -88,
        blockIndex: 4,
        blockFingerprint: 'p:当前阅读位置',
        blockViewportOffsetPx: -18,
      },
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

  it('never aliases a missing record to another message with the same child invocation', () => {
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
    expect(resolveChatReadingAnchor(persisted.messageAnchor, [transient])).toMatchObject({
      messageId: transient.id,
      viewportOffsetPx: -20,
      timelineOrderAt: 100,
    });
    expect(resolveChatReadingAnchor(persisted.messageAnchor, [formal])).toBeUndefined();
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
