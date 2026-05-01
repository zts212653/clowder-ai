import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapDebugFromStorage,
  clearDebugEvents,
  configureDebug,
  dumpDebugEvents,
  ensureWindowDebugApi,
  getDebugStatus,
  invocationDebugConstants,
  recordDebugEvent,
} from '../invocationEventDebug';

describe('invocationEventDebug', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearDebugEvents();
    configureDebug({ enabled: false });
    delete (window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug;
  });

  afterEach(() => {
    vi.useRealTimers();
    clearDebugEvents();
    configureDebug({ enabled: false });
    delete (window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug;
  });

  it('is fully disabled by default and does not mount window API', () => {
    expect(getDebugStatus().enabled).toBe(false);

    recordDebugEvent({ event: 'queue_updated', threadId: 'thread-a', timestamp: 1 });

    expect(dumpDebugEvents()).toMatchObject({ meta: { count: 0 } });
    expect((window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug).toBeUndefined();
  });

  it('enables recording and mounts window API explicitly', () => {
    configureDebug({ enabled: true, size: 120, ttlMs: 5 * 60_000 });
    ensureWindowDebugApi();

    recordDebugEvent({ event: 'queue_updated', threadId: 'thread-a', action: 'processing', timestamp: 10 });

    const dump = dumpDebugEvents();
    expect(dump.meta.count).toBe(1);
    expect((window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug).toBeTruthy();
  });

  it('exposes dumpBubbleTimeline() and returns only bubble lifecycle/invariant events', () => {
    configureDebug({ enabled: true });
    ensureWindowDebugApi();

    recordDebugEvent({
      event: 'queue_updated',
      threadId: 'thread-a',
      action: 'processing',
      timestamp: 1,
    });
    recordDebugEvent({
      event: 'bubble_lifecycle',
      threadId: 'thread-a',
      timestamp: 2,
      action: 'create',
      reason: 'active-late-bind',
      catId: 'opus',
      messageId: 'msg-stream-1',
      invocationId: 'inv-1',
      origin: 'stream',
    } as Parameters<typeof recordDebugEvent>[0]);
    recordDebugEvent({
      event: 'bubble_invariant_violation',
      threadId: 'thread-a',
      timestamp: 3,
      actorId: 'opus',
      canonicalInvocationId: 'inv-1',
      bubbleKind: 'assistant_text',
      eventType: 'callback_final',
      originPhase: 'callback/history',
      sourcePath: 'callback',
      existingMessageId: 'msg-stream-1',
      incomingMessageId: 'msg-callback-1',
      seq: 7,
      recoveryAction: 'quarantine',
      violationKind: 'duplicate',
      level: 'warn',
    } as Parameters<typeof recordDebugEvent>[0]);

    const debugApi = (
      window as typeof window & {
        __catCafeDebug?: { dumpBubbleTimeline?: (options?: { rawThreadId?: boolean }) => string };
      }
    ).__catCafeDebug;

    expect(debugApi?.dumpBubbleTimeline).toBeTypeOf('function');
    const dumpBubbleTimeline = debugApi?.dumpBubbleTimeline;
    if (!dumpBubbleTimeline) throw new Error('dumpBubbleTimeline not mounted');

    const dump = JSON.parse(dumpBubbleTimeline({ rawThreadId: true })) as {
      meta: { count: number };
      events: Array<Record<string, unknown>>;
    };

    expect(dump.meta.count).toBe(2);
    expect(dump.events).toEqual([
      expect.objectContaining({
        event: 'bubble_lifecycle',
        threadId: 'thread-a',
        action: 'create',
        reason: 'active-late-bind',
        catId: 'opus',
        messageId: 'msg-stream-1',
        invocationId: 'inv-1',
        origin: 'stream',
      }),
      expect.objectContaining({
        event: 'bubble_invariant_violation',
        actorId: 'opus',
        canonicalInvocationId: 'inv-1',
        bubbleKind: 'assistant_text',
        eventType: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        existingMessageId: 'msg-stream-1',
        incomingMessageId: 'msg-callback-1',
        seq: 7,
        recoveryAction: 'quarantine',
        violationKind: 'duplicate',
        level: 'warn',
      }),
    ]);
  });

  it('records history_replace events with action and reason payload', () => {
    configureDebug({ enabled: true });

    recordDebugEvent({
      event: 'history_replace',
      threadId: 'thread-a',
      action: 'merge_local',
      queueLength: 3,
      reason: 'history=2,current=3,preservedLocal=1',
      timestamp: 42,
    });

    const dump = dumpDebugEvents({ rawThreadId: true });
    expect(dump.events[0]).toMatchObject({
      event: 'history_replace',
      threadId: 'thread-a',
      action: 'merge_local',
      queueLength: 3,
      reason: 'history=2,current=3,preservedLocal=1',
      timestamp: 42,
    });
  });

  it('clamps size to min=50 max=500 and defaults invalid values to 200', () => {
    configureDebug({ enabled: true, size: 10 });
    expect(getDebugStatus().size).toBe(50);

    configureDebug({ enabled: true, size: 9999 });
    expect(getDebugStatus().size).toBe(500);

    configureDebug({ enabled: true, size: Number.NaN });
    expect(getDebugStatus().size).toBe(200);
  });

  it('resetToDisabled restores default size for next debug session', () => {
    configureDebug({ enabled: true, size: 500 });
    expect(getDebugStatus().size).toBe(500);

    configureDebug({ enabled: false });
    expect(getDebugStatus().size).toBe(200);

    configureDebug({ enabled: true });
    expect(getDebugStatus().size).toBe(200);
  });

  it('expires by TTL and clear buffer, and re-enable refreshes TTL', () => {
    configureDebug({ enabled: true, ttlMs: 1_000 });
    recordDebugEvent({ event: 'intent_mode', threadId: 'thread-a', mode: 'execute', timestamp: 1 });
    expect(dumpDebugEvents().meta.count).toBe(1);

    vi.advanceTimersByTime(900);
    configureDebug({ enabled: true, ttlMs: 1_000 }); // refresh ttl
    vi.advanceTimersByTime(900);
    expect(getDebugStatus().enabled).toBe(true);
    expect(dumpDebugEvents().meta.count).toBe(1);

    vi.advanceTimersByTime(101);
    expect(getDebugStatus().enabled).toBe(false);
    expect(dumpDebugEvents().meta.count).toBe(0);
  });

  it('dump masks threadId by default, raw threadId requires explicit RAW mode', () => {
    configureDebug({ enabled: true });
    recordDebugEvent({ event: 'done', threadId: 'thread-secret-123', isFinal: true, timestamp: 20 });

    const masked = dumpDebugEvents();
    expect(masked.meta.rawThreadId).toBe(false);
    expect(masked.events[0]?.threadId).not.toBe('thread-secret-123');

    const raw = dumpDebugEvents({ rawThreadId: true });
    expect(raw.meta.rawThreadId).toBe(true);
    expect(raw.meta.marker).toBe('RAW');
    expect(raw.events[0]?.threadId).toBe('thread-secret-123');
  });

  it('dump returns deep-copied queueStatuses so callers cannot mutate internal buffer', () => {
    configureDebug({ enabled: true });
    recordDebugEvent({
      event: 'queue_updated',
      threadId: 'thread-a',
      queueStatuses: ['processing'],
      timestamp: 30,
    });

    const firstDump = dumpDebugEvents({ rawThreadId: true });
    const firstEvent = firstDump.events[0] as { queueStatuses?: string[] } | undefined;
    firstEvent?.queueStatuses?.push('mutated');

    const secondDump = dumpDebugEvents({ rawThreadId: true });
    const secondEvent = secondDump.events[0] as { queueStatuses?: string[] } | undefined;
    expect(secondEvent?.queueStatuses).toEqual(['processing']);
  });

  it('enforces whitelist and strips blocked payload fields from dumps', () => {
    configureDebug({ enabled: true });

    recordDebugEvent({
      event: 'agent_message',
      threadId: 'thread-x',
      timestamp: 100,
      // blocked-like fields should never be preserved
      content: 'sensitive',
      token: 'secret-token',
      headers: { authorization: 'Bearer x' },
      userInput: 'should-not-appear',
    } as unknown as Parameters<typeof recordDebugEvent>[0]);

    const dump = dumpDebugEvents({ rawThreadId: true });
    const item = dump.events[0] as Record<string, unknown>;

    expect(item.content).toBeUndefined();
    expect(item.token).toBeUndefined();
    expect(item.headers).toBeUndefined();
    expect(item.userInput).toBeUndefined();
    expect(item.event).toBe('agent_message');
    expect(item.threadId).toBe('thread-x');
  });

  it('falls back to sessionStorage when localStorage has no debug key (P1 regression)', () => {
    const originalLocalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const originalSessionDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const localGetItem = vi.fn(() => null);
    const sessionGetItem = vi.fn((key: string) => (key === invocationDebugConstants.STORAGE_KEY ? '1' : null));

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: localGetItem } as Partial<Storage>,
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: sessionGetItem } as Partial<Storage>,
    });

    try {
      bootstrapDebugFromStorage();
      expect(getDebugStatus().enabled).toBe(true);
      expect(localGetItem).toHaveBeenCalledWith(invocationDebugConstants.STORAGE_KEY);
      expect(sessionGetItem).toHaveBeenCalledWith(invocationDebugConstants.STORAGE_KEY);
    } finally {
      if (originalLocalDescriptor) Object.defineProperty(window, 'localStorage', originalLocalDescriptor);
      if (originalSessionDescriptor) Object.defineProperty(window, 'sessionStorage', originalSessionDescriptor);
    }
  });

  it('falls back to sessionStorage when localStorage getItem throws', () => {
    const originalLocalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const originalSessionDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const localGetItem = vi.fn(() => {
      throw new Error('storage blocked');
    });
    const sessionGetItem = vi.fn((key: string) => (key === invocationDebugConstants.STORAGE_KEY ? '1' : null));

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: localGetItem } as Partial<Storage>,
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: sessionGetItem } as Partial<Storage>,
    });

    try {
      bootstrapDebugFromStorage();
      expect(getDebugStatus().enabled).toBe(true);
      expect(localGetItem).toHaveBeenCalledWith(invocationDebugConstants.STORAGE_KEY);
      expect(sessionGetItem).toHaveBeenCalledWith(invocationDebugConstants.STORAGE_KEY);
    } finally {
      if (originalLocalDescriptor) Object.defineProperty(window, 'localStorage', originalLocalDescriptor);
      if (originalSessionDescriptor) Object.defineProperty(window, 'sessionStorage', originalSessionDescriptor);
    }
  });

  it('handles SecurityError when localStorage property access throws', () => {
    const originalLocalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const originalSessionDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const sessionGetItem = vi.fn((key: string) => (key === invocationDebugConstants.STORAGE_KEY ? '1' : null));

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: sessionGetItem } as Partial<Storage>,
    });

    try {
      bootstrapDebugFromStorage();
      expect(getDebugStatus().enabled).toBe(true);
      expect(sessionGetItem).toHaveBeenCalledWith(invocationDebugConstants.STORAGE_KEY);
    } finally {
      if (originalLocalDescriptor) Object.defineProperty(window, 'localStorage', originalLocalDescriptor);
      if (originalSessionDescriptor) Object.defineProperty(window, 'sessionStorage', originalSessionDescriptor);
    }
  });

  it('ignores malformed JSON config and keeps debug disabled', () => {
    const originalLocalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const originalSessionDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const localGetItem = vi.fn(() => '{}');
    const sessionGetItem = vi.fn(() => null);

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: localGetItem } as Partial<Storage>,
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: sessionGetItem } as Partial<Storage>,
    });

    try {
      bootstrapDebugFromStorage();
      expect(getDebugStatus().enabled).toBe(false);
      expect((window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug).toBeUndefined();
    } finally {
      if (originalLocalDescriptor) Object.defineProperty(window, 'localStorage', originalLocalDescriptor);
      if (originalSessionDescriptor) Object.defineProperty(window, 'sessionStorage', originalSessionDescriptor);
    }
  });

  it('clears persisted debug key on TTL expiry to prevent auto-reenable', () => {
    const originalLocalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const originalSessionDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    let sessionValue: string | null = '1';
    const localRemoveItem = vi.fn();
    const sessionRemoveItem = vi.fn(() => {
      sessionValue = null;
    });

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        removeItem: localRemoveItem,
      } as Partial<Storage>,
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (key === invocationDebugConstants.STORAGE_KEY ? sessionValue : null),
        removeItem: sessionRemoveItem,
      } as Partial<Storage>,
    });

    try {
      bootstrapDebugFromStorage();
      expect(getDebugStatus().enabled).toBe(true);
      configureDebug({ enabled: true, ttlMs: 1000 });

      vi.advanceTimersByTime(1001);

      expect(getDebugStatus().enabled).toBe(false);
      expect(localRemoveItem).toHaveBeenCalledWith(invocationDebugConstants.STORAGE_KEY);
      expect(sessionRemoveItem).toHaveBeenCalledWith(invocationDebugConstants.STORAGE_KEY);

      bootstrapDebugFromStorage();
      expect(getDebugStatus().enabled).toBe(false);
    } finally {
      if (originalLocalDescriptor) Object.defineProperty(window, 'localStorage', originalLocalDescriptor);
      if (originalSessionDescriptor) Object.defineProperty(window, 'sessionStorage', originalSessionDescriptor);
    }
  });

  it('does not re-enable from persisted config when expiresAt is already in the past', () => {
    const originalLocalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const originalSessionDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    let localValue: string | null = JSON.stringify({
      enabled: true,
      size: 200,
      ttlMs: 1800000,
      expiresAt: Date.now() - 1000,
    });
    const localRemoveItem = vi.fn(() => {
      localValue = null;
    });

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (key === invocationDebugConstants.STORAGE_KEY ? localValue : null),
        setItem: vi.fn(),
        removeItem: localRemoveItem,
      } as Partial<Storage>,
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        removeItem: vi.fn(),
      } as Partial<Storage>,
    });

    try {
      bootstrapDebugFromStorage();
      expect(getDebugStatus().enabled).toBe(false);
      expect(localRemoveItem).toHaveBeenCalledWith(invocationDebugConstants.STORAGE_KEY);
    } finally {
      if (originalLocalDescriptor) Object.defineProperty(window, 'localStorage', originalLocalDescriptor);
      if (originalSessionDescriptor) Object.defineProperty(window, 'sessionStorage', originalSessionDescriptor);
    }
  });

  it('keeps session-scoped opt-in in sessionStorage (no promotion to local)', () => {
    const originalLocalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const originalSessionDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const localSetItem = vi.fn();
    const sessionSetItem = vi.fn();

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: localSetItem,
      } as Partial<Storage>,
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (key === invocationDebugConstants.STORAGE_KEY ? '1' : null),
        setItem: sessionSetItem,
      } as Partial<Storage>,
    });

    try {
      bootstrapDebugFromStorage();
      expect(getDebugStatus().enabled).toBe(true);
      expect(localSetItem).not.toHaveBeenCalled();
      expect(sessionSetItem).toHaveBeenCalled();
    } finally {
      if (originalLocalDescriptor) Object.defineProperty(window, 'localStorage', originalLocalDescriptor);
      if (originalSessionDescriptor) Object.defineProperty(window, 'sessionStorage', originalSessionDescriptor);
    }
  });

  it('continues probing storages when local payload is malformed and session payload is valid', () => {
    const originalLocalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const originalSessionDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (key === invocationDebugConstants.STORAGE_KEY ? '{bad-json' : null),
      } as Partial<Storage>,
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (key === invocationDebugConstants.STORAGE_KEY ? '1' : null),
        setItem: vi.fn(),
      } as Partial<Storage>,
    });

    try {
      bootstrapDebugFromStorage();
      expect(getDebugStatus().enabled).toBe(true);
    } finally {
      if (originalLocalDescriptor) Object.defineProperty(window, 'localStorage', originalLocalDescriptor);
      if (originalSessionDescriptor) Object.defineProperty(window, 'sessionStorage', originalSessionDescriptor);
    }
  });
});
