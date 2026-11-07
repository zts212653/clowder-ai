import type { HubSocket } from '@/hooks/useSocket-hub';

type Listener = (...args: unknown[]) => void;

/**
 * Test double for the page connection. It keeps the hub contract (nothing is sent while
 * disconnected, onConnected fires now and on every later connection, rooms are held by
 * count); tests drive server events and connections and read what was sent and held.
 */
export function createFakeHubSocket() {
  const listeners = new Map<string, Set<Listener>>();
  const roomHolders = new Map<string, number>();
  const sent: Array<[string, ...unknown[]]> = [];
  let socketId: string | null = null;
  let generation = 0;

  const deliver = (event: string, ...args: unknown[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
  };

  const hub: HubSocket = {
    on(event, typedListener) {
      const listener = typedListener as unknown as Listener;
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    },
    emit(event, ...args) {
      if (!socketId) return false;
      sent.push([event, ...args]);
      return true;
    },
    retainRoom(room) {
      roomHolders.set(room, (roomHolders.get(room) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (roomHolders.get(room) ?? 1) - 1;
        if (remaining > 0) roomHolders.set(room, remaining);
        else roomHolders.delete(room);
      };
    },
    onConnected(listener) {
      const release = hub.on('connect', () => {
        if (socketId) listener(socketId);
      });
      if (socketId) listener(socketId);
      return release;
    },
    connectedSocketId() {
      return socketId;
    },
  };

  return {
    hub,
    /** Server-side event arriving on the page connection. */
    deliver,
    /** A new physical connection with a fresh id. */
    connect() {
      socketId = `fake-socket-${++generation}`;
      deliver('connect');
      return socketId;
    },
    disconnect(reason = 'transport close') {
      socketId = null;
      deliver('disconnect', reason);
    },
    /** Payloads sent for one event, in order. */
    emitted(event: string): unknown[][] {
      return sent.filter(([name]) => name === event).map(([, ...args]) => args);
    },
    heldRooms(): string[] {
      return [...roomHolders.keys()];
    },
    listenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

export type FakeHubSocket = ReturnType<typeof createFakeHubSocket>;
