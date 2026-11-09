import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HubSocket, useHubSocketOutlet } from '../useSocket-hub';

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

type Listener = (...args: unknown[]) => void;

/** One physical connection: server rooms belong to it and are lost on disconnect. */
class FakeSocket {
  connected = false;
  id: string | undefined;
  rooms = new Set<string>();
  sent: Array<[string, ...unknown[]]> = [];
  private listeners = new Map<string, Set<Listener>>();
  private generation = 0;

  on(event: string, listener: Listener) {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.sent.push([event, ...args]);
    if (event === 'join_room') {
      const [room, ack] = args as [string, ((value: unknown) => void) | undefined];
      this.rooms.add(room);
      ack?.({ ok: true, room });
    }
    if (event === 'leave_room') this.rooms.delete(args[0] as string);
    return this;
  }
  /** Server-side event arriving on this connection. */
  receive(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
  connect() {
    this.connected = true;
    this.id = `sid-${++this.generation}`;
    this.receive('connect');
  }
  drop() {
    this.connected = false;
    this.rooms.clear();
    this.receive('disconnect', 'transport close');
  }
  listenerCount(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

let root: Root;
let socket: FakeSocket;
let outlet: ReturnType<typeof useHubSocketOutlet>;

function Host() {
  const socketRef = React.useRef<Socket | null>(socket as unknown as Socket);
  outlet = useHubSocketOutlet(socketRef);
  return null;
}

beforeEach(() => {
  socket = new FakeSocket();
  root = createRoot(document.createElement('div'));
  act(() => root.render(<Host />));
});
afterEach(() => act(() => root.unmount()));

const hub = (): HubSocket => outlet.hub;
const sentNamed = (event: string) => socket.sent.filter(([name]) => name === event);

describe('page socket hub', () => {
  it('delivers server events registered before or after the socket is attached and releases them', () => {
    const early: unknown[] = [];
    const late: unknown[] = [];
    const releaseEarly = hub().on('thread:teleport', (event) => early.push(event));
    outlet.attach(socket as unknown as Socket);
    const releaseLate = hub().on('thread:teleport', (event) => late.push(event));
    expect(socket.listenerCount('thread:teleport')).toBe(1);

    socket.receive('thread:teleport', { eventId: 'e1' });
    expect(early).toEqual([{ eventId: 'e1' }]);
    expect(late).toEqual([{ eventId: 'e1' }]);

    releaseEarly();
    socket.receive('thread:teleport', { eventId: 'e2' });
    expect(early).toHaveLength(1);
    releaseLate();
    expect(socket.listenerCount('thread:teleport')).toBe(0);
  });

  it('passes the acknowledgement through to the listener', () => {
    outlet.attach(socket as unknown as Socket);
    hub().on('workspace:navigate', (_event, ack) => (ack as (receipt: unknown) => void)({ status: 'applied' }));
    let receipt: unknown;
    socket.receive('workspace:navigate', { eventId: 'n1' }, (value: unknown) => {
      receipt = value;
    });
    expect(receipt).toEqual({ status: 'applied' });
  });

  it('keeps a retained room joined once across holders and reconnects, and leaves it after the last release', () => {
    outlet.attach(socket as unknown as Socket);
    const releaseA = hub().retainRoom('workspace:global');
    const releaseB = hub().retainRoom('workspace:global');
    act(() => {
      socket.connect();
      outlet.reconcileOnConnect();
    });
    expect(sentNamed('join_room').map(([, room]) => room)).toEqual(['workspace:global']);
    expect(socket.rooms.has('workspace:global')).toBe(true);

    act(() => {
      socket.drop();
      outlet.resetOnDisconnect();
      socket.connect();
      outlet.reconcileOnConnect();
    });
    expect(socket.rooms.has('workspace:global')).toBe(true);

    releaseA();
    expect(sentNamed('leave_room')).toHaveLength(0);
    releaseB();
    releaseB();
    expect(sentNamed('leave_room').map(([, room]) => room)).toEqual(['workspace:global']);
    expect(socket.rooms.has('workspace:global')).toBe(false);
  });

  it('announces the current connection now and every later one', () => {
    outlet.attach(socket as unknown as Socket);
    act(() => socket.connect());
    const seen: string[] = [];
    const release = hub().onConnected((socketId) => seen.push(socketId));
    expect(seen).toEqual(['sid-1']);
    act(() => {
      socket.drop();
      socket.connect();
    });
    expect(seen).toEqual(['sid-1', 'sid-2']);
    expect(hub().connectedSocketId()).toBe('sid-2');
    release();
    act(() => {
      socket.drop();
      socket.connect();
    });
    expect(seen).toHaveLength(2);
  });

  it('keeps one hub identity across renders so holders do not resubscribe', () => {
    const first = hub();
    act(() => root.render(<Host />));
    act(() => root.render(<Host />));
    expect(hub()).toBe(first);
  });

  it('sends only while connected', () => {
    outlet.attach(socket as unknown as Socket);
    expect(hub().emit('workspace:watch-file', { watchId: 'w' })).toBe(false);
    expect(sentNamed('workspace:watch-file')).toHaveLength(0);
    act(() => socket.connect());
    expect(hub().emit('workspace:watch-file', { watchId: 'w' })).toBe(true);
    expect(sentNamed('workspace:watch-file')).toEqual([['workspace:watch-file', { watchId: 'w' }]]);
    expect(hub().connectedSocketId()).toBe('sid-1');
  });
});
