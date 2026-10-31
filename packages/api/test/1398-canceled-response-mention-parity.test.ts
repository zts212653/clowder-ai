import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { isTimelinePublished } from '../src/domains/cats/services/stores/visibility.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const redis = ownedRedisFixture('1398-cancel-mention');
const input = {
  userId: 'owner',
  threadId: 'thread',
  from: { kind: 'agent' as const, catId: 'codex' as never },
  content: '请确认',
  mentions: [],
  mentionsUser: true,
  timestamp: 100,
  deliveryStatus: 'queued' as const,
  origin: 'callback' as const,
};
const response = {
  ...input,
  lifecycle: {
    kind: 'response' as const,
    orderKey: '100:inv',
    invocationId: 'inv',
    targetId: 'codex',
    inputEntryIds: [],
    inputMessageIds: [],
    status: 'completed' as const,
    startedAt: 100,
    completedAt: 101,
  },
};
for (const backend of ['memory', 'redis'] as const) {
  const store = (key: string) =>
    backend === 'memory' ? new MessageStore() : new RedisMessageStore(redis.client(`${key}:`));
  test(`${backend}: canceled published response preserves request, replay and handling boundaries`, async () => {
    const messages = store('response');
    const original = await messages.append(response);
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [original.id],
    );
    const before = await messages.getUserMentionStateRevisions('owner');
    const canceled = await messages.markCanceled(original.id);
    assert.ok(canceled);
    assert.equal(canceled.deliveryStatus, 'canceled');
    assert.equal(isTimelinePublished(canceled), true);
    assert.equal(canceled.content, original.content);
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [original.id],
    );
    const after = await messages.getUserMentionStateRevisions('owner');
    assert.deepEqual(after, before, 'canceling delivery is not acknowledging the visible question');
    await messages.markCanceled(original.id);
    assert.deepEqual(await messages.getUserMentionStateRevisions('owner'), after);
    assert.equal(await messages.resolveUserMentionRequest('owner', 'thread', original.id), true);
    const handled = await messages.getUserMentionStateRevisions('owner');
    await messages.markCanceled(original.id);
    assert.deepEqual(await messages.listUserMentionRequests('owner'), []);
    assert.deepEqual(await messages.getUserMentionStateRevisions('owner'), handled);
    const next = await messages.append({ ...response, timestamp: 110 });
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [next.id],
    );
    await messages.markCanceled(next.id);
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [next.id],
    );
  });
  test(`${backend}: canceled ordinary queued source restores prior visible request`, async () => {
    const messages = store('ordinary');
    const prior = await messages.append(response);
    const next = await messages.append({ ...input, timestamp: 110 });
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [next.id],
    );
    const canceled = await messages.markCanceled(next.id);
    assert.ok(canceled);
    assert.equal(isTimelinePublished(canceled), false);
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [prior.id],
    );
    const revision = await messages.getUserMentionStateRevisions('owner');
    await messages.markCanceled(next.id);
    assert.deepEqual(await messages.getUserMentionStateRevisions('owner'), revision);
  });
  test(`${backend}: recalling an unsent human input cannot acknowledge the visible request`, async () => {
    const messages = store('recall');
    const request = await messages.append(response);
    const row = await messages.append({
      ...input,
      from: { kind: 'user', userId: 'owner' },
      mentionsUser: false,
      timestamp: 110,
    });
    const recalled = await messages.recallMessageToComposerDraft(row.id, {
      ownerUserId: 'owner',
      threadId: 'thread',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 120,
    });
    assert.equal(recalled.kind, 'recalled');
    await messages.markCanceled(row.id);
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((m) => m.id),
      [request.id],
    );
  });
  test(`${backend}: canceled response does not bypass private or non-member exclusions`, async () => {
    for (const [name, patch] of Object.entries({
      whisper: { visibility: 'whisper', whisperTo: ['codex'] },
      system: { from: { kind: 'system', service: 'host' } },
      external: { from: { kind: 'external', connectorId: 'test' } },
      source: {
        from: { kind: 'external', connectorId: 'test' },
        source: { connector: 'test', label: 'external source' },
      },
      deleted: {},
    })) {
      const messages = store(name);
      const row = await messages.append({ ...response, ...patch } as never);
      if (name === 'deleted') {
        const deleted = await messages.softDelete(row.id, 'owner');
        assert.ok(deleted?.deletedAt);
      }
      await messages.markCanceled(row.id);
      assert.deepEqual(await messages.listUserMentionRequests('owner'), [], name);
    }
  });
}
