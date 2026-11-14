import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { persistStreamedInteractiveBlock } from '../dist/domains/cats/services/agents/invocation/persist-streamed-interactive-block.js';
import { queueEntryId } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { lifecycleResponseTerminalPatchFromAppendInput } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { messageActionsRoutes } from '../dist/routes/message-actions.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

// Production store, route and Lua execute against
// the repository runner's disposable Redis; barriers choose the interleaving.
const question = (id) => ({
  id,
  kind: 'interactive',
  v: 1,
  interactiveType: 'select',
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
});

async function fixture(t) {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'review1954');
  const redis = createRedisClient({ url: process.env.REDIS_URL });
  t.after(() => redis.quit());
  const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const input = {
    from: { kind: 'agent', catId: 'codex' },
    userId: 'review-owner',
    threadId: `review1954-${randomUUID()}`,
    content: '',
    mentions: [],
    timestamp: 100,
    extra: { rich: { v: 1, blocks: [question('first')] } },
  };
  const response = await store.append({
    ...input,
    lifecycle: {
      kind: 'response',
      orderKey: '100:response',
      invocationId: 'turn',
      targetId: 'codex',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 100,
    },
  });
  const app = Fastify();
  await app.register(messageActionsRoutes, { messageStore: store, socketManager: {} });
  t.after(() => app.close());
  const save = async (selectedIds = ['b'], statusCode = 200) => {
    const reply = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${response.id}/block-state`,
      payload: { userId: 'review-owner', blockId: 'first', disabled: true, selectedIds },
    });
    assert.equal(reply.statusCode, statusCode, reply.body);
  };
  const blocks = async () => (await store.getById(response.id)).extra.rich.blocks;
  const terminal = async (extra = input.extra) =>
    lifecycleResponseTerminalPatchFromAppendInput(
      await store.getById(response.id),
      'turn',
      { status: 'completed', completedAt: 200 },
      { ...input, content: 'Finished', extra },
    );
  const streamSecond = (block = question('second')) =>
    persistStreamedInteractiveBlock(
      store,
      {
        type: 'system_info',
        messageId: response.id,
        content: JSON.stringify({ type: 'rich_block', block }),
      },
      response.id,
    );
  const commitWithLedger = async (patch) => {
    const ledger = new RedisQueueLedgerStore(redis);
    const entry = {
      version: 2,
      id: queueEntryId(response.id),
      threadId: response.threadId,
      owner: { kind: 'user', userId: 'review-owner' },
      kind: 'message_wake',
      from: input.from,
      targets: ['opus'],
      payload: { sourceRecordId: response.id, messageId: response.id, content: 'Finished' },
      execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: true },
      delivery: {},
      status: 'queued',
      enqueuedAt: 200,
      priority: 'normal',
    };
    const result = await store.commitLifecycleResponseTerminalWithQueueLedgerAdmission(
      response.id,
      patch,
      [entry],
      ledger,
    );
    assert.equal(result.kind, 'applied');
    assert.equal((await ledger.list(response.threadId)).length, 1);
    return result;
  };
  return { redis, store, response, save, blocks, terminal, streamSecond, commitWithLedger };
}

function assertAnswered(blocks) {
  const first = blocks.find((block) => block.id === 'first');
  assert.equal(first.disabled, true, 'a successful state PATCH must survive the other writer');
  assert.deepEqual(first.selectedIds, ['b']);
}

describe('#1951 atomic rich state writers', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  test('#1951 a successful answer after patch construction survives terminal commit', async (t) => {
    const h = await fixture(t);
    const patch = await h.terminal();
    await h.save();
    assertAnswered(await h.blocks());
    const result = await h.store.commitLifecycleResponseTerminal(h.response.id, patch);
    assert.equal(result.kind, 'applied');
    const observed = await h.blocks();
    assertAnswered(observed);
  });

  test('#1951 an answer between terminal hydration and Lua commit survives', async (t) => {
    const h = await fixture(t);
    const patch = await h.terminal();
    const evalOriginal = h.redis.eval.bind(h.redis);
    let injected = false;
    h.redis.eval = async (script, ...args) => {
      if (!injected && script.includes('local lifecycleNeedsWrite = false')) {
        injected = true;
        await h.save();
        assertAnswered(await h.blocks());
      }
      return evalOriginal(script, ...args);
    };
    const result = await h.store.commitLifecycleResponseTerminal(h.response.id, patch);
    assert.equal(injected, true);
    assert.equal(result.kind, 'applied');
    const observed = await h.blocks();
    assertAnswered(observed);
  });

  test('#1951 an answer saved while adding a second streamed card survives', async (t) => {
    const h = await fixture(t);
    const evalOriginal = h.redis.eval.bind(h.redis);
    let injected = false;
    h.redis.eval = async (script, ...args) => {
      if (!injected && script.includes('for field, value in pairs(fields) do')) {
        injected = true;
        await h.save();
        assertAnswered(await h.blocks());
      }
      return evalOriginal(script, ...args);
    };
    await h.streamSecond();
    assert.equal(injected, true);
    const observed = await h.blocks();
    assert.equal(
      observed.some((block) => block.id === 'second'),
      true,
    );
    assertAnswered(observed);
  });

  test('#1951 a state PATCH cannot remove a new card added after its route read', async (t) => {
    const h = await fixture(t);
    const readOriginal = h.store.getById.bind(h.store);
    let injected = false;
    h.store.getById = async (id) => {
      const message = await readOriginal(id);
      if (!injected && id === h.response.id) {
        injected = true;
        await h.streamSecond();
        assert.equal(
          (await h.blocks()).some((block) => block.id === 'second'),
          true,
        );
      }
      return message;
    };
    await h.save();
    assert.equal(injected, true);
    const observed = await h.blocks();
    assertAnswered(observed);
    assert.equal(
      observed.some((block) => block.id === 'second'),
      true,
      'a successful answer must preserve its sibling',
    );
  });

  test('#1951 terminal commit retains a card streamed after patch construction', async (t) => {
    const h = await fixture(t);
    const patch = await h.terminal();
    await h.streamSecond();
    await h.save();
    assert.equal((await h.store.commitLifecycleResponseTerminal(h.response.id, patch)).kind, 'applied');
    const observed = await h.blocks();
    assertAnswered(observed);
    assert.equal(
      observed.some((block) => block.id === 'second'),
      true,
    );
  });

  test('#1951 terminal commit prefers the latest selection over an older nonempty snapshot', async (t) => {
    const h = await fixture(t);
    await h.save(['a']);
    const patch = await h.terminal({});
    await h.save(['b']);
    assert.equal((await h.store.commitLifecycleResponseTerminal(h.response.id, patch)).kind, 'applied');
    assertAnswered(await h.blocks());
  });

  test('#1951 terminal plus ledger retains an answer saved after patch construction', async (t) => {
    const h = await fixture(t);
    const patch = await h.terminal();
    await h.save();
    await h.commitWithLedger(patch);
    assertAnswered(await h.blocks());
  });

  test('#1951 terminal plus ledger retries an answer saved immediately before Lua', async (t) => {
    const h = await fixture(t);
    const patch = await h.terminal();
    const evalOriginal = h.redis.eval.bind(h.redis);
    let injected = false;
    h.redis.eval = async (script, ...args) => {
      if (!injected && script.includes('local lifecycleNeedsWrite = false')) {
        injected = true;
        await h.save();
        assertAnswered(await h.blocks());
      }
      return evalOriginal(script, ...args);
    };
    await h.commitWithLedger(patch);
    assert.equal(injected, true);
    assertAnswered(await h.blocks());
  });

  test('#1951 partial extra writers retain an answer saved immediately before their Lua', async (t) => {
    const h = await fixture(t);
    const evalOriginal = h.redis.eval.bind(h.redis);
    let injected = false;
    h.redis.eval = async (script, ...args) => {
      if (!injected && script.includes('local extra=cjson.decode(ARGV[1])')) {
        injected = true;
        await h.save();
      }
      return evalOriginal(script, ...args);
    };
    await h.store.updateExtra(h.response.id, { tracing: { traceId: 'trace', spanId: 'span' } });
    assert.equal(injected, true);
    assertAnswered(await h.blocks());
    assert.equal((await h.store.getById(h.response.id)).extra.tracing.traceId, 'trace');
  });

  test('#1951 continued write contention returns 503 instead of acknowledging a lost answer', async (t) => {
    const h = await fixture(t);
    const evalOriginal = h.redis.eval.bind(h.redis);
    let writes = 0;
    h.redis.eval = async (script, ...args) => {
      if (script.includes('for field, value in pairs(fields) do')) {
        writes += 1;
        await h.store.updateExtra(h.response.id, { tracing: { traceId: `trace-${writes}`, spanId: 'span' } });
      }
      return evalOriginal(script, ...args);
    };
    await h.save(['b'], 503);
    assert.equal(writes, 4);
    assert.notEqual((await h.blocks())[0].disabled, true);
  });

  test('#1951 terminal plus ledger retains late cards and the latest nonempty selection', async (t) => {
    const h = await fixture(t);
    await h.save(['a']);
    const patch = await h.terminal({});
    await h.save(['b']);
    await h.streamSecond({ ...question('second'), title: 'Late card', disabled: true, selectedIds: ['a'] });
    await h.commitWithLedger(patch);
    const observed = await h.blocks();
    assertAnswered(observed);
    const later = observed.find((block) => block.id === 'second');
    assert.equal(later.title, 'Late card');
    assert.equal(later.disabled, true);
    assert.deepEqual(later.selectedIds, ['a']);
  });
});
