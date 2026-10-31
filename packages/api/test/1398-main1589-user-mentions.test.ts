import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { RedisQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const from = { kind: 'agent' as const, catId: 'codex' as never };
const source = {
  userId: 'owner',
  threadId: 'thread',
  from,
  content: '请确认',
  mentions: [],
  mentionsUser: true,
  timestamp: 100,
};

const redis = ownedRedisFixture('f117-main1589-mentions');
for (const backend of ['memory', 'redis'] as const) {
  const store = (name: string) =>
    backend === 'memory' ? new MessageStore() : new RedisMessageStore(redis.client(`mentions:${name}:`));
  test(`${backend}: canonical system facts cannot acknowledge an unanswered owner mention`, async () => {
    const messages = store('system');
    const request = await messages.append(source);
    await messages.append({
      ...source,
      from: { kind: 'system', service: 'live-companion' },
      mentionsUser: false,
      timestamp: 110,
    });
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [request.id],
    );
  });

  test(`${backend}: non-human senders and cross-posts cannot produce replied history`, async () => {
    const messages = store('sender-history');
    const request = await messages.append(source);
    for (const sender of [
      { kind: 'system', service: 'host' },
      { kind: 'external', connectorId: 'test-connector' },
      { kind: 'agent', catId: 'codex' },
    ] as const) {
      await messages.append({ ...source, from: sender as never, mentionsUser: false, timestamp: 110 });
    }
    await messages.append({
      ...source,
      from: { kind: 'user', userId: 'owner' },
      mentionsUser: false,
      timestamp: 111,
      extra: { crossPost: { sourceThreadId: 'other' } } as never,
    });
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [request.id],
    );
    assert.deepEqual(await messages.getUserMentionHandlingMetadata('owner'), {});
    await messages.append({ ...source, from: { kind: 'user', userId: 'owner' }, mentionsUser: false, timestamp: 112 });
    assert.deepEqual(await messages.listUserMentionRequests('owner'), []);
    assert.deepEqual((await messages.getUserMentionHandlingMetadata('owner'))[request.id], {
      reason: 'replied',
      handledAt: 112,
    });
  });

  test(`${backend}: viewed history preserves source and rejects foreign boundaries and replay`, async () => {
    const messages = store('read-history');
    const request = await messages.append(source);
    const original = structuredClone(await messages.getById(request.id));
    assert.equal(await messages.resolveUserMentionRequestFromRead('stranger', 'thread', request.id, 200), false);
    assert.equal(await messages.resolveUserMentionRequestFromRead('owner', 'other', request.id, 200), false);
    assert.equal(await messages.resolveUserMentionRequestFromRead('owner', 'thread', request.id, 200), true);
    const revision = await messages.getUserMentionStateRevisions('owner');
    assert.equal(await messages.resolveUserMentionRequestFromRead('owner', 'thread', request.id, 201), false);
    assert.deepEqual(await messages.getUserMentionStateRevisions('owner'), revision);
    assert.deepEqual((await messages.getUserMentionHandlingMetadata('owner'))[request.id], {
      reason: 'viewed',
      handledAt: 200,
    });
    assert.deepEqual(
      await messages.getById(request.id),
      original,
      'human inbox handling must not mutate native response/input receipts',
    );
    const next = await messages.append({ ...source, timestamp: 90 });
    assert.equal(await messages.resolveUserMentionRequestFromRead('owner', 'thread', request.id, 202), false);
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [next.id],
    );
  });

  test(`${backend}: the existing terminal response commit publishes an owner mention once`, async () => {
    const messages = store('terminal');
    const { message: response } = await messages.appendAndObservePriorFrontier({
      ...source,
      content: '',
      mentionsUser: false,
      origin: 'stream',
      lifecycle: {
        kind: 'response',
        orderKey: '100:inv',
        invocationId: 'inv',
        targetId: 'codex',
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt: 100,
      },
    });
    const patch = {
      invocationId: 'inv',
      status: 'completed' as const,
      completedAt: 120,
      content: '请确认',
      mentions: [],
      mentionsUser: true,
      origin: 'stream' as const,
    };
    assert.equal((await messages.commitLifecycleResponseTerminal(response.id, patch)).kind, 'applied');
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [response.id],
    );
    const before = await messages.getUserMentionStateRevisions('owner');
    assert.equal((await messages.commitLifecycleResponseTerminal(response.id, patch)).kind, 'replayed');
    assert.deepEqual(await messages.getUserMentionStateRevisions('owner'), before);
  });
  test(`${backend}: terminal response plus Queue wake preserves owner mentions across reopen and replay`, async () => {
    const client = backend === 'redis' ? redis.client('mentions:combined:') : null;
    const messages = client ? new RedisMessageStore(client) : new MessageStore();
    const ledger = client ? new RedisQueueLedgerStore(client) : new InMemoryQueueLedgerStore();
    const queue = new InvocationQueue(ledger);
    const { message: response } = await messages.appendAndObservePriorFrontier({
      ...source,
      content: '',
      mentionsUser: false,
      origin: 'stream',
      lifecycle: {
        kind: 'response',
        orderKey: '100:combined',
        invocationId: 'combined',
        targetId: 'codex',
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt: 100,
      },
    });
    const patch = {
      invocationId: 'combined',
      status: 'completed' as const,
      completedAt: 120,
      content: '@sonnet review; owner please confirm',
      mentions: ['sonnet' as never],
      mentionsUser: true,
      origin: 'stream' as const,
    };
    const input = {
      from,
      threadId: 'thread',
      userId: 'owner',
      kind: 'message_wake' as const,
      ownerAuthProvenance: 'strict' as const,
      content: patch.content,
      targetCats: ['sonnet'],
      intent: 'execute' as const,
      autoExecute: true,
    };
    assert.equal(
      (await queue.terminalizeResponseAndEnqueueDurable(messages, response.id, patch, input)).outcome,
      'enqueued',
    );
    const reopened = client ? new RedisMessageStore(client) : messages;
    const reloadedLedger = client ? new RedisQueueLedgerStore(client) : ledger;
    assert.deepEqual(
      (await reopened.listUserMentionRequests('owner')).map((row) => row.id),
      [response.id],
    );
    const before = await reopened.getUserMentionStateRevisions('owner');
    const replay = await new InvocationQueue(reloadedLedger).terminalizeResponseAndEnqueueDurable(
      reopened,
      response.id,
      patch,
      input,
    );
    assert.equal(replay.deduped, true);
    assert.equal((await reloadedLedger.list('thread')).length, 1);
    assert.deepEqual(await reopened.getUserMentionStateRevisions('owner'), before);
  });
}
