import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { getRedisQueueLedgerEntriesByMessageIds, listRedisQueueLedgerEntries } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerReader.js'
);

function row(id, messageId, target = 'opus') {
  return {
    version: 2,
    id,
    threadId: 'thread-1',
    owner: { kind: 'user', userId: 'user-1' },
    kind: 'conversation_input',
    from: { kind: 'user', userId: 'user-1' },
    targets: [target],
    payload: { sourceRecordId: messageId, messageId, content: 'body' },
    execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
    delivery: {},
    status: 'queued',
    enqueuedAt: 1,
    priority: 'normal',
  };
}

describe('Redis Queue ledger atomic readers', () => {
  it('reads order and rows in one Redis script snapshot', async () => {
    const expected = row('queue-1', 'message-1');
    const calls = [];
    const redis = {
      eval: async (...args) => {
        calls.push(args);
        return JSON.stringify([JSON.stringify(expected)]);
      },
      lrange: () => assert.fail('split order read must not run'),
      hmget: () => assert.fail('split row read must not run'),
    };

    assert.deepEqual(await listRedisQueueLedgerEntries(redis, 'thread-1'), [expected]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 2);
  });

  it('reads message indexes and referenced rows in one Redis script snapshot', async () => {
    const first = row('queue-1', 'message-1', 'opus');
    const second = row('queue-2', 'message-1', 'codex');
    const calls = [];
    const redis = {
      eval: async (...args) => {
        calls.push(args);
        return JSON.stringify({ 'message-1': [JSON.stringify(first), JSON.stringify(second)] });
      },
      hmget: () => assert.fail('split index or row read must not run'),
    };

    assert.deepEqual(
      await getRedisQueueLedgerEntriesByMessageIds(redis, 'thread-1', ['message-1']),
      new Map([['message-1', [first, second]]]),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 2);
  });
});
