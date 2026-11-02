import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assembleContext } from '../../dist/domains/cats/services/context/ContextAssembler.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';
import { createDecisionFixture, createProposal, OWNER } from './schedule-proposal-decision-fixture.js';

test('outbox admission failure prevents the business decision from starting', async (t) => {
  const fixture = await createDecisionFixture();
  t.after(() => fixture.close());
  const p = createProposal({ proposalId: 'receipt-intent-unavailable' });
  fixture.store.create(p);
  fixture.anchor(p);
  fixture.outbox.enqueue = () => {
    throw new Error('SQLite temporarily unavailable');
  };

  const response = await fixture.decide(p.proposalId, 'approve');

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'approval_receipt_unavailable');
  assert.equal(fixture.store.getById(p.proposalId).status, 'pending');
  assert.equal(fixture.dynamicStore.getAll().length, 0);
  assert.equal(fixture.messageStore.getByThread('thread-owner').length, 0);
});

test('failed receipt persistence preserves the decision, reports pending, and recovers without duplication', async (t) => {
  const warnings = [];
  const messageStore = new MessageStore();
  const append = messageStore.appendIdempotent.bind(messageStore);
  messageStore.appendIdempotent = () => {
    throw new Error('message store temporarily unavailable');
  };
  const fixture = await createDecisionFixture({ messageStore, logger: { warn: (...args) => warnings.push(args) } });
  t.after(() => fixture.close());
  const p = createProposal({ proposalId: 'receipt-append-unavailable' });
  p.mutation.task.params.message = 'private reminder content must stay private';
  fixture.store.create(p);
  fixture.anchor(p);

  const response = await fixture.decide(p.proposalId, 'reject', { rejectionReason: 'Keep this private'.repeat(70) });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-approval-receipt-status'], 'pending');
  assert.equal(fixture.store.getById(p.proposalId).status, 'rejected');
  assert.equal(fixture.outbox.list().length, 1);
  assert.equal(warnings.length, 1, 'the committed decision must not silently claim notification success');
  messageStore.appendIdempotent = append;
  assert.equal(await fixture.receipts.recover(), true);
  assert.equal((await fixture.decide(p.proposalId, 'reject')).statusCode, 409);
  await fixture.receipts.drain();
  const messages = messageStore.getByThread('thread-owner', 50, OWNER);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source.meta.approvalDecisionReceipt.rejectionReason.length, 500);
  assert.equal(JSON.stringify(messages).includes(p.mutation.task.params.message), false);
  assert.match(assembleContext(messages).contextText, /已拒绝/);
  assert.deepEqual(fixture.outbox.list(), []);
});

test('successful approval also persists one decision receipt independently of scheduler notices', async (t) => {
  const fixture = await createDecisionFixture();
  t.after(() => fixture.close());
  const p = createProposal({ proposalId: 'receipt-approve-once' });
  fixture.store.create(p);
  fixture.anchor(p);
  const responses = await Promise.all([
    fixture.decide(p.proposalId, 'approve'),
    fixture.decide(p.proposalId, 'approve'),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  await fixture.receipts.drain();
  assert.equal(fixture.notifications.length, 1);
  assert.equal(fixture.dynamicStore.getAll().length, 1);
  const messages = fixture.messageStore.getByThread('thread-owner');
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /已批准/);
});

test(
  'SQLite restart plus Redis append acknowledgement loss recovers one persistent, cat-readable receipt',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'approval receipt durable recovery');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisMessageStore } = await import('../../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const { MessageKeys } = await import('../../dist/domains/cats/services/stores/redis-keys/message-keys.js');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: 'receipt-recovery:' });
    const dir = await mkdtemp(join(tmpdir(), 'approval-receipt-'));
    t.after(async () => {
      await cleanupClientKeyspace(redis);
      await redis.quit();
      await rm(dir, { recursive: true, force: true });
    });
    const dbPath = join(dir, 'state.sqlite');
    const messages = new RedisMessageStore(redis);
    const realAppend = messages.appendIdempotent.bind(messages);
    messages.appendIdempotent = async (input) => {
      await realAppend(input);
      throw new Error('append committed; acknowledgement lost');
    };
    const first = await createDecisionFixture({ dbPath, messageStore: messages });
    const p = createProposal({ proposalId: 'receipt-durable-crash' });
    try {
      first.store.create(p);
      first.anchor(p);
      const response = await first.decide(p.proposalId, 'reject', { rejectionReason: 'No extra reminders' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['x-approval-receipt-status'], 'pending');
      assert.equal(first.store.getById(p.proposalId).status, 'rejected');
      assert.equal(first.outbox.list().length, 1);
    } finally {
      await first.close();
    }

    const reloadedMessages = new RedisMessageStore(redis);
    const second = await createDecisionFixture({ dbPath, messageStore: reloadedMessages });
    try {
      assert.equal(second.store.getById(p.proposalId).status, 'rejected');
      assert.deepEqual(second.outbox.list(), [], 'startup recovery consumes the persisted delivery intent');
      const visible = await reloadedMessages.getByThread('thread-owner', 50, OWNER);
      assert.equal(visible.length, 1, 'the Redis atomic idempotency key survives every service instance');
      assert.match(assembleContext(visible).contextText, /已拒绝/);
      assert.equal(
        await redis.ttl(MessageKeys.detail(visible[0].id)),
        -1,
        'owner-visible receipt is persistent (TTL=0)',
      );
      assert.equal((await second.decide(p.proposalId, 'reject')).statusCode, 409);
      await second.receipts.drain();
      assert.equal((await reloadedMessages.getByThread('thread-owner', 50, OWNER)).length, 1);
    } finally {
      await second.close();
    }
  },
);
