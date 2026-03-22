import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Unit test for socket room name validation regex.
 * Tests the pattern used in SocketManager.ts join_room handler.
 */
const ROOM_PATTERN = /^(thread:|worktree:|preview:global$|user:)/;

describe('socket room name validation', () => {
  it('allows thread rooms', () => {
    assert.ok(ROOM_PATTERN.test('thread:abc123'));
    assert.ok(ROOM_PATTERN.test('thread:thread_xyz'));
  });

  it('allows worktree rooms', () => {
    assert.ok(ROOM_PATTERN.test('worktree:f120-phase-c2'));
    assert.ok(ROOM_PATTERN.test('worktree:123'));
  });

  it('allows preview:global', () => {
    assert.ok(ROOM_PATTERN.test('preview:global'));
  });

  it('allows user rooms', () => {
    assert.ok(ROOM_PATTERN.test('user:you'));
    assert.ok(ROOM_PATTERN.test('user:anonymous'));
  });

  it('rejects arbitrary room names', () => {
    assert.ok(!ROOM_PATTERN.test('admin:panel'));
    assert.ok(!ROOM_PATTERN.test('secret-room'));
    assert.ok(!ROOM_PATTERN.test(''));
    assert.ok(!ROOM_PATTERN.test('preview:other'));
    assert.ok(!ROOM_PATTERN.test('../escape'));
  });
});
