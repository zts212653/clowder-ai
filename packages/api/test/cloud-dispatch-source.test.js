import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudDispatchSourceMatches } from '../dist/domains/cats/services/cloud-bridge/cloud-dispatch-source.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

function fixture(from = { kind: 'agent', catId: 'opus' }) {
  const messageStore = new MessageStore();
  const source = messageStore.append({
    userId: 'alice',
    threadId: 'cloud-thread',
    from,
    content: 'exact source body',
    mentions: ['gpt-pro'],
    timestamp: 1,
    extra: { stream: { invocationId: 'source-invocation' } },
  });
  return {
    messageStore,
    sourceMessageId: source.id,
    sourceSender:
      from.kind === 'user'
        ? { kind: 'user', id: from.userId }
        : { kind: 'cat', id: 'opus', invocationId: 'source-invocation' },
    threadId: 'cloud-thread',
    userId: 'alice',
    targetCatId: 'gpt-pro',
  };
}

test('the durable source binds owner, thread, canonical sender and optional source invocation', async () => {
  const input = fixture();
  assert.equal(await cloudDispatchSourceMatches(input), true);
  for (const change of [
    { userId: 'other' },
    { threadId: 'other' },
    { sourceMessageId: 'missing' },
    { sourceSender: { kind: 'user', id: 'alice' } },
    { sourceSender: { kind: 'cat', id: 'opus', invocationId: 'child-invocation' } },
    { messageStore: undefined },
  ])
    assert.equal(await cloudDispatchSourceMatches({ ...input, ...change }), false, JSON.stringify(change));
  assert.equal(await cloudDispatchSourceMatches(fixture({ kind: 'user', userId: 'alice' })), true);
});

test('cloud delivery refuses deleted, private and non-quotable sources before return authority', async () => {
  for (const change of [
    { deletedAt: 1 },
    { _tombstone: true },
    { visibility: 'whisper', whisperTo: ['codex'] },
    { from: { kind: 'external', connectorId: 'github-wait' }, catId: null },
    { from: { kind: 'system', service: 'internal' }, catId: null },
  ]) {
    const input = fixture();
    const read = input.messageStore.getById.bind(input.messageStore);
    let reads = 0;
    input.messageStore.getById = (id) => {
      reads++;
      return { ...read(id), ...change };
    };
    assert.equal(await cloudDispatchSourceMatches(input), false, JSON.stringify(change));
    assert.equal(reads, 1);
  }
});

test('a source read failure propagates instead of authorizing a cloud fallback', async () => {
  const input = fixture();
  let reads = 0;
  input.messageStore.getById = () => {
    reads++;
    throw new Error('History unavailable');
  };
  await assert.rejects(cloudDispatchSourceMatches(input), /History unavailable/);
  assert.equal(reads, 1);
});
