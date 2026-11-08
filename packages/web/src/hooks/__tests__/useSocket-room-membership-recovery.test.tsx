/**
 * PR-3a2 (contract §3.11.1 / §3.11.2): a confirmed join carries the join id its stream replay was
 * sent under, and says whether it is the first confirmation in this period the room is wanted.
 */
import type { RoomJoinAck } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RoomConfirmation, useRoomMembershipReconciler } from '../useSocket-room-membership';

const ROOM = 'thread:thread-A';

describe('useRoomMembershipReconciler confirmations', () => {
  let container: HTMLDivElement;
  let root: Root;
  let reconciler: ReturnType<typeof useRoomMembershipReconciler> | null;
  let pendingAcks: Array<(ack: RoomJoinAck) => void>;
  let confirmations: Array<[string, RoomConfirmation]>;
  let desiredRoomsRef: { current: Set<string> };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pendingAcks = [];
    confirmations = [];
    const emit = vi.fn((event: string, _room: string, acknowledge: (ack: RoomJoinAck) => void) => {
      if (event === 'join_room') pendingAcks.push(acknowledge);
    });
    const socketRef = { current: { connected: true, emit } as unknown as Socket };
    desiredRoomsRef = { current: new Set([ROOM]) };
    function HookWrapper() {
      reconciler = useRoomMembershipReconciler(socketRef, desiredRoomsRef, (room, confirmation) =>
        confirmations.push([room, confirmation]),
      );
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
  });

  function joinAndAck(joinId?: string) {
    act(() => reconciler?.requestRoomJoin(ROOM));
    const acknowledge = pendingAcks.shift();
    expect(acknowledge).toBeDefined();
    act(() => acknowledge?.({ ok: true, room: ROOM, ...(joinId ? { joinId } : {}) }));
  }

  it('passes the join id through and marks the first confirmation of a wanted period', () => {
    joinAndAck('j1');
    expect(confirmations).toEqual([[ROOM, { joinId: 'j1', firstInNeededPeriod: true }]]);
  });

  it('does not open a new period on a reconnect while the room stays wanted', () => {
    joinAndAck('j1');
    act(() => reconciler?.resetConfirmedRoomMembership());
    joinAndAck('j2');
    expect(confirmations.map(([, confirmation]) => confirmation)).toEqual([
      { joinId: 'j1', firstInNeededPeriod: true },
      { joinId: 'j2', firstInNeededPeriod: false },
    ]);
  });

  it('opens a new period once the room was given up and is wanted again', () => {
    joinAndAck('j1');
    act(() => reconciler?.forgetRoom(ROOM));
    desiredRoomsRef.current.add(ROOM);
    joinAndAck('j2');
    expect(confirmations.map(([, confirmation]) => confirmation.firstInNeededPeriod)).toEqual([true, true]);
  });

  it('rejects the acknowledgement of a join given up before the room was wanted again (Astra R1)', () => {
    act(() => reconciler?.requestRoomJoin(ROOM));
    const oldAck = pendingAcks.shift()!;
    act(() => reconciler?.forgetRoom(ROOM));
    desiredRoomsRef.current.add(ROOM);
    act(() => reconciler?.requestRoomJoin(ROOM));
    const newAck = pendingAcks.shift()!;
    act(() => oldAck({ ok: true, room: ROOM, joinId: 'old-period' }));
    expect(confirmations).toEqual([]);
    act(() => newAck({ ok: true, room: ROOM, joinId: 'new-period' }));
    expect(confirmations).toEqual([[ROOM, { joinId: 'new-period', firstInNeededPeriod: true }]]);
  });

  it('confirms an older server that names no join', () => {
    joinAndAck();
    expect(confirmations).toEqual([[ROOM, { firstInNeededPeriod: true }]]);
  });
});
