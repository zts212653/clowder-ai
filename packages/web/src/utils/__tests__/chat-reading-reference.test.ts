import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetChatScrollMemoryForTest,
  type ChatReadingSnapshot,
  captureChatReadingRef,
  readChatReadingRef,
  readChatScrollState,
  releaseChatReadingRef,
  saveChatScrollState,
} from '../chat-scroll-memory';

beforeEach(() => {
  localStorage.clear();
  __resetChatScrollMemoryForTest();
});

const origin = () => ({
  threadId: 'one/world:thread',
  position: {
    top: 1234,
    anchor: 'offset' as const,
    messageAnchor: { messageId: 'first-message', viewportOffsetPx: -88, timelineOrderAt: 100 },
  },
});

function capture(snapshot: ChatReadingSnapshot = origin()) {
  const captured = captureChatReadingRef(snapshot);
  if (!captured) throw new Error('Reading owner failed to capture a valid checkpoint');
  return captured;
}

describe('immutable references owned by thread reading memory', () => {
  it('refuses a pixel-only origin that cannot identify its reading place after layout changes', () => {
    expect(captureChatReadingRef({ threadId: 'loading-thread', position: { top: 200, anchor: 'offset' } })).toBeNull();
  });
  it('keeps the origin when current geometry and the caller snapshot change', () => {
    const snapshot = origin();
    const captured = capture(snapshot);
    expect(captured).toEqual({ ref: expect.any(String), persisted: true });
    snapshot.position.messageAnchor.viewportOffsetPx = 999;
    saveChatScrollState(snapshot.threadId, { top: 8000, anchor: 'bottom' });
    expect(readChatReadingRef(captured.ref)).toEqual(origin());
    const read = readChatReadingRef(captured.ref);
    if (!read) throw new Error('Missing original checkpoint');
    read.position.top = 42;
    expect(readChatReadingRef(captured.ref)).toEqual(origin());
    expect(readChatScrollState(snapshot.threadId)).toEqual({ top: 8000, anchor: 'bottom' });
  });

  it('survives a cold page, long time and a later capture without replacing the earlier ref', () => {
    const first = capture();
    const second = capture({ threadId: origin().threadId, position: { top: 6000, anchor: 'bottom' } });
    expect(first.ref).not.toBe(second.ref);
    __resetChatScrollMemoryForTest();
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(90 * 24 * 60 * 60 * 1000);
      expect(readChatReadingRef(first.ref)).toEqual(origin());
      expect(readChatReadingRef(second.ref)).toEqual({
        threadId: origin().threadId,
        position: { top: 6000, anchor: 'bottom' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases only the named owner reference after an explicit completion', () => {
    const first = capture();
    const second = capture();
    expect(releaseChatReadingRef(first.ref, 'another-thread')).toBe(false);
    expect(readChatReadingRef(first.ref)).toEqual(origin());
    expect(releaseChatReadingRef(first.ref, origin().threadId)).toBe(true);
    __resetChatScrollMemoryForTest();
    expect(readChatReadingRef(first.ref)).toBeUndefined();
    expect(readChatReadingRef(second.ref)).toEqual(origin());
  });

  it('keeps version-one geometry unchanged while the owner captures an immutable reference', () => {
    const key = `cat-cafe:thread-scroll:${encodeURIComponent(origin().threadId)}`;
    localStorage.setItem(key, JSON.stringify({ v: 1, state: { top: 50, anchor: 'bottom' } }));
    const captured = capture();
    __resetChatScrollMemoryForTest();
    expect(readChatScrollState(origin().threadId)).toEqual({ top: 50, anchor: 'bottom' });
    expect(readChatReadingRef(captured.ref)).toEqual(origin());
    expect(localStorage.getItem(key)).not.toContain('content');
  });

  it('reports unavailable persistence and keeps only the same-page reference', () => {
    const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Denied');
    });
    try {
      const captured = capture();
      expect(captured.persisted).toBe(false);
      expect(readChatReadingRef(captured.ref)).toEqual(origin());
      __resetChatScrollMemoryForTest();
      expect(readChatReadingRef(captured.ref)).toBeUndefined();
    } finally {
      denied.mockRestore();
    }
  });

  it('fails closed on unknown, malformed, corrupt and wrong-owner references', () => {
    expect(readChatReadingRef('')).toBeUndefined();
    expect(readChatReadingRef('chat-reading:%invalid:not-a-ref')).toBeUndefined();
    const captured = capture();
    const forged = captured.ref.replace(encodeURIComponent(origin().threadId), 'another-thread');
    expect(readChatReadingRef(forged)).toBeUndefined();
    const key = [...Array(localStorage.length).keys()]
      .map((index) => localStorage.key(index))
      .find((key) => key?.startsWith('cat-cafe:thread-scroll-ref:'));
    if (!key) throw new Error('Missing durable checkpoint record');
    localStorage.setItem(key, 'broken JSON');
    __resetChatScrollMemoryForTest();
    expect(readChatReadingRef(captured.ref)).toBeUndefined();
  });

  it('retains the original ref when storage denies its explicit release', () => {
    const captured = capture();
    const denied = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Denied');
    });
    try {
      expect(releaseChatReadingRef(captured.ref, origin().threadId)).toBe(false);
      expect(readChatReadingRef(captured.ref)).toEqual(origin());
      __resetChatScrollMemoryForTest();
      expect(readChatReadingRef(captured.ref)).toEqual(origin());
    } finally {
      denied.mockRestore();
    }
  });

  it('retains an immutable return point when another page writes only its legacy current position', () => {
    const captured = capture();
    const currentKey = `cat-cafe:thread-scroll:${encodeURIComponent(origin().threadId)}`;
    localStorage.setItem(currentKey, JSON.stringify({ v: 1, state: { top: 9000, anchor: 'bottom' } }));
    __resetChatScrollMemoryForTest();
    expect(readChatScrollState(origin().threadId)).toEqual({ top: 9000, anchor: 'bottom' });
    expect(readChatReadingRef(captured.ref)).toEqual(origin());
  });
});
