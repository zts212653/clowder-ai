import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { PawFeelAdapter } from '../../dist/infrastructure/harness-eval/friction/paw-feel-adapter.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

// F245 Phase A Task3 — PawFeelAdapter 回扫组装（Redis-backed，必须真实 Redis 索引行为，
// 不能纯 in-memory stub：getBefore 全局 timeline 走 zset zrevrangebyscore，与内存数组遍历语义不同）

const REDIS_URL = process.env.REDIS_URL;
// 取一次当前时间作基准（确定性：所有 seed/断言共用 T0 常量）。
// 不能用远古固定值——RedisMessageStore.append 会 zremrangebyscore prune score < now-TTL 的
// timeline 条目，过旧 timestamp 的 message 一存就被删（feedback_inmemory_store_tests_miss_redis_behavior）。
const T0 = Date.now();

describe('PawFeelAdapter — Redis-backed pull', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'PawFeelAdapter');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[paw-feel-adapter.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisMessageStore(redis, { ttlSeconds: 120 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['msg:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
  });

  function seed({ thread, cat, ts, content }) {
    return store.append({ userId: 'u1', catId: cat, content, mentions: [], timestamp: ts, threadId: thread });
  }

  it('采集时间窗内 marker → 结构化 signal（跨 thread/cat，字段正确）', async () => {
    const a = await seed({ thread: 'th-1', cat: 'opus-48', ts: T0 + 1000, content: '前面 [爪感差: rg 噪音大] 后面' });
    const b = await seed({ thread: 'th-2', cat: 'codex', ts: T0 + 2000, content: '[爪感差：hold_ball 重复唤醒]' });
    await seed({ thread: 'th-1', cat: 'opus-48', ts: T0 + 3000, content: '正常消息没有 marker' });

    const adapter = new PawFeelAdapter(store);
    const signals = await adapter.pull(T0, T0 + 10000);

    assert.equal(signals.length, 2);
    const byId = new Map(signals.map((s) => [s.id, s]));
    const sigA = byId.get(`paw-feel:${a.id}#0`);
    assert.ok(sigA, 'signal A 存在');
    assert.equal(sigA.channel, 'paw-feel');
    assert.equal(sigA.catId, 'opus-48');
    assert.equal(sigA.threadId, 'th-1');
    assert.equal(sigA.tool, 'rg');
    assert.equal(sigA.symptom, '噪音大');
    assert.equal(sigA.rawRef, `${a.id}#0`);
    assert.equal(sigA.severity, 'medium');
    assert.equal(sigA.timestamp, new Date(T0 + 1000).toISOString());
    assert.equal(sigA.sourceEvidence, '[爪感差: rg 噪音大]');

    const sigB = byId.get(`paw-feel:${b.id}#0`);
    assert.ok(sigB, 'signal B 存在');
    assert.equal(sigB.catId, 'codex');
    assert.equal(sigB.threadId, 'th-2');
    assert.equal(sigB.tool, 'hold_ball');
    assert.equal(sigB.symptom, '重复唤醒');
  });

  it('时间窗过滤：窗口外 marker 不采集（sinceMs 含、untilMs 不含）', async () => {
    await seed({ thread: 'th-1', cat: 'opus-48', ts: T0 - 5000, content: '[爪感差: old 太老]' });
    const mid = await seed({ thread: 'th-1', cat: 'opus-48', ts: T0 + 1000, content: '[爪感差: rg 窗口内]' });
    await seed({ thread: 'th-1', cat: 'opus-48', ts: T0 + 10000, content: '[爪感差: future 太新]' });

    const adapter = new PawFeelAdapter(store);
    const signals = await adapter.pull(T0, T0 + 10000);

    assert.equal(signals.length, 1);
    assert.equal(signals[0].rawRef, `${mid.id}#0`);
    assert.equal(signals[0].tool, 'rg');
  });

  it('幂等：重复 pull 同窗口 → 相同 id 集合', async () => {
    await seed({ thread: 'th-1', cat: 'opus-48', ts: T0 + 1000, content: '[爪感差: rg 噪音]' });
    await seed({ thread: 'th-2', cat: 'codex', ts: T0 + 2000, content: '[爪感差: hold_ball 卡]' });

    const adapter = new PawFeelAdapter(store);
    const first = await adapter.pull(T0, T0 + 10000);
    const second = await adapter.pull(T0, T0 + 10000);

    const ids1 = first.map((s) => s.id).sort();
    const ids2 = second.map((s) => s.id).sort();
    assert.equal(ids1.length, 2);
    assert.deepEqual(ids2, ids1);
  });

  it('一条 message 多 marker → 多 signal，rawRef 用 markerIndex', async () => {
    const m = await seed({
      thread: 'th-1',
      cat: 'opus-48',
      ts: T0 + 1000,
      content: '[爪感差: rg 慢] 还有 [爪感差: grep 也慢]',
    });

    const adapter = new PawFeelAdapter(store);
    const signals = await adapter.pull(T0, T0 + 10000);

    assert.equal(signals.length, 2);
    const byRef = new Map(signals.map((s) => [s.rawRef, s]));
    assert.equal(byRef.get(`${m.id}#0`).tool, 'rg');
    assert.equal(byRef.get(`${m.id}#1`).tool, 'grep');
  });

  it('翻页：超过 pageSize 的窗口全采集（recall=100%，不丢）', async () => {
    for (let i = 0; i < 5; i++) {
      await seed({ thread: 'th-1', cat: 'opus-48', ts: T0 + 1000 + i * 100, content: `[爪感差: tool${i} 现象${i}]` });
    }

    const adapter = new PawFeelAdapter(store, { pageSize: 2 });
    const signals = await adapter.pull(T0, T0 + 10000);

    assert.equal(signals.length, 5);
    const tools = signals.map((s) => s.tool).sort();
    assert.deepEqual(tools, ['tool0', 'tool1', 'tool2', 'tool3', 'tool4']);
  });

  // P1-1 (gpt52 review): timeline zset score = deliveredAt ?? timestamp（markDelivered re-score）。
  // 窗口判定/输出必须用 effective order time，否则 queued-message-created-before-window-but-
  // delivered-in-window 被 raw timestamp 漏采，且 signal period 错位。
  it('P1-1: queued 消息按 effective time(deliveredAt) 采集，不按 raw timestamp 漏采', async () => {
    const created = T0 - 5000; // 窗口前（raw timestamp）
    const delivered = T0 + 1000; // 窗口内（effective time）
    const m = await store.append({
      userId: 'u1',
      catId: 'opus-48',
      content: '[爪感差: rg 噪音]',
      mentions: [],
      timestamp: created,
      deliveryStatus: 'queued',
      threadId: 'th-1',
    });
    await store.markDelivered(m.id, delivered);

    const adapter = new PawFeelAdapter(store);
    const signals = await adapter.pull(T0, T0 + 10000);

    assert.equal(signals.length, 1, 'queued-delivered-in-window 应被采集（effective time 在窗口）');
    assert.equal(signals[0].tool, 'rg');
    // signal timestamp 用 effective time，与 period 归属一致
    assert.equal(signals[0].timestamp, new Date(delivered).toISOString());
  });

  // P1-2 (gpt52 review): 爪感差是猫的摩擦上报约定（L0 staging）。user-authored 消息引用 marker
  // 格式（讨论时）不算真信号——author guard 跳过 catId===null。
  it('P1-2: user-authored 引用 marker 格式不采集（author guard）', async () => {
    await store.append({
      userId: 'u1',
      catId: null,
      content: '讨论格式：比如猫会写 [爪感差: rg 噪音太多]',
      mentions: [],
      timestamp: T0 + 1000,
      threadId: 'th-1',
    });
    const catMsg = await store.append({
      userId: 'u1',
      catId: 'opus-48',
      content: '[爪感差: hold_ball 卡]',
      mentions: [],
      timestamp: T0 + 2000,
      threadId: 'th-1',
    });

    const adapter = new PawFeelAdapter(store);
    const signals = await adapter.pull(T0, T0 + 10000);

    assert.equal(signals.length, 1, '只采 cat-authored，user 引用不采');
    assert.equal(signals[0].rawRef, `${catMsg.id}#0`);
    assert.equal(signals[0].catId, 'opus-48');
  });
});

// cloud review R3 P2: in-memory MessageStore.getBefore 按 raw msg.timestamp 比较 cursor
// （Redis 按 effective zset score）。adapter 翻页须 store-agnostic：seen-id 去重 + 无进展 break，
// 否则 queued-delivered message（deliveredAt!==timestamp）在 in-memory 路径重复/死循环。
describe('PawFeelAdapter — in-memory store path (cloud R3 P2)', () => {
  const M0 = 1_700_000_000_000; // in-memory 无 prune，可用固定基准

  it('queued-delivered message 不重复不死循环（pageSize=1）', { timeout: 8000 }, async () => {
    const store = new MessageStore();
    const m1 = store.append({
      userId: 'u1',
      catId: 'opus-48',
      content: '[爪感差: rg 噪音]',
      mentions: [],
      timestamp: M0 - 5000,
      deliveryStatus: 'queued',
      threadId: 'th-1',
    });
    store.markDelivered(m1.id, M0 + 1000);
    const m2 = store.append({
      userId: 'u1',
      catId: 'codex',
      content: '[爪感差: grep 慢]',
      mentions: [],
      timestamp: M0 - 4000,
      deliveryStatus: 'queued',
      threadId: 'th-1',
    });
    store.markDelivered(m2.id, M0 + 2000);

    const adapter = new PawFeelAdapter(store, { pageSize: 1 });
    const signals = await adapter.pull(M0, M0 + 10000);

    const ids = signals.map((s) => s.id);
    // R3 两个担忧已解决：无 duplicate（seen 去重）+ 不 loop forever（fresh===0 break；能跑到断言即非死循环）。
    assert.equal(new Set(ids).size, ids.length, '无重复 signal');
    assert.ok(ids.length >= 1, 'graceful degrade 非全废');
    // 注：in-memory getBefore 用 raw-timestamp cursor（≠ Redis effective zset score），queued-delivered
    // message 翻页 degraded recall（可能漏采）。完整 recall 是 Redis-backed 契约（friction eval 后台任务的
    // 数据源恒为生产 Redis；in-memory 仅 degraded/test mode，不运行 friction rollup）。见 adapter 类文档。
  });
});
