import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import { MessageSelectionError } from '../dist/domains/memory/message-selected-quote.js';
import { human, selectedSourceRedisFixture } from './helpers/message-selected-source-redis-fixture.js';

const clients = async (redis) =>
  new Set(
    (await redis.client('LIST'))
      .trim()
      .split('\n')
      .map((line) => line.match(/^id=(\d+)/)?.[1]),
  );

// CLIENT KILL is confined by the fixture's canonical isolated Redis assertions.
for (const operation of ['prepare', 'publish', 'read', 'recovery'])
  test(`a lost WATCH connection cannot validate old sources during ${operation}`, async () => {
    const f = await selectedSourceRedisFixture();
    let release = () => {};
    let pending;
    try {
      const card = ['read', 'recovery'].includes(operation) ? await f.publish() : null;
      const saved = f.store.get(f.prepared.publicationRef).response_json;
      const baseline = await clients(f.redis);
      let markStarted;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const stalled = new Promise((resolve) => {
        release = resolve;
      });
      const get = f.messages.getByIds.bind(f.messages);
      f.messages.getByIds = async (ids) => {
        const rows = await get(ids);
        markStarted();
        await stalled;
        return rows;
      };
      if (operation === 'prepare') pending = f.service.prepare({ ...f.request, operationId: 'fresh' });
      else if (operation === 'publish') pending = f.publish();
      else {
        const service = operation === 'recovery' ? f.create() : f.service;
        pending = service.read(card.message.id, card.published.extra.messageSearchAnswer.blockId, human);
      }
      // Attach the rejection handler before killing the connection.
      const observed = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await started;
      const watching = [...(await clients(f.redis))].filter((id) => !baseline.has(id));
      assert.equal(watching.length, 1);
      assert.equal(await f.redis.client('KILL', 'ID', watching[0]), 1);
      await f.redis.hset(
        MessageKeys.detail(f.source.id),
        'recall',
        JSON.stringify({ version: 1, exposure: 'none', recalledAt: 200 }),
      );
      // The old implementation reconnects in 200ms and wrongly accepts the old read.
      await new Promise((resolve) => setTimeout(resolve, 500));
      release();
      const outcome = await observed;
      if (operation === 'prepare') assert.ok(outcome.error instanceof MessageSelectionError);
      else {
        assert.equal(outcome.error, undefined);
        if (operation === 'publish') assert.equal(outcome.value.published, null);
        else assert.equal(outcome.value.status, 'unavailable');
      }
      assert.ok((await f.messages.getById(f.source.id)).recall);
      assert.equal(f.store.get(f.prepared.publicationRef).response_json, saved);
      const remaining = [...(await clients(f.redis))].filter((id) => !baseline.has(id));
      assert.deepEqual(remaining, [], 'no reconnect or replacement witness survives the failed read');
    } finally {
      release();
      await pending?.catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));
      await f.close();
    }
  });
