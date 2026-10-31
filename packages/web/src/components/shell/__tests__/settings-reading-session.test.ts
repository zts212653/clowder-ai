import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureChatReadingRef, readChatReadingRef } from '@/utils/chat-scroll-memory';
import {
  clearSettingsReadingSession,
  readSettingsReadingSession,
  settingsReadingSessionKey,
  startSettingsReadingSession,
} from '../settings-reading-session';

function source(threadId = 'origin-a', label = 'Origin A') {
  const checkpoint = captureChatReadingRef({
    threadId,
    position: { top: 320, anchor: 'offset', messageAnchor: { messageId: 'message-a', viewportOffsetPx: 42 } },
  });
  if (!checkpoint) throw new Error('reading owner did not capture the fixture position');
  return { threadId, label, readingRef: checkpoint.ref };
}

describe('Settings navigation association behind the original reading owner', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('does not invent a source from a direct entry or its from parameter', () => {
    window.history.replaceState(null, '', '/settings?from=origin-a');
    expect(readSettingsReadingSession()).toBeNull();
  });

  it('persists the real title and opaque ref without copying geometry or draft contents', () => {
    const origin = source();
    const started = startSettingsReadingSession(origin);
    expect(started.persisted).toBe(true);
    expect(readSettingsReadingSession()).toEqual(started.session);
    expect(JSON.parse(window.localStorage.getItem(settingsReadingSessionKey()) ?? 'null')).toEqual({
      v: 2,
      session: started.session,
      attempted: false,
    });
    expect(started.session).toEqual({ id: expect.any(String), ...origin });
    expect(readChatReadingRef(origin.readingRef)?.position.top).toBe(320);
  });

  it('keeps two tab records durable while replacement and exact consumption affect only their own tab', () => {
    const first = startSettingsReadingSession(source(), 'tab-a');
    expect(readSettingsReadingSession('tab-b')).toBeNull();
    const second = startSettingsReadingSession(source('origin-b', 'Origin B'), 'tab-b');
    expect(readSettingsReadingSession('tab-a')).toEqual(first.session);
    expect(readSettingsReadingSession('tab-b')).toEqual(second.session);
    expect(readChatReadingRef(first.session.readingRef)).toBeDefined();
    expect(clearSettingsReadingSession(first.session.id, 'tab-b').cleared).toBe(false);
    expect(clearSettingsReadingSession(first.session.id, 'tab-a').cleared).toBe(true);
    expect(readSettingsReadingSession('tab-b')).toEqual(second.session);
    expect(readChatReadingRef(second.session.readingRef)).toBeDefined();
  });

  it('retires the previous ref only after a new association becomes reachable', () => {
    const previous = startSettingsReadingSession(source());
    const next = startSettingsReadingSession(source('origin-b', 'Origin B'));
    expect(readSettingsReadingSession()).toEqual(next.session);
    expect(readChatReadingRef(previous.session.readingRef)).toBeUndefined();
    expect(readChatReadingRef(next.session.readingRef)?.threadId).toBe('origin-b');
  });

  it('cannot consume a new source through an old clear or old return completion', () => {
    const previous = startSettingsReadingSession(source());
    const next = startSettingsReadingSession(source('origin-b', 'Origin B'));
    expect(clearSettingsReadingSession(previous.session.id)).toEqual({ cleared: false, referenceReleased: false });
    expect(readSettingsReadingSession()).toEqual(next.session);
    expect(readChatReadingRef(next.session.readingRef)?.threadId).toBe('origin-b');
  });

  it('preserves the old durable association and ref when activation cannot be written', () => {
    const previous = startSettingsReadingSession(source());
    const nativeSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === settingsReadingSessionKey()) throw new Error('storage denied');
      nativeSet.call(this, key, value);
    });
    const next = startSettingsReadingSession(source('origin-b', 'Origin B'));
    expect(next.persisted).toBe(false);
    expect(readSettingsReadingSession()).toEqual(previous.session);
    expect(readChatReadingRef(previous.session.readingRef)?.threadId).toBe('origin-a');
    expect(readChatReadingRef(next.session.readingRef)?.threadId).toBe('origin-b');
  });

  it('clears the exact completed association and releases only its original owner ref', () => {
    const active = startSettingsReadingSession(source());
    expect(clearSettingsReadingSession(active.session.id)).toEqual({ cleared: true, referenceReleased: true });
    expect(readSettingsReadingSession()).toBeNull();
    expect(readChatReadingRef(active.session.readingRef)).toBeUndefined();
  });

  it('reports a failed clear and preserves its reachable record and ref', () => {
    const active = startSettingsReadingSession(source());
    const nativeRemove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
      if (key === settingsReadingSessionKey()) throw new Error('storage denied');
      nativeRemove.call(this, key);
    });
    expect(clearSettingsReadingSession(active.session.id)).toEqual({ cleared: false, referenceReleased: false });
    expect(readSettingsReadingSession()).toEqual(active.session);
    expect(readChatReadingRef(active.session.readingRef)?.threadId).toBe('origin-a');
  });

  it('rejects a stored ref that belongs to a different conversation', () => {
    const active = startSettingsReadingSession(source());
    window.localStorage.setItem(
      settingsReadingSessionKey(),
      JSON.stringify({
        v: 2,
        attempted: false,
        session: { ...active.session, threadId: 'other-thread' },
      }),
    );
    expect(readSettingsReadingSession()).toBeNull();
  });

  it('rejects legacy garbage without releasing a ref it does not own', () => {
    const origin = source();
    window.localStorage.setItem(settingsReadingSessionKey(), '{bad json');
    expect(readSettingsReadingSession()).toBeNull();
    expect(readChatReadingRef(origin.readingRef)?.threadId).toBe('origin-a');
  });
});
