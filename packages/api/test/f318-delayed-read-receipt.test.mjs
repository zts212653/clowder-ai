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
