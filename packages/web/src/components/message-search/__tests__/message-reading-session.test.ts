import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetChatScrollMemoryForTest, captureChatReadingRef, readChatReadingRef } from '@/utils/chat-scroll-memory';
import type { MessageFindContext } from '../message-find-state';
import {
  readActiveMessageReadingSession,
  saveMessageReadingSession,
  startMessageReadingSession,
} from '../message-reading-session';
import type { MessageReadingTrip } from '../message-reading-trip';

const trip = (searchId = 'first'): MessageReadingTrip => ({
  searchId,
  origin: { threadId: 'origin', readingRef: 'opaque-original-owner' },
  targets: [
    { threadId: 'a', messageId: 'one' },
    { threadId: 'a', messageId: 'two' },
  ],
  generation: 1,
  settledIndex: null,
  pending: { kind: 'target', index: 0 },
  status: 'moving',
});

describe('durable message reading sessions', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetChatScrollMemoryForTest();
    vi.restoreAllMocks();
  });
  it('retains immutable coordinates and original owner ref without expiry or copied content', () => {
    const initial = trip();
    const source = {
      ...initial,
      origin: { ...initial.origin },
      targets: initial.targets.map((target) => ({ ...target })),
    };
    const started = startMessageReadingSession(source, true);
    expect(started.persisted).toBe(true);
    source.origin.readingRef = 'substituted';
    source.targets[0].messageId = 'substituted';
    const recovered = readActiveMessageReadingSession();
    expect(recovered?.trip.origin.readingRef).toBe('opaque-original-owner');
    expect(recovered?.trip.targets[0].messageId).toBe('one');
    expect(recovered?.trip.searchId).toBe('first');
    expect(JSON.stringify(recovered)).not.toMatch(/snippet|content|expires|scrollTop/);
  });
  it('recovers an interrupted operation without replaying its pending navigation', () => {
    startMessageReadingSession(trip(), true);
    expect(readActiveMessageReadingSession()?.trip).toMatchObject({
      status: 'interrupted',
      pending: null,
      generation: 2,
      settledIndex: null,
    });
  });
  it('cannot let a late completion replace a newer explicitly opened session', () => {
    const first = startMessageReadingSession(trip(), true).session;
    const second = startMessageReadingSession(trip('second'), true).session;
    expect(
      saveMessageReadingSession({ ...first, trip: { ...first.trip, pending: null, status: 'ready', settledIndex: 0 } }),
    ).toBe(false);
    expect(readActiveMessageReadingSession()?.id).toBe(second.id);
    expect(localStorage.length).toBe(2);
  });
  it('retains only the reachable session and its original-owner ref after repeated explicit searches', () => {
    let previous: string | undefined;
    for (let n = 0; n < 50; n++) {
      const captured = captureChatReadingRef({ threadId: 'origin', position: { top: n, anchor: 'bottom' } })!;
      const started = startMessageReadingSession(
        { ...trip(`search-${n}`), origin: { threadId: 'origin', readingRef: captured.ref } },
        true,
      );
      expect(started.persisted).toBe(true);
      if (previous) expect(readChatReadingRef(previous)).toBeUndefined();
      expect(readChatReadingRef(captured.ref)).toBeDefined();
      expect(localStorage.length).toBe(3);
      previous = captured.ref;
    }
  });
  it('retains completed records without offering another automatic trip', () => {
    const first = startMessageReadingSession(trip(), true).session;
    expect(saveMessageReadingSession({ ...first, trip: { ...first.trip, pending: null, status: 'completed' } })).toBe(
      true,
    );
    expect(readActiveMessageReadingSession()?.trip.status).toBe('completed');
    expect(localStorage.length).toBe(2);
  });
  it('reports failed persistence and rejects malformed records', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    expect(startMessageReadingSession(trip(), false).persisted).toBe(false);
    expect(saveMessageReadingSession({ id: 'bad-id', originPersisted: true, trip: trip() })).toBe(false);
    expect(readActiveMessageReadingSession()).toBeNull();
  });
  it('keeps the previous session reachable if activating a new record fails', () => {
    const first = startMessageReadingSession(trip(), true).session;
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'cat-cafe:message-reading-active:v1') throw new Error('activation denied');
      return write.call(this, key, value);
    });
    expect(startMessageReadingSession(trip('second'), true).persisted).toBe(false);
    expect(readActiveMessageReadingSession()?.id).toBe(first.id);
    expect(localStorage.length).toBe(2);
  });
  it('retires malformed private metadata without touching another persistence owner', () => {
    localStorage.setItem('cat-cafe:message-reading-session:invalid', '{broken');
    localStorage.setItem('review-draft:owned-by-review', 'keep');
    expect(startMessageReadingSession(trip(), true).persisted).toBe(true);
    expect(localStorage.getItem('cat-cafe:message-reading-session:invalid')).toBeNull();
    expect(localStorage.getItem('review-draft:owned-by-review')).toBe('keep');
    expect(localStorage.length).toBe(3);
  });

  it('keeps a find-page return and its UI state in the original J5 session without inventing a message target', () => {
    const find: MessageFindContext = {
      destination: 'memory',
      state: { query: '一行', scope: 'global', sort: 'relevance', scrollTop: 214, status: 'idle' },
    };
    const origin = captureChatReadingRef({ threadId: 'origin', position: { top: 125, anchor: 'bottom' } })!;
    const value: MessageReadingTrip = {
      ...trip(),
      origin: { threadId: 'origin', readingRef: origin.ref },
      targets: [],
      status: 'ready',
      pending: null,
      generation: 0,
    };
    const started = startMessageReadingSession(value, true, find);
    expect(started.persisted).toBe(true);
    const restored = readActiveMessageReadingSession();
    expect(restored?.find).toEqual(find);
    expect(restored?.trip.targets).toEqual([]);
    expect(restored?.trip.origin.readingRef).toBe(origin.ref);
    expect(readChatReadingRef(origin.ref)).toBeDefined();
    expect(JSON.stringify(restored)).not.toContain('expires');
  });

  it('does not accept a targetless message trip without a valid find-page context', () => {
    expect(() => startMessageReadingSession({ ...trip(), targets: [] }, true)).toThrow();
  });
});
