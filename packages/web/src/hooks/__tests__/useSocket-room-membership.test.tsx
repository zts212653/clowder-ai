import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoomMembershipReconciler } from '../useSocket-room-membership';

const ROOM = 'thread:thread-A';

type Reconciler = ReturnType<typeof useRoomMembershipReconciler>;

describe('useRoomMembershipReconciler', () => {
  let container: HTMLDivElement;
  let root: Root;
  let reconciler: Reconciler | null;
  let emitMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    reconciler = null;
    emitMock = vi.fn();

    const socketRef = {
      current: { connected: true, emit: emitMock } as unknown as Socket,
    };
    const desiredRoomsRef = { current: new Set([ROOM]) };
    function HookWrapper() {
      reconciler = useRoomMembershipReconciler(socketRef, desiredRoomsRef);
      return null;
    }

    act(() => {
      root.render(React.createElement(HookWrapper));
    });
  });

  afterEach(() => {
    act(() => {
      reconciler?.resetConfirmedRoomMembership();
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
  });

  it('bounds unacknowledged joins with exponential backoff', async () => {
    act(() => {
      reconciler?.requestRoomJoin(ROOM);
    });

    const joinCalls = () => emitMock.mock.calls.filter(([event, room]) => event === 'join_room' && room === ROOM);
    expect(joinCalls()).toHaveLength(1);

    // First retry: 1s ACK timeout + 250ms base delay.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_250);
    });
    expect(joinCalls()).toHaveLength(2);

    // Second retry waits 500ms after its ACK timeout, not another 250ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_250);
    });
    expect(joinCalls()).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(joinCalls()).toHaveLength(3);

    // Initial request plus five retries is the complete per-epoch budget.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(joinCalls()).toHaveLength(6);

    // Foreground reconciliation may probe once, but must not refill the
    // connection-scoped timer retry budget.
    act(() => {
      reconciler?.reconcileUnconfirmedRoomMembership();
    });
    expect(joinCalls()).toHaveLength(7);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(joinCalls()).toHaveLength(7);
  });
});
