import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  MessageStore,
  settleLifecycleResponseInputs,
} from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f117-private-append');

for (const backend of ['memory', 'Redis']) {
  for (const mixed of [false, true]) {
    test(`${backend} ${mixed ? 'mixed' : 'private'} Append keeps private IDs out of durable public response, including replay/reopen`, async () => {
      const client = backend === 'Redis' ? owned.client(`private-append:${randomUUID()}:`) : undefined;
      const store = client ? new RedisMessageStore(client, { ttlSeconds: 0 }) : new MessageStore();
      try {
        const source = async (content, extra = {}) =>
          store.append({
            userId: 'owner',
            threadId: 'thread',
            from: { kind: 'user', userId: 'owner' },
            content,
            mentions: ['opus'],
            timestamp: 20,
            ...extra,
          });
        const original = await source('original');
        const secret = await source('private return', { visibility: 'whisper', whisperTo: ['opus'], timestamp: 1000 });
        const visible = mixed ? await source('public append') : undefined;
        const inputs = visible ? [secret, visible] : [secret];
        const response = await store.append({
          userId: 'owner',
          threadId: 'thread',
          from: { kind: 'agent', catId: 'opus' },
          content: '',
          mentions: [],
          timestamp: 10,
          lifecycle: {
            kind: 'response',
            orderKey: '10:turn',
            invocationId: 'turn',
            targetId: 'opus',
            inputEntryIds: ['original-entry'],
            inputMessageIds: [original.id],
            status: 'processing',
            startedAt: 10,
          },
        });
        const admission = {
          threadId: 'thread',
          entryId: 'append-entry',
          inputMessageIds: inputs.map((m) => m.id),
          runs: [
            {
              targetId: 'opus',
              invocationId: 'turn',
              responseMessageId: response.id,
              dispatchedAt: 25,
              inputReadSupported: true,
            },
          ],
        };
        const before = await Promise.all([...inputs, response].map((m) => store.getById(m.id)));
        assert.equal(
          (
            await store.commitLifecycleAppendAdmission({
              ...admission,
              runs: [{ ...admission.runs[0], invocationId: 'wrong' }],
            })
          ).kind,
          'conflict',
        );
        assert.deepEqual(
          await Promise.all([...inputs, response].map((m) => store.getById(m.id))),
          before,
          'conflicting admission is atomic',
        );
        assert.equal((await store.commitLifecycleAppendAdmission(admission)).kind, 'applied');
        const expectedIds = [original.id, ...(visible ? [visible.id] : [])];
        assert.deepEqual((await store.getById(response.id)).lifecycle.inputMessageIds, expectedIds);
        assert.equal(
          (await store.getById(response.id)).lifecycle.latestInputTimelineOrderAt,
          25,
          'private input clock is not a public timeline source',
        );
        const privateRef = (await store.getById(secret.id)).lifecycle.dispatchRefs[0];
        assert.equal(privateRef.statusMessageId, response.id, 'private source retains exact internal dispatch binding');
        assert.deepEqual(privateRef.inputRead, { status: 'pending' });
        assert.equal((await store.commitLifecycleAppendAdmission(admission)).kind, 'replayed');
        const reopened = client ? new RedisMessageStore(client, { ttlSeconds: 0 }) : store;
        assert.deepEqual((await reopened.getById(response.id)).lifecycle.inputMessageIds, expectedIds);
        if (client) assert.equal(await client.ttl(`msg:${response.id}`), -1);
      } finally {
        client?.disconnect();
      }
    });
  }
}

test('Redis private settlement uses exact existing internal binding after response projection and store reopen', async () => {
  const client = owned.client(`private-settlement:${randomUUID()}:`);
  try {
    const store = new RedisMessageStore(client, { ttlSeconds: 0 });
    const secret = await store.append({
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'user', userId: 'owner' },
      content: 'private',
      mentions: ['opus'],
      timestamp: 10,
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    const response = await store.append({
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'agent', catId: 'opus' },
      content: '',
      mentions: [],
      timestamp: 20,
      lifecycle: {
        kind: 'response',
        orderKey: '20:turn',
        invocationId: 'turn',
        targetId: 'opus',
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt: 20,
      },
    });
    assert.equal(
      (
        await store.commitLifecycleAppendAdmission({
          threadId: 'thread',
          entryId: 'entry',
          inputMessageIds: [secret.id],
          runs: [
            {
              targetId: 'opus',
              invocationId: 'turn',
              responseMessageId: response.id,
              dispatchedAt: 25,
              inputReadSupported: true,
            },
          ],
        })
      ).kind,
      'applied',
    );
    const terminal = await store.commitLifecycleResponseTerminal(response.id, {
      invocationId: 'turn',
      status: 'completed',
      completedAt: 30,
      content: 'done',
      mentions: [],
      origin: 'stream',
    });
    const reopened = new RedisMessageStore(client, { ttlSeconds: 0 });
    await settleLifecycleResponseInputs(reopened, terminal.message, 'wrong-response', [secret.id]);
    assert.equal((await reopened.getById(secret.id)).lifecycle.dispatchRefs[0].phase, 'dispatched');
    await settleLifecycleResponseInputs(reopened, terminal.message, response.id, [secret.id]);
    await settleLifecycleResponseInputs(reopened, terminal.message, response.id, [secret.id]);
    const ref = (await reopened.getById(secret.id)).lifecycle.dispatchRefs[0];
    assert.equal(ref.phase, 'settled');
    assert.deepEqual(ref.inputRead, { status: 'pending' });
    assert.deepEqual((await reopened.getById(response.id)).lifecycle.inputMessageIds, []);
  } finally {
    client.disconnect();
  }
});
