import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadJoinedRoomsFromSession,
  MAX_RESTORED_THREAD_ROOMS,
  saveJoinedRoomsToSession,
} from '../useSocket-persistence';

describe('useSocket room persistence', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('bounds an accumulated legacy room list to the newest rooms', () => {
    const rooms = Array.from({ length: 393 }, (_, index) => `thread:thread-${index}`);
    window.sessionStorage.setItem('cat-cafe:ws:joined-rooms:v1:test-user', JSON.stringify(rooms));

    const restored = [...loadJoinedRoomsFromSession('test-user')];

    expect(restored).toHaveLength(MAX_RESTORED_THREAD_ROOMS);
    expect(restored).toEqual(rooms.slice(-MAX_RESTORED_THREAD_ROOMS));
  });

  it('keeps the persisted room order so the most recently joined rooms remain recoverable', () => {
    const rooms = new Set(['thread:thread-A', 'thread:thread-B', 'thread:thread-C']);

    saveJoinedRoomsToSession('test-user', rooms);

    expect([...loadJoinedRoomsFromSession('test-user')]).toEqual([...rooms]);
  });
});
