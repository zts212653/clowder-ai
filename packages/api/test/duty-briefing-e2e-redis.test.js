/**
 * F233 Phase A — e2e：deliverBriefingCard + hasBriefingToday 真实 MessageStore (Redis)。
 *
 * 验证 mock 测不到的真实集成：briefing 投递后 getByThread 能查到（INV-5 依赖）。
 * 关键风险：origin='briefing' 是 isInternalNonQuotableParent（不能作 reply parent）——
 * 必须确认它不被 getByThread 列表查询误过滤，否则 hasBriefingToday 永远 false（每次重发）。
 * Skipped when REDIS_URL / isolation flag absent。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { cleanupPrefixedRedisKeys } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const ISOLATED = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const shouldSkip = !REDIS_URL || !ISOLATED;
const CLEAN = ['msg:*', 'messages:*', 'message:*', 'thread:*', 'threads:*'];

function card() {
  return { id: 'duty-briefing', kind: 'card', v: 1, title: '☀️ 值班简报', bodyMarkdown: '🟢 全部正常' };
}

describe(
  'F233 e2e: 简报投递 + 查回 真实 MessageStore (Redis)',
  { skip: shouldSkip ? 'Redis isolation not configured' : false },
  () => {
    let deliverBriefingCard;
    let hasBriefingToday;
    let createMessageStore;
    let createRedisClient;
    let redis;
    let messageStore;
    let connected = false;

    before(async () => {
      ({ deliverBriefingCard, hasBriefingToday } = await import(
        '../dist/domains/cats/services/duty-briefing/briefing-delivery.js'
      ));
      ({ createMessageStore } = await import('../dist/domains/cats/services/stores/factories/MessageStoreFactory.js'));
      ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        await redis.quit().catch(() => {});
      }
      if (connected) messageStore = createMessageStore(redis);
    });

    after(async () => {
      if (redis && connected) {
        await cleanupPrefixedRedisKeys(redis, CLEAN);
        await redis.quit();
      }
    });

    beforeEach(async () => {
      if (connected) await cleanupPrefixedRedisKeys(redis, CLEAN);
    });

    it('deliverBriefingCard → getByThread 真实查到（briefing 不被 visibility 过滤）→ hasBriefingToday=true', async (t) => {
      if (!connected) return t.skip('Redis not connected');
      const now = Date.now();
      const threadId = 'thr-e2e-briefing';

      const msgId = await deliverBriefingCard(messageStore, threadId, card(), now);
      assert.ok(msgId, '投递返回 messageId');

      // 关键真实集成：getByThread 必须返回 briefing card（operator viewer 可见，不被 internal 误过滤）
      const msgs = await messageStore.getByThread(threadId, 50, 'default-user');
      const briefingMsg = msgs.find((m) => m.origin === 'briefing');
      assert.ok(briefingMsg, 'getByThread 返回 briefing 消息（否则 INV-5 失效，每次重发）');
      assert.equal(briefingMsg.extra?.rich?.blocks?.[0]?.id, 'duty-briefing', 'briefing card 内容完整保存');

      // INV-5 真实：当日已发查到
      assert.equal(await hasBriefingToday(messageStore, threadId, now), true, 'INV-5: 当日已发真实查到');
    });

    it('未发简报的 thread → hasBriefingToday=false（可投递）', async (t) => {
      if (!connected) return t.skip('Redis not connected');
      assert.equal(await hasBriefingToday(messageStore, 'thr-e2e-empty', Date.now()), false);
    });

    it('同一本地日超 50 条后仍能翻页查回早上的简报（INV-5 不重复发）', async (t) => {
      if (!connected) return t.skip('Redis not connected');
      const threadId = 'thr-e2e-paginate';
      const morningBriefing = Date.parse('2026-06-12T14:00:00Z'); // 07:00 PT
      await deliverBriefingCard(messageStore, threadId, card(), morningBriefing);

      for (let i = 0; i < 55; i += 1) {
        await messageStore.append({
          threadId,
          userId: 'default-user',
          catId: null,
          content: `noise-${i}`,
          mentions: [],
          timestamp: morningBriefing + (i + 1) * 60_000,
          origin: 'callback',
        });
      }

      const now = Date.parse('2026-06-13T01:00:00Z'); // 2026-06-12 18:00 PT，同一本地日
      assert.equal(await hasBriefingToday(messageStore, threadId, now), true);
    });

    it('同一本地日重复 deliverBriefingCard 返回同一 messageId（append idempotency 去重）', async (t) => {
      if (!connected) return t.skip('Redis not connected');
      const threadId = 'thr-e2e-idem';
      const first = await deliverBriefingCard(messageStore, threadId, card(), Date.parse('2026-06-12T14:00:00Z'));
      const second = await deliverBriefingCard(messageStore, threadId, card(), Date.parse('2026-06-12T20:00:00Z'));
      assert.equal(second, first);
      const msgs = await messageStore.getByThread(threadId, 50, 'default-user');
      assert.equal(msgs.filter((m) => m.origin === 'briefing').length, 1);
    });
  },
);
