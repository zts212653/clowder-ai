import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FreshnessAttentionEventLog } from '../src/domains/cats/services/freshness/FreshnessAttentionEventLog.ts';

class FixtureRedis {
  lists = new Map();
  multi() {
    const operations = [];
    const transaction = {};
    for (const name of ['rpush', 'expire', 'zadd', 'zremrangebyscore'])
      transaction[name] = (...args) => {
        operations.push([name, args]);
        return transaction;
      };
    transaction.exec = async () => {
      const results = [];
      for (const [name, args] of operations) results.push([null, await this[name](...args)]);
      return results;
    };
    return transaction;
  }
  async rpush(key, value) {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }
  async expire() {
    return 1;
  }
  async lrange(key, start, end) {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, end < 0 ? undefined : end + 1);
  }
  async zadd() {
    return 1;
  }
  async zremrangebyscore() {
    return 0;
  }
  async eval() {
    return 1;
  }
}
const base = {
  threadId: 'thread',
  catId: 'opus',
  invocationId: 'inv',
  timestamp: 1,
  noticeId: 'n',
  frontier: 'm',
  correlationMessageIds: ['m'],
  provider: 'anthropic',
  carrier: 'claude_agent_sdk',
  deliverySemantics: 'queued_internal_turn',
  toolSurface: 'command_execution',
  expectedTurnId: 'input',
};

test('SDK full-read evidence survives arriving before the terminal UUID delivery confirmation', async () => {
  const log = new FreshnessAttentionEventLog(new FixtureRedis());
  await log.append({ ...base, kind: 'provider_notice_prepared' });
  assert.equal(
    await log.markProviderNoticesSeen({
      ownerUserId: 'owner',
      invocationId: 'inv',
      catId: 'opus',
      exactMessageIds: ['unrelated'],
      evidenceKind: 'full_contiguous_thread_context',
    }),
    0,
  );
  assert.equal(
    await log.markProviderNoticesSeen({
      ownerUserId: 'owner',
      invocationId: 'inv',
      catId: 'opus',
      exactMessageIds: ['m'],
      evidenceKind: 'full_contiguous_thread_context',
    }),
    1,
  );
  assert.ok(!(await log.queryByInvocation('inv')).some((event) => event.kind === 'provider_notice_delivered'));
  await log.append({ ...base, kind: 'provider_notice_delivered', acceptedTurnId: 'input' });
  assert.equal(
    await log.markProviderNoticesSeen({
      ownerUserId: 'owner',
      invocationId: 'inv',
      catId: 'opus',
      exactMessageIds: ['m'],
      evidenceKind: 'full_contiguous_thread_context',
    }),
    0,
  );
  assert.equal(
    await log.markProviderNoticesHandled({
      ownerUserId: 'owner',
      invocationId: 'inv',
      catId: 'opus',
      queueEntryId: 'q',
      messageIds: ['m'],
      evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv' },
    }),
    1,
  );
});

test('other carriers still require delivered before the native notice seen projection', async () => {
  const log = new FreshnessAttentionEventLog(new FixtureRedis());
  await log.append({
    ...base,
    carrier: 'codex_app_server',
    provider: 'openai_codex',
    kind: 'provider_notice_prepared',
  });
  assert.equal(
    await log.markProviderNoticesSeen({
      ownerUserId: 'owner',
      invocationId: 'inv',
      catId: 'opus',
      exactMessageIds: ['m'],
      evidenceKind: 'full_contiguous_thread_context',
    }),
    0,
  );
});

test('SDK native unseen scan correlates exact message identities, not v2 cursor tokens', async () => {
  const { ThreadUnseenChecker } = await import('../src/domains/cats/services/freshness/ThreadUnseenChecker.ts');
  const { MessageStore } = await import('../src/domains/cats/services/stores/ports/MessageStore.ts');
  const { DeliveryCursorStore } = await import('../src/domains/cats/services/stores/ports/DeliveryCursorStore.ts');
  const { cursorFor } = await import('../src/domains/cats/services/stores/cursor.ts');
  const messages = new MessageStore();
  const cursor = new DeliveryCursorStore();
  const seed = messages.append({
    userId: 'owner',
    threadId: 't',
    catId: null,
    content: 'seed',
    mentions: [],
    timestamp: 1,
  });
  await cursor.ackSeenCursor('owner', 'opus', 't', cursorFor(seed));
  const next = messages.append({
    userId: 'owner',
    threadId: 't',
    catId: null,
    content: 'new',
    mentions: [],
    timestamp: 2,
  });
  const checker = new ThreadUnseenChecker({
    userId: 'owner',
    cursorStore: cursor,
    messageStore: messages,
    includeExactMessageIds: true,
  });
  const unseen = await checker.checkUnseen({ threadId: 't', catId: 'opus' });
  assert.equal(unseen.maxMessageId, cursorFor(next));
  assert.deepEqual(unseen.correlationMessageIds, [next.id]);
});

test('production freshness factory wires SDK exact IDs through prepared, full-read and handled receipts', async () => {
  const { createProviderNativeFreshnessFactory } = await import(
    '../src/domains/cats/services/freshness/createProviderNativeFreshnessFactory.ts'
  );
  const { MessageStore } = await import('../src/domains/cats/services/stores/ports/MessageStore.ts');
  const { DeliveryCursorStore } = await import('../src/domains/cats/services/stores/ports/DeliveryCursorStore.ts');
  const { cursorFor } = await import('../src/domains/cats/services/stores/cursor.ts');
  for (const carrier of ['claude_agent_sdk', 'codex_app_server']) {
    const redis = new FixtureRedis();
    const log = new FreshnessAttentionEventLog(redis);
    const messages = new MessageStore();
    const cursor = new DeliveryCursorStore();
    const input = { userId: 'owner', threadId: 't', catId: null, mentions: [] };
    const seed = messages.append({ ...input, content: 'seed', timestamp: 1 });
    await cursor.ackSeenCursor('owner', 'opus', 't', cursorFor(seed));
    const next = messages.append({ ...input, content: 'new requirement', timestamp: 2 });
    const factory = createProviderNativeFreshnessFactory({
      redis,
      cursorStore: cursor,
      messageStore: messages,
      threadStore: { get: async () => ({ thinkingMode: 'debug' }) },
    });
    const controller = await factory({
      invocationId: 'inv',
      threadId: 't',
      userId: 'owner',
      catId: 'opus',
      capability:
        carrier === 'claude_agent_sdk'
          ? { provider: 'anthropic', carrier, deliverySemantics: 'queued_internal_turn' }
          : { provider: 'openai_codex', carrier, deliverySemantics: 'exact_active_turn' },
    });
    const notice = await controller.prepare({ threadId: 't', turnId: 'input', toolSurface: 'command_execution' });
    assert.ok(notice);
    assert.equal(notice.frontier, cursorFor(next));
    assert.deepEqual(notice.correlationMessageIds, [carrier === 'claude_agent_sdk' ? next.id : cursorFor(next)]);
    const readEvidence = {
      ownerUserId: 'owner',
      invocationId: 'inv',
      catId: 'opus',
      exactMessageIds: [next.id],
      evidenceKind: 'full_contiguous_thread_context',
    };
    assert.equal(await log.markProviderNoticesSeen(readEvidence), carrier === 'claude_agent_sdk' ? 1 : 0);
    assert.ok(!(await log.queryByInvocation('inv')).some((event) => event.kind === 'provider_notice_delivered'));
    await controller.commitDelivered(notice, { acceptedTurnId: 'input' });
    assert.equal(
      await log.markProviderNoticesHandled({
        ownerUserId: 'owner',
        invocationId: 'inv',
        catId: 'opus',
        queueEntryId: 'q',
        messageIds: [next.id],
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv' },
      }),
      carrier === 'claude_agent_sdk' ? 1 : 0,
    );
  }
});
