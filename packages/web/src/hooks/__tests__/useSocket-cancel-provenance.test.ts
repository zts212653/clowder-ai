import { describe, expect, it, vi } from 'vitest';
import { emitExplicitCancel, newCancelIdentity } from '../useSocket-cancel-provenance';

describe('useSocket explicit cancel provenance', () => {
  it('uses the native randomUUID implementation when available', () => {
    const originalCrypto = globalThis.crypto;
    const randomUUID = vi.fn(() => '00112233-4455-4677-8899-aabbccddeeff');
    const getRandomValues = vi.fn();
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues, randomUUID },
    });

    try {
      expect(newCancelIdentity('client')).toBe('client-00112233-4455-4677-8899-aabbccddeeff');
      expect(randomUUID).toHaveBeenCalledOnce();
      expect(getRandomValues).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it('uses browser random bytes for a UUIDv4 identity when randomUUID is unavailable', () => {
    const originalCrypto = globalThis.crypto;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      return bytes;
    });
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues, randomUUID: undefined },
    });

    try {
      expect(newCancelIdentity('action')).toBe('action-00010203-0405-4607-8809-0a0b0c0d0e0f');
      expect(getRandomValues).toHaveBeenCalledOnce();
      expect(getRandomValues.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
      expect(getRandomValues.mock.calls[0]?.[0]).toHaveLength(16);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it('IR-9: sends a volatile attributed action only while connected', () => {
    const emit = vi.fn();
    const socket = { connected: true, volatile: { emit } };

    const sent = emitExplicitCancel(socket, {
      threadId: 'thread-1',
      catId: 'fable5',
      clientInstanceId: 'client-1',
      actionId: 'action-1',
      intent: {
        sourceControl: 'chat_input_action',
        gesture: 'pointer',
        trustedGesture: true,
      },
    });

    expect(sent).toBe(true);
    expect(emit).toHaveBeenCalledWith('cancel_invocation', {
      threadId: 'thread-1',
      catId: 'fable5',
      origin: 'explicit_stop',
      actionId: 'action-1',
      clientInstanceId: 'client-1',
      sourceControl: 'chat_input_action',
      gesture: 'pointer',
      trustedGesture: true,
    });
  });

  it('drops a cancel that was not produced by a trusted browser gesture', () => {
    const emit = vi.fn();
    const socket = { connected: true, volatile: { emit } };

    const sent = emitExplicitCancel(socket, {
      threadId: 'thread-1',
      clientInstanceId: 'client-1',
      actionId: 'action-untrusted',
      intent: {
        sourceControl: 'chat_input_banner',
        gesture: 'pointer',
        trustedGesture: false,
      },
    });

    expect(sent).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('IR-9: drops stop while disconnected so Socket.IO cannot replay it on reconnect', () => {
    const emit = vi.fn();
    const socket = { connected: false, volatile: { emit } };

    const sent = emitExplicitCancel(socket, {
      threadId: 'thread-1',
      clientInstanceId: 'client-1',
      actionId: 'action-2',
      intent: {
        sourceControl: 'parallel_status_bar',
        gesture: 'keyboard',
        trustedGesture: true,
      },
    });

    expect(sent).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
