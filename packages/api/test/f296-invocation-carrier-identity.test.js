import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MemoryAuthInvocationBackend } = await import(
  '../dist/domains/cats/services/agents/invocation/MemoryAuthInvocationBackend.js'
);
const { authRecordFromRedisHash } = await import(
  '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.js'
);

function baseRedisFields() {
  return {
    invocationId: 'inv-carrier-durable',
    callbackToken: 'tok-carrier-durable',
    userId: 'user-1',
    ownerAuthProvenance: 'strict',
    catId: 'opus',
    threadId: 'thread-1',
    createdAt: '1',
    state: 'active',
  };
}

describe('F296 #1542 durable carrier identity on the callback principal', () => {
  test('registry persists the expected carrier on the record and it survives reads', async () => {
    const registry = new InvocationRegistry({ backend: new MemoryAuthInvocationBackend() });
    const { invocationId } = await registry.create('user-1', 'opus', 'thread-1');

    const before = await registry.getRecord(invocationId);
    assert.equal(before?.expectedCompactionCarrier, undefined);

    await registry.setExpectedCompactionCarrier(invocationId, 'f296-node-v1');
    const after = await registry.getRecord(invocationId);
    assert.equal(after?.expectedCompactionCarrier, 'f296-node-v1');
  });

  test('the expectation round-trips through the durable Redis hash serialization', () => {
    const withCarrier = authRecordFromRedisHash(
      { ...baseRedisFields(), expectedCompactionCarrier: 'f296-node-v1' },
      new Set(),
    );
    assert.equal(withCarrier?.expectedCompactionCarrier, 'f296-node-v1');

    const withoutCarrier = authRecordFromRedisHash(baseRedisFields(), new Set());
    assert.equal(withoutCarrier?.expectedCompactionCarrier, undefined);
  });

  test('setting the expectation on a terminal or unknown invocation is a no-op', async () => {
    const registry = new InvocationRegistry({ backend: new MemoryAuthInvocationBackend() });
    await registry.setExpectedCompactionCarrier('inv-unknown', 'f296-node-v1');
    assert.equal(await registry.getRecord('inv-unknown'), null);
  });
});
