/**
 * F233 Phase A — generateAndDeliverBriefing 编排核心测试（Task 5，mock 注入无 Redis）。
 * 覆盖 unbound / bound 投递 / INV-5 当日重发跳过 / INV-2 degraded 降级 / cron 无 fallback。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { generateAndDeliverBriefing } = await import(
  '../dist/domains/cats/services/duty-briefing/generateAndDeliverBriefing.js'
);
const { MemoryBriefingConfigStore } = await import(
  '../dist/domains/cats/services/duty-briefing/BriefingConfigStore.js'
);

const NOW = 1_700_000_000_000;

function emptyCollectDeps() {
  return {
    taskStore: { listByKind: async () => [] },
    invocationRecordStore: { scanAll: async () => [] },
    draftStore: { getByThread: async () => [] },
    dynamicTaskStore: { getAll: () => [] },
    threadStore: { list: async () => [] },
    messageStore: { getByThread: async () => [], getByThreadAfter: async () => [] },
    userId: 'default-user',
  };
}

function baseDeps(over = {}) {
  return {
    collectDeps: emptyCollectDeps(),
    configStore: new MemoryBriefingConfigStore(),
    threadExists: () => true,
    hasBriefingToday: () => false,
    deliverCard: async () => 'msg-default',
    now: NOW,
    ...over,
  };
}

test('unbound: 无绑定 → 不投递', async () => {
  const r = await generateAndDeliverBriefing(baseDeps());
  assert.equal(r.delivered, false);
  assert.equal(r.outcome, 'unbound');
});

test('bound + 当日未发 → 投递，deliverCard 收到 rich card', async () => {
  const store = new MemoryBriefingConfigStore();
  await store.setBinding('thr-briefing');
  let deliveredThread = null;
  let deliveredCard = null;
  const r = await generateAndDeliverBriefing(
    baseDeps({
      configStore: store,
      threadExists: (tid) => tid === 'thr-briefing',
      deliverCard: async (tid, card) => {
        deliveredThread = tid;
        deliveredCard = card;
        return 'msg-x';
      },
    }),
  );
  assert.equal(r.delivered, true);
  assert.equal(r.outcome, 'delivered');
  assert.equal(r.threadId, 'thr-briefing');
  assert.equal(r.messageId, 'msg-x');
  assert.equal(deliveredThread, 'thr-briefing');
  assert.equal(deliveredCard.kind, 'card', 'deliverCard 收到 rich card');
  assert.equal(deliveredCard.title, '☀️ 值班简报');
});

test('INV-5: 当日已发 → 跳过，deliverCard 不调用', async () => {
  const store = new MemoryBriefingConfigStore();
  await store.setBinding('thr-briefing');
  let called = false;
  const r = await generateAndDeliverBriefing(
    baseDeps({
      configStore: store,
      threadExists: () => true,
      hasBriefingToday: () => true,
      deliverCard: async () => {
        called = true;
        return 'x';
      },
    }),
  );
  assert.equal(r.delivered, false);
  assert.equal(r.outcome, 'already-sent-today');
  assert.equal(called, false, 'INV-5: 当日已发不重复投递');
});

test('INV-2 degraded + fallback → 降级投递来源 thread（不静默）', async () => {
  const store = new MemoryBriefingConfigStore();
  await store.setBinding('thr-deleted');
  let deliveredThread = null;
  const r = await generateAndDeliverBriefing(
    baseDeps({
      configStore: store,
      threadExists: (tid) => tid !== 'thr-deleted', // 绑定 thread 已删 → degraded
      fallbackThreadId: 'thr-source',
      deliverCard: async (tid) => {
        deliveredThread = tid;
        return 'msg-d';
      },
    }),
  );
  assert.equal(r.delivered, true);
  assert.equal(r.outcome, 'degraded-delivered');
  assert.equal(deliveredThread, 'thr-source', 'INV-2: 降级到 fallback thread');
});

test('INV-2 degraded + 无 fallback（cron）→ degraded-no-fallback，不静默吞', async () => {
  const store = new MemoryBriefingConfigStore();
  await store.setBinding('thr-deleted');
  let called = false;
  const r = await generateAndDeliverBriefing(
    baseDeps({
      configStore: store,
      threadExists: () => false, // degraded
      deliverCard: async () => {
        called = true;
        return 'x';
      },
    }),
  );
  assert.equal(r.delivered, false);
  assert.equal(r.outcome, 'degraded-no-fallback', '调用方据此记 error，不静默');
  assert.equal(called, false);
});
