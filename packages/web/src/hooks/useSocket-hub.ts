import { useMemo, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { useRoomMembershipReconciler } from './useSocket-room-membership';

/** Stored form of a listener; callers keep their own payload types through `on`'s type parameter. */
type HubListener = (...args: unknown[]) => void;

/**
 * The page's one Socket.IO connection, as seen by features outside the chat runtime
 * (docs/plans/2026-11-05-hub-one-socket-per-page.md, slice A). Connecting, reconnecting
 * and disconnecting stay with the runtime that owns the socket; holders only listen,
 * send, and keep non-thread rooms joined.
 */
export interface HubSocket {
  /** Listens to a server event on the page connection, across reconnects. Returns its release. */
  on<Args extends unknown[]>(event: string, listener: (...args: Args) => void): () => void;
  /** Sends on the page connection. Nothing is sent, and false returned, while disconnected. */
  emit(event: string, ...args: unknown[]): boolean;
  /**
   * Keeps a non-thread room joined while held, re-joining after every reconnect with the
   * same acknowledged retries as thread rooms. Returns its release; the room is left when
   * the last holder releases.
   */
  retainRoom(room: string): () => void;
  /** Called now if connected, then on every later connection, with that connection's id. */
  onConnected(listener: (socketId: string) => void): () => void;
  /** Id of the live connection, or null while disconnected. */
  connectedSocketId(): string | null;
}

type ValueRef<T> = { current: T };

/** Owned by the socket runtime: builds the hub and the hooks the runtime calls at each lifecycle edge. */
export function useHubSocketOutlet(socketRef: ValueRef<Socket | null>) {
  const listenersRef = useRef(new Map<string, Set<HubListener>>());
  const dispatchersRef = useRef(new Map<string, HubListener>());
  const attachedSocketRef = useRef<Socket | null>(null);
  const roomHoldersRef = useRef(new Map<string, number>());
  const desiredRoomsRef = useRef(new Set<string>());
  const rooms = useRoomMembershipReconciler(socketRef, desiredRoomsRef);
  // The reconciler's callbacks are stable; the object holding them is not, so the hub depends on them only.
  const { forgetRoom, requestRoomJoin, resetConfirmedRoomMembership } = rooms;

  const outlet = useMemo(() => {
    const dispatcherFor = (event: string): HubListener => {
      let dispatcher = dispatchersRef.current.get(event);
      if (!dispatcher) {
        dispatcher = (...args) => {
          for (const listener of [...(listenersRef.current.get(event) ?? [])]) listener(...args);
        };
        dispatchersRef.current.set(event, dispatcher);
      }
      return dispatcher;
    };

    const hub: HubSocket = {
      on(event, typedListener) {
        // Socket.IO payloads are untyped on the wire; the caller declared what this event carries.
        const listener = typedListener as unknown as HubListener;
        let listeners = listenersRef.current.get(event);
        if (!listeners) {
          listeners = new Set();
          listenersRef.current.set(event, listeners);
          attachedSocketRef.current?.on(event, dispatcherFor(event));
        }
        listeners.add(listener);
        return () => {
          if (!listeners.delete(listener) || listeners.size > 0) return;
          listenersRef.current.delete(event);
          const dispatcher = dispatchersRef.current.get(event);
          dispatchersRef.current.delete(event);
          if (dispatcher) attachedSocketRef.current?.off(event, dispatcher);
        };
      },
      emit(event, ...args) {
        const socket = socketRef.current;
        if (!socket?.connected) return false;
        socket.emit(event, ...args);
        return true;
      },
      retainRoom(room) {
        const holders = roomHoldersRef.current.get(room) ?? 0;
        roomHoldersRef.current.set(room, holders + 1);
        if (holders === 0) {
          desiredRoomsRef.current.add(room);
          requestRoomJoin(room);
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const remaining = (roomHoldersRef.current.get(room) ?? 1) - 1;
          if (remaining > 0) {
            roomHoldersRef.current.set(room, remaining);
            return;
          }
          roomHoldersRef.current.delete(room);
          forgetRoom(room);
          const socket = socketRef.current;
          if (socket?.connected) socket.emit('leave_room', room);
        };
      },
      onConnected(listener) {
        const release = hub.on('connect', () => {
          const id = socketRef.current?.id;
          if (id) listener(id);
        });
        const id = hub.connectedSocketId();
        if (id) listener(id);
        return release;
      },
      connectedSocketId() {
        const socket = socketRef.current;
        return socket?.connected && socket.id ? socket.id : null;
      },
    };

    return {
      hub,
      /** The runtime created its socket: route every held event to it. */
      attach(socket: Socket) {
        attachedSocketRef.current = socket;
        for (const event of listenersRef.current.keys()) socket.on(event, dispatcherFor(event));
      },
      /** The runtime is disposing its socket. */
      detach(socket: Socket) {
        for (const [event, dispatcher] of dispatchersRef.current) socket.off(event, dispatcher);
        if (attachedSocketRef.current === socket) attachedSocketRef.current = null;
        resetConfirmedRoomMembership();
      },
    };
  }, [forgetRoom, requestRoomJoin, resetConfirmedRoomMembership, socketRef]);

  return {
    ...outlet,
    /** A new connection is a new server session: re-join every held room. */
    reconcileOnConnect: rooms.reconcileDesiredRoomMembership,
    resetOnDisconnect: rooms.resetConfirmedRoomMembership,
    reconcileNeverAttempted: rooms.reconcileNeverAttemptedRoomMembership,
    reconcileUnconfirmed: rooms.reconcileUnconfirmedRoomMembership,
  };
}
