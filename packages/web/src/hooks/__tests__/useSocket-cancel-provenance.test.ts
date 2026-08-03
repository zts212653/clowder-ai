import { describe, expect, it, vi } from 'vitest';
import { emitExplicitCancel } from '../useSocket-cancel-provenance';

describe('useSocket explicit cancel provenance', () => {
  it('IR-9: sends a volatile attributed action only while connected', () => {
    const emit = vi.fn();
    const socket = { connected: true, volatile: { emit } };

    const sent = emitExplicitCancel(socket, {
      threadId: 'thread-1',
      catId: 'fable5',
      clientInstanceId: 'client-1',
      actionId: 'action-1',
    });

    expect(sent).toBe(true);
    expect(emit).toHaveBeenCalledWith('cancel_invocation', {
      threadId: 'thread-1',
      catId: 'fable5',
      origin: 'explicit_stop',
      actionId: 'action-1',
      clientInstanceId: 'client-1',
    });
  });

  it('IR-9: drops stop while disconnected so Socket.IO cannot replay it on reconnect', () => {
    const emit = vi.fn();
    const socket = { connected: false, volatile: { emit } };

    const sent = emitExplicitCancel(socket, {
      threadId: 'thread-1',
      clientInstanceId: 'client-1',
      actionId: 'action-2',
    });

    expect(sent).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
