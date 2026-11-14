import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import { ThreadKeys } from '../dist/domains/cats/services/stores/redis-keys/thread-keys.js';
import {
  selectedSourceRedisFixture as fixture,
  human,
  producer,
} from './helpers/message-selected-source-redis-fixture.js';

for (const kind of ['revoke-index', 'withdraw-publisher', 'ABA-index', 'late-auth', 'binding-read'])
  test(`a real Redis read witness rejects ${kind} during the final card read`, async () => {
    const f = await fixture();
    try {
      const card = await f.publish();
      assert.ok(card.published);
      const saved = f.store.get(f.prepared.publicationRef).response_json;
      const get = f.messages.getByIds.bind(f.messages);
      let crossed = false;
      f.messages.getByIds = async (ids) => {
        const rows = await get(ids);
        if (!crossed && ids.includes(f.source.id)) {
          crossed = true;
          await new Promise((resolve) => setImmediate(resolve));
          if (kind === 'withdraw-publisher')
            await f.redis.hset(
              MessageKeys.detail(f.source.id),
              'recall',
              JSON.stringify({ version: 1, exposure: 'none', recalledAt: 200 }),
            );
          else if (!['late-auth', 'binding-read'].includes(kind)) {
            const key = ThreadKeys.userList('owner');
            const score = await f.redis.zscore(key, f.sourceThread.id);
            await f.redis.zrem(key, f.sourceThread.id);
            if (kind === 'ABA-index') await f.redis.zadd(key, score, f.sourceThread.id);
          }
        }
        return rows;
      };
      if (kind === 'late-auth') {
        const list = f.threads.list.bind(f.threads);
        f.threads.list = async (...args) => {
          const rows = await list(...args);
          await f.redis.hset(
            MessageKeys.detail(f.origin.id),
            'recall',
            JSON.stringify({ version: 1, exposure: 'none', recalledAt: 200 }),
          );
          return rows;
        };
      }
      if (kind === 'binding-read') {
        const getMessage = f.messages.getById.bind(f.messages);
        let bindingReads = 0;
        f.messages.getById = async (id) => {
          const message = await getMessage(id);
          if (id === card.message.id && ++bindingReads === 2)
            await f.redis.hset(
              MessageKeys.detail(f.origin.id),
              'recall',
              JSON.stringify({ version: 1, exposure: 'none', recalledAt: 200 }),
            );
          return message;
        };
      }
      const view = await f.create().read(card.message.id, card.published.extra.messageSearchAnswer.blockId, human);
      assert.equal(crossed, true);
      assert.equal(view.status, 'unavailable');
      assert.equal(f.store.get(f.prepared.publicationRef).response_json, saved, 'never rewrite saved historical state');
    } finally {
      await f.close();
    }
  });

test('the same witness keeps independent async reads usable and rejects their mixed publisher/origin snapshots', async () => {
  const f = await fixture();
  try {
    const card = await f.publish();
    assert.ok(card.published);
    f.messages.getByIds = undefined;
    f.threads.getMany = undefined;
    const args = [card.message.id, card.published.extra.messageSearchAnswer.blockId, human];
    assert.equal((await f.create().read(...args)).status, 'available');
    const get = f.messages.getById.bind(f.messages);
    let crossed = false;
    f.messages.getById = async (id) => {
      const row = await get(id);
      if (id === f.origin.id && !crossed) {
        crossed = true;
        await new Promise((resolve) => setImmediate(resolve));
        await f.redis.hset(
          MessageKeys.detail(f.source.id),
          'recall',
          JSON.stringify({ version: 1, exposure: 'none', recalledAt: 200 }),
        );
      }
      return row;
    };
    assert.equal((await f.create().read(...args)).status, 'unavailable');
    assert.equal(crossed, true);
  } finally {
    await f.close();
  }
});

for (const operation of ['publish', 'prepared retry', 'forward'])
  test(`the same source witness protects ${operation}`, async () => {
    const f = await fixture();
    try {
      const card = operation === 'forward' ? await f.publish() : null;
      const get = f.messages.getByIds.bind(f.messages);
      let changed = false;
      f.messages.getByIds = async (ids) => {
        const rows = await get(ids);
        if (!changed && ids.includes(f.source.id)) {
          changed = true;
          await f.redis.hset(
            MessageKeys.detail(f.origin.id),
            'recall',
            JSON.stringify({ version: 1, exposure: 'none', recalledAt: 200 }),
          );
        }
        return rows;
      };
      if (operation === 'publish') assert.equal((await f.publish()).published, null);
      if (operation === 'prepared retry') assert.equal((await f.create().prepare(f.request)).status, 'unavailable');
      if (operation === 'forward')
        assert.equal(
          await f.service.preparePost(
            {
              publicationRef: f.prepared.publicationRef,
              source: { messageId: card.message.id, blockId: card.published.extra.messageSearchAnswer.blockId },
            },
            'owner',
            producer,
            f.sourceThread.id,
          ),
          null,
        );
      assert.equal(changed, true);
    } finally {
      await f.close();
    }
  });
