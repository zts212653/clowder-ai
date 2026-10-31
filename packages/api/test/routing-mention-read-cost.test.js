import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLastUserMentions } from '../dist/domains/cats/services/agents/routing/last-user-mentions.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { createMessageReadDiagnostics } from '../dist/infrastructure/message-read-diagnostics.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('routing-mention-cost');
test('recipient history preserves input order and sender authority without loading top-level bodies', async (t) => {
  const redis = owned.client('routing-cost:');
  let summary;
  const diagnostics = createMessageReadDiagnostics({
    onEvent(event) {
      if (event.kind === 'message_read_coverage_end') summary = event;
    },
  });
  const store = new RedisMessageStore(redis, { ttlSeconds: 0, readDiagnostics: diagnostics });
  const threadId = 'routing-cost-thread';
  const time = Date.now() - 60_000;
  const payload = 'unused tool output '.repeat(4096);
  const seed = redis.pipeline();
  for (let i = 0; i < 160; i++) {
    const id = `message-${String(i).padStart(4, '0')}`;
    seed.hset(`msg:${id}`, {
      id,
      threadId,
      userId: 'owner',
      catId: 'codex',
      from: JSON.stringify({ kind: 'agent', catId: 'codex' }),
      timestamp: String(time),
      deliveryStatus: 'delivered',
      mentions: '[]',
      content: payload,
      thinking: payload,
      metadata: JSON.stringify({ payload }),
      contentBlocks: JSON.stringify([{ type: 'text', text: payload }]),
      toolEvents: JSON.stringify([{ type: 'tool_result', output: payload }]),
    });
    // One publication-time group crosses multiple full pages of timestamp ties.
    seed.zadd(`msg:thread:${threadId}`, time, id);
  }
  await seed.exec();
  const append = (id, timestamp, fields) =>
    redis
      .multi()
      .hset(`msg:${id}`, {
        id,
        threadId,
        userId: 'owner',
        catId: '',
        timestamp: String(timestamp),
        deliveryStatus: 'delivered',
        mentions: '["opus"]',
        ...fields,
      })
      .zadd(`msg:thread:${threadId}`, fields.timelineOrderAt ?? timestamp, id)
      .exec();
  await append('old-late-delivery', time - 100, {
    deliveredAt: String(time + 500),
    timelineOrderAt: String(time + 500),
  });
  await append('newer-human-input', time - 50, { mentions: '["codex"]' });
  await append('queued-human-input', time + 1, { deliveryStatus: 'queued', mentions: '["gemini"]' });
  await append('system-newer', time + 2, { userId: 'system', origin: 'briefing' });
  await append('external-newer', time + 3, { from: JSON.stringify({ kind: 'external', connectorId: 'slack' }) });
  await append('invalid-source-newer', time + 4, { source: '{invalid' });
  await append('deleted-human-newer', time + 5, { deletedAt: String(time + 6) });

  const send = redis.sendCommand.bind(redis);
  let fullHashReads = 0;
  let projectedReads = 0;
  let replyJsonBytes = 0;
  const projectedFields = new Set();
  redis.sendCommand = (command, ...args) => {
    if (command.name === 'hgetall') fullHashReads++;
    if (command.name === 'hmget') {
      projectedReads++;
      for (const field of command.args.slice(1)) projectedFields.add(String(field));
    }
    return send(command, ...args);
  };
  const multi = redis.multi.bind(redis);
  redis.multi = (...args) => {
    const transaction = multi(...args);
    const exec = transaction.exec.bind(transaction);
    transaction.exec = async (...execArgs) => {
      const results = await exec(...execArgs);
      // Individual MULTI commands resolve to QUEUED; measure the actual EXEC payloads.
      for (const [error, value] of results ?? [])
        if (!error) replyJsonBytes += Buffer.byteLength(JSON.stringify(value));
      return results;
    };
    return transaction;
  };
  try {
    assert.deepEqual(await findLastUserMentions(store, threadId), ['gemini']);
    await redis.hset('msg:queued-human-input', 'deliveryStatus', 'canceled');
    assert.deepEqual(
      await findLastUserMentions(store, threadId),
      ['codex'],
      'late delivery must not restore an older Human choice',
    );
    // Equal authoring time uses the existing id tie-break, without requiring a new publication ledger.
    await append('zz-equal-input', time - 50, { mentions: '["gemini"]' });
    assert.deepEqual(await findLastUserMentions(store, threadId), ['gemini']);
    diagnostics.stop();
    const { decodeThreadCpuMs, decodeWallMs, parsers } = summary;
    t.diagnostic(
      JSON.stringify({ fullHashReads, projectedReads, replyJsonBytes, decodeThreadCpuMs, decodeWallMs, parsers }),
    );
    assert.equal(fullHashReads, 0, 'recipient preview must not fetch full conversation hashes');
    assert.ok(projectedReads >= 160, 'the durable history is still examined, not capped at the recent page');
    for (const field of ['content', 'thinking', 'metadata', 'toolEvents', 'contentBlocks'])
      assert.equal(projectedFields.has(field), false, `${field} is unrelated to recipient choice`);
    assert.ok(replyJsonBytes < 1_000_000, 'the synthetic body payloads must stay in Redis');
    assert.equal(parsers.toolEvents.inputCodeUnits, 0);
    assert.equal(parsers.contentBlocks.inputCodeUnits, 0);
  } finally {
    diagnostics.stop();
    redis.sendCommand = send;
    redis.multi = multi;
  }
});
