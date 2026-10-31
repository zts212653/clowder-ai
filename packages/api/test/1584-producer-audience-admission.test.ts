import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistedQueueDelivery } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';

const source = {
  connector: 'content-review',
  label: 'Host review',
  icon: 'cat-cafe',
  meta: { requestId: 'request-1' },
};
const input = {
  ownerUserId: 'operator',
  ownerAuthProvenance: 'strict' as const,
  threadId: 'thread-1',
  targetCatId: 'codex',
  idempotencyKey: 'review-1',
  content: 'recipient-only review',
  source,
};

// This boundary fixture observes the immutable envelope submitted to common send.
// It deliberately does not claim Queue/drain or provider integration coverage.
function fixture(existing?: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const entry = { id: 'entry-1', targets: ['codex'], status: 'queued' };
  const delivery = new PersistedQueueDelivery({
    messages: { getByIdempotencyKey: async () => existing },
    queue: {
      getDurableEntry: async () => entry,
      send: async (_messages: unknown, message: Record<string, unknown>) => {
        calls.push(message);
        return {
          outcome: 'admitted',
          message: existing ?? { ...message, id: 'message-1', catId: null, visibility: message.visibility ?? 'public' },
          entry,
        };
      },
    },
    progress: async () => 'started',
  } as unknown as ConstructorParameters<typeof PersistedQueueDelivery>[0]);
  return { delivery, calls };
}

test('private review producer carries the frozen audience to shared send', async () => {
  const f = fixture();
  const result = await f.delivery.deliver({ ...input, visibility: 'whisper', whisperTo: ['codex'] } as never);
  assert.equal(result.state, 'started');
  assert.equal(f.calls[0]?.visibility, 'whisper');
  assert.deepEqual(f.calls[0]?.whisperTo, ['codex']);
});

test('private review rejects a target outside its frozen audience before send', async () => {
  const f = fixture();
  await assert.rejects(
    f.delivery.deliver({ ...input, visibility: 'whisper', whisperTo: ['opus'] } as never),
    /audience/,
  );
  assert.equal(f.calls.length, 0);
});

test('replay cannot turn an existing public review into a private review', async () => {
  const existing = { ...input, id: 'message-1', userId: input.ownerUserId, mentions: ['codex'], visibility: 'public' };
  const f = fixture(existing);
  const result = await f.delivery.deliver({ ...input, visibility: 'whisper', whisperTo: ['codex'] } as never);
  assert.equal(result.state, 'conflict');
  assert.equal(f.calls.length, 0);
});

test('declared public legacy replay reuses the persisted source without changing the winner', async () => {
  const legacy = { ...source, label: 'Legacy review', meta: { receipt: 'old-1' } };
  const existing = {
    id: 'message-1',
    userId: input.ownerUserId,
    threadId: input.threadId,
    content: input.content,
    mentions: ['codex'],
    source: legacy,
  };
  const f = fixture(existing);
  const result = await f.delivery.deliver({
    ...input,
    visibility: 'public',
    compatibleExistingSources: [legacy],
  } as never);
  assert.equal(result.state, 'started');
  assert.deepEqual(f.calls[0]?.source, legacy);
});

test('private review cannot opt into public legacy replay compatibility', async () => {
  const f = fixture();
  await assert.rejects(
    f.delivery.deliver({
      ...input,
      visibility: 'whisper',
      whisperTo: ['codex'],
      compatibleExistingSources: [source],
    } as never),
    /Private/,
  );
  assert.equal(f.calls.length, 0);
});

test('unrelated source metadata remains a replay conflict', async () => {
  const existing = {
    id: 'message-1',
    userId: input.ownerUserId,
    threadId: input.threadId,
    content: input.content,
    mentions: ['codex'],
    source: { ...source, meta: { requestId: 'other' } },
  };
  const f = fixture(existing);
  const result = await f.delivery.deliver(input);
  assert.equal(result.state, 'conflict');
  assert.equal(f.calls.length, 0);
});
