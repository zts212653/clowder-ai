/**
 * F233 Phase A — briefing-delivery adapter 测试（Task 5，mock store 测逻辑）。
 * 覆盖 deliverBriefingCard append 格式 + hasBriefingToday 识别/当日判定/card id 区分。
 * 真实 MessageStore getByThread visibility（system briefing 对 operator 可见）留 e2e（Task 6）验证。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { deliverBriefingCard, hasBriefingToday } = await import(
  '../dist/domains/cats/services/duty-briefing/briefing-delivery.js'
);

const NOW = 1_700_000_000_000; // 当日中段（startOfDay = 1699920000000，便于跨日测试）
const DAY = 86_400_000;

function card(over = {}) {
  return { id: 'duty-briefing', kind: 'card', v: 1, title: '☀️ 值班简报', ...over };
}

test('deliverBriefingCard: append origin=briefing + extra.rich card（照 format-briefing 模式）', async () => {
  let appended = null;
  const messageStore = {
    append: async (msg) => {
      appended = msg;
      return { id: 'msg-1', ...msg };
    },
  };
  const id = await deliverBriefingCard(messageStore, 'thr-x', card(), NOW);
  assert.equal(id, 'msg-1');
  assert.equal(appended.threadId, 'thr-x');
  assert.equal(appended.userId, 'system');
  assert.equal(appended.catId, null);
  assert.equal(appended.origin, 'briefing');
  assert.equal(appended.timestamp, NOW);
  assert.deepEqual(appended.extra.rich, { v: 1, blocks: [card()] });
  assert.equal(appended.idempotencyKey, 'duty-briefing:thr-x:2023-11-14');
});

test('hasBriefingToday: 当日已发简报卡 → true', async () => {
  const messageStore = {
    getByThread: async () => [
      { origin: 'briefing', timestamp: NOW - 1000, extra: { rich: { v: 1, blocks: [card()] } } },
    ],
  };
  assert.equal(await hasBriefingToday(messageStore, 'thr-x', NOW), true);
});

test('hasBriefingToday: 昨天的简报卡 → false（跨日，今天未发，INV-5 允许新发）', async () => {
  const messageStore = {
    getByThread: async () => [
      { origin: 'briefing', timestamp: NOW - DAY, extra: { rich: { v: 1, blocks: [card()] } } },
    ],
  };
  assert.equal(await hasBriefingToday(messageStore, 'thr-x', NOW), false);
});

test('hasBriefingToday: 用 PT 切天，不因 UTC 跨日漏判同一本地日早上的卡', async () => {
  const now = Date.parse('2026-06-13T01:00:00Z'); // 2026-06-12 18:00 PT
  const morningBriefing = Date.parse('2026-06-12T14:00:00Z'); // 2026-06-12 07:00 PT
  const messageStore = {
    getByThread: async () => [
      { origin: 'briefing', timestamp: morningBriefing, extra: { rich: { v: 1, blocks: [card()] } } },
    ],
  };
  assert.equal(await hasBriefingToday(messageStore, 'thr-x', now), true);
});

test('hasBriefingToday: 非简报卡不误判（普通消息 + 其他 origin=briefing 卡如 F148）→ false', async () => {
  const messageStore = {
    getByThread: async () => [
      { origin: 'callback', timestamp: NOW - 1000, content: '普通消息' },
      // 其他 origin=briefing 但非值班简报卡（如 F148 context briefing，card id 不同）
      {
        origin: 'briefing',
        timestamp: NOW - 1000,
        extra: { rich: { v: 1, blocks: [card({ id: 'f148-context-nav' })] } },
      },
    ],
    getByThreadBefore: async () => [],
  };
  assert.equal(await hasBriefingToday(messageStore, 'thr-x', NOW), false, '靠 card id 识别，不与其他 briefing 混');
});

test('hasBriefingToday: 最新 50 条没有简报时继续向前分页，直到跨出当天窗口', async () => {
  const today = Date.parse('2026-06-12T20:00:00Z'); // 2026-06-12 13:00 PT
  const firstBatch = Array.from({ length: 50 }, (_, i) => ({
    id: `msg-${i}`,
    origin: 'callback',
    timestamp: today - i * 60_000,
  }));
  const secondBatch = [
    {
      id: 'briefing-early',
      origin: 'briefing',
      timestamp: Date.parse('2026-06-12T14:00:00Z'), // 07:00 PT same local day
      extra: { rich: { v: 1, blocks: [card()] } },
    },
  ];
  let beforeCalls = 0;
  const messageStore = {
    getByThread: async () => firstBatch,
    getByThreadBefore: async () => {
      beforeCalls += 1;
      return secondBatch;
    },
  };
  assert.equal(await hasBriefingToday(messageStore, 'thr-x', today), true);
  assert.equal(beforeCalls, 1, '翻页一次找到早上的简报');
});

test('hasBriefingToday: raw timestamp 跨天但 deliveredAt 属于今天时，仍继续翻页并认作今天窗口', async () => {
  const now = Date.parse('2026-06-13T01:00:00Z'); // 2026-06-12 18:00 PT
  const firstBatch = [
    {
      id: 'queued-1',
      origin: 'callback',
      timestamp: Date.parse('2026-06-12T06:00:00Z'), // 前一天 PT
      deliveredAt: Date.parse('2026-06-12T20:00:00Z'), // 当天 13:00 PT
    },
  ];
  let seenCursor = null;
  const messageStore = {
    getByThread: async () => firstBatch,
    getByThreadBefore: async (_threadId, timestamp, _limit, beforeId) => {
      seenCursor = { timestamp, beforeId };
      return [
        {
          id: 'briefing-early',
          origin: 'briefing',
          timestamp: Date.parse('2026-06-12T14:00:00Z'),
          extra: { rich: { v: 1, blocks: [card()] } },
        },
      ];
    },
  };
  assert.equal(await hasBriefingToday(messageStore, 'thr-x', now), true);
  assert.deepEqual(seenCursor, { timestamp: Date.parse('2026-06-12T20:00:00Z'), beforeId: 'queued-1' });
});

test('hasBriefingToday: 无消息 → false', async () => {
  const messageStore = { getByThread: async () => [], getByThreadBefore: async () => [] };
  assert.equal(await hasBriefingToday(messageStore, 'thr-x', NOW), false);
});
