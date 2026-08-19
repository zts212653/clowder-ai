import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SocketManager } from '../dist/infrastructure/websocket/SocketManager.js';

describe('SocketManager workspace acknowledgement broadcast', () => {
  it('returns partial client receipts even when another client times out', async () => {
    const receipts = [{ status: 'applied', eventId: 'event-1' }];
    const calls = [];
    const manager = {
      io: {
        to(room) {
          calls.push({ kind: 'room', room });
          return {
            timeout(timeoutMs) {
              calls.push({ kind: 'timeout', timeoutMs });
              return {
                emit(event, data, callback) {
                  calls.push({ kind: 'emit', event, data });
                  callback(new Error('one client timed out'), receipts);
                  return true;
                },
              };
            },
          };
        },
      },
    };

    const result = await SocketManager.prototype.broadcastToRoomWithAck.call(
      manager,
      'workspace:global',
      'workspace:navigate',
      { eventId: 'event-1' },
      250,
    );

    assert.deepEqual(result, receipts);
    assert.deepEqual(calls, [
      { kind: 'room', room: 'workspace:global' },
      { kind: 'timeout', timeoutMs: 250 },
      { kind: 'emit', event: 'workspace:navigate', data: { eventId: 'event-1' } },
    ]);
  });

  it('normalizes a missing acknowledgement array to empty', async () => {
    const manager = {
      io: {
        to() {
          return {
            timeout() {
              return {
                emit(_event, _data, callback) {
                  callback(null, undefined);
                  return true;
                },
              };
            },
          };
        },
      },
    };

    assert.deepEqual(
      await SocketManager.prototype.broadcastToRoomWithAck.call(manager, 'workspace:global', 'workspace:navigate', {}),
      [],
    );
  });
});
