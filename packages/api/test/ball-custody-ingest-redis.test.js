/**
 * F233 Phase B — B2 PR1: BallCustodyIngest Redis 端到端（node:test，import dist）
 * 真实 stack：RedisBallCustodyEventLog + RedisBallCustodyProjectionStore + BallCustodyProjector + BallCustodyIngest。
 * 验证：handed/void_pass 动作 → projection 落地；幂等去重（INV-3）；rebuild 无漂移（INV-2）。
 * 有 Redis → 真实验证；无 Redis → skip。
 *
 * 并发隔离（B2 PR1）：用**唯一 keyPrefix** + 每 it **唯一 subjectKey/messageId** + 免 beforeEach 通配 cleanup。
 * 背景：B1 的 event-log-redis / projector-redis 用全 namespace 通配 cleanup（`ballcustody:*` / `events:*`），
 * node --test 文件级并发时互清对方正用的 key → race（pre-existing，已建独立 task 修测试基础设施）。
 * 本文件不复用那套通配 cleanup，改 keyPrefix 隔离 key 空间（B1 cleanup 的 `cat-cafe:` 前缀匹配不到本前缀）。
 * 关键：sourceEventId = `route:{messageId}:{toCatId}` **不含 threadId**，故 messageId 必须带 threadId 前缀
 * 才能跨 it 唯一（全局 seen SET 在本 keyPrefix 空间内仍跨 it 共享，无 cleanup 则去重锚需自然唯一）。
 * ioredis keyPrefix 对 Lua eval 的 KEYS 与普通命令一致生效（与 B1 同机制）。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f233bc-ingest-test:';

describe('BallCustodyIngest (Redis end-to-end)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let buildHandedEvent;
  let buildVoidPassEvent;
  let BallCustodyIngest;
  let RedisBallCustodyEventLog;
  let RedisBallCustodyProjectionStore;
  let BallCustodyProjector;
  let createRedisClient;
  let redis;
  let connected = false;
  let seq = 0;

  // 每 it 唯一 threadId（subjectKey）+ 唯一 messageId（sourceEventId 去重锚）→ 无需 beforeEach 清理，并发安全。
  const nextThread = () => `ingest-${++seq}`;

  function makeStack() {
    const eventLog = new RedisBallCustodyEventLog(redis);
    const store = new RedisBallCustodyProjectionStore(redis);
    const projector = new BallCustodyProjector(eventLog, store);
    const ingest = new BallCustodyIngest(eventLog, projector);
    return { eventLog, store, projector, ingest };
  }

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'BallCustodyIngest');
    ({ buildHandedEvent, buildVoidPassEvent } = await import('../dist/domains/ball-custody/ball-custody-events.js'));
    ({ BallCustodyIngest } = await import('../dist/domains/ball-custody/BallCustodyIngest.js'));
    ({ RedisBallCustodyEventLog } = await import('../dist/domains/ball-custody/BallCustodyEventLog.js'));
    ({ RedisBallCustodyProjectionStore } = await import('../dist/domains/ball-custody/BallCustodyProjectionStore.js'));
    ({ BallCustodyProjector } = await import('../dist/domains/ball-custody/BallCustodyProjector.js'));
    createRedisClient = (await import('@cat-cafe/shared/utils')).createRedisClient;
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    connected = true;
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  it('handed → projection active + holder（端到端 append+apply）', async () => {
    const threadId = nextThread();
    const { store, ingest } = makeStack();
    await ingest.record(buildHandedEvent({ toCatId: 'opus', threadId, messageId: `${threadId}/m1`, at: 100 }));
    const p = await store.get(`ball:thread:${threadId}`);
    assert.strictEqual(p.state, 'active');
    assert.strictEqual(p.holder, 'opus');
  });

  it('void_pass → projection void', async () => {
    const threadId = nextThread();
    const { store, ingest } = makeStack();
    await ingest.record(buildHandedEvent({ toCatId: 'opus', threadId, messageId: `${threadId}/m1`, at: 100 }));
    await ingest.record(buildVoidPassEvent({ threadId, messageId: `${threadId}/m2`, at: 200 }));
    assert.strictEqual((await store.get(`ball:thread:${threadId}`)).state, 'void');
  });

  it('幂等：同事件二次 record → 事件流只 1 条 + projection 不漂移（INV-3）', async () => {
    const threadId = nextThread();
    const { eventLog, store, ingest } = makeStack();
    const e = buildHandedEvent({ toCatId: 'opus', threadId, messageId: `${threadId}/m1`, at: 100 });
    await ingest.record(e);
    await ingest.record(e);
    assert.strictEqual((await eventLog.read(`ball:thread:${threadId}`)).length, 1);
    assert.strictEqual((await store.get(`ball:thread:${threadId}`)).appliedEventCount, 1);
  });

  it('rebuild 无漂移：record 序列 vs delete+replay 逐字段相同（INV-2）', async () => {
    const threadId = nextThread();
    const { store, projector, ingest } = makeStack();
    await ingest.record(buildHandedEvent({ toCatId: 'opus', threadId, messageId: `${threadId}/m1`, at: 100 }));
    await ingest.record(
      buildHandedEvent({ fromCatId: 'opus', toCatId: 'codex', threadId, messageId: `${threadId}/m2`, at: 200 }),
    );
    const subjectKey = `ball:thread:${threadId}`;
    const before = await store.get(subjectKey);
    await projector.rebuild(subjectKey);
    assert.deepStrictEqual(await store.get(subjectKey), before);
  });

  it('#1371 completes and replays one dispatch across a real Redis heartbeat CAS conflict', async () => {
    const { A2ADispatchDispositionService } = await import(
      '../dist/domains/ball-custody/A2ADispatchDispositionService.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { buildInvocationHeartbeatEvent } = await import('../dist/domains/ball-custody/ball-custody-events.js');
    const threadId = nextThread();
    const invocationId = `${threadId}/invocation`;
    const subjectKey = `ball:thread:${threadId}`;
    const { eventLog, store, projector, ingest } = makeStack();
    const messageStore = new MessageStore();
    const source = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: '@codex-sol review complete',
      mentions: ['codex-sol'],
      timestamp: 1_000,
      threadId,
    });
    await ingest.record(
      buildHandedEvent({ fromCatId: 'opus', toCatId: 'codex-sol', threadId, messageId: source.id, at: 1_000 }),
    );
    let attempts = 0;
    const warnings = [];
    const service = new A2ADispatchDispositionService({
      registry: { isLatest: async (candidate) => candidate === invocationId },
      messageStore,
      ballCustodyEventLog: eventLog,
      ballCustodyProjectionStore: store,
      log: { warn: (fields) => warnings.push(fields) },
      repairProjection: (key) => projector.rebuild(key),
      now: () => 2_000,
      ballCustody: {
        record: (event) => ingest.record(event),
        async recordFenced(event, expectedSequence) {
          attempts += 1;
          if (attempts === 1)
            await ingest.record(
              buildInvocationHeartbeatEvent({ threadId, invocationId, catId: 'codex-sol', draftUpdatedAt: 1_500 }),
            );
          return ingest.recordFenced(event, expectedSequence);
        },
      },
    });
    const auth = {
      invocationId,
      catId: 'codex-sol',
      threadId,
      a2aTriggerMessageId: source.id,
      originTriggerMessageId: source.id,
    };

    assert.equal((await service.complete(auth, 'handled')).outcome, 'applied');
    assert.equal(attempts, 2);
    assert.equal(warnings[0].expectedSequence, 1);
    assert.equal(warnings[0].actualSequence, 2);
    assert.equal((await new RedisBallCustodyProjectionStore(redis).get(subjectKey)).state, 'resolved');
    assert.equal((await service.complete(auth, 'handled')).outcome, 'replayed');
    const persisted = await new RedisBallCustodyEventLog(redis).read(subjectKey);
    assert.equal(persisted.length, 3);
    assert.equal(persisted.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
    assert.equal(attempts, 2, 'replay reuses the committed event without another append');
  });
  it('#1371 managed completion revalidates a heartbeat conflict through real Redis CAS', async () => {
    const { ManagedHoldDispositionService } = await import(
      '../dist/domains/ball-custody/ManagedHoldDispositionService.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { buildHeldEvent, buildWakeConditionMetEvent, buildInvocationHeartbeatEvent } = await import(
      '../dist/domains/ball-custody/ball-custody-events.js'
    );
    const threadId = nextThread();
    const taskId = `${threadId}/task`;
    const invocationId = `${threadId}/invocation`;
    const subjectKey = `ball:thread:${threadId}`;
    const { eventLog, store, projector, ingest } = makeStack();
    const messageStore = new MessageStore();
    const source = messageStore.append({
      userId: 'scheduler',
      catId: null,
      threadId,
      content: 'command completed',
      mentions: [],
      timestamp: 1_150,
      deliveryStatus: 'queued',
      source: { connector: 'hold-ball', label: 'hold', meta: { taskId, threadId, catId: 'codex-sol', wakeWhen: true } },
    });
    await ingest.record(buildHeldEvent({ threadId, catId: 'codex-sol', fireAt: 5_000, at: 1_000 }));
    await ingest.record(
      buildWakeConditionMetEvent({
        threadId,
        catId: 'codex-sol',
        taskId,
        command: 'test',
        exitCode: 0,
        timedOut: false,
        durationMs: 100,
        at: 1_100,
      }),
    );
    await ingest.record(buildHandedEvent({ threadId, toCatId: 'codex-sol', messageId: source.id, at: 1_200 }));
    let attempts = 0;
    const receipts = [];
    const service = new ManagedHoldDispositionService({
      registry: { isLatest: async (id) => id === invocationId },
      dynamicTaskStore: { getById: () => null }, // late callback: the exact server-minted source remains authoritative
      messageStore,
      ballCustodyEventLog: eventLog,
      ballCustodyProjectionStore: store,
      repairProjection: (key) => projector.rebuild(key),
      now: () => 2_000,
      receiptService: {
        complete: async (receipt) => {
          const events = await new RedisBallCustodyEventLog(redis).read(subjectKey);
          assert.equal(
            events.filter((event) => event.kind === 'ball.hold_dispositioned').length,
            1,
            'receipt is never reached before the real Redis terminal append',
          );
          receipts.push(receipt);
        },
      },
      ballCustody: {
        record: (event) => ingest.record(event),
        recordFenced: async (event, expectedSequence) => {
          if (++attempts === 1)
            await ingest.record(
              buildInvocationHeartbeatEvent({
                threadId,
                invocationId,
                catId: 'codex-sol',
                draftUpdatedAt: 1_300,
              }),
            );
          return ingest.recordFenced(event, expectedSequence);
        },
      },
    });
    const auth = { invocationId, userId: 'user-1', catId: 'codex-sol', threadId, originTriggerMessageId: source.id };
    assert.equal((await service.complete(auth, 'handled')).outcome, 'applied');
    assert.equal(attempts, 2);
    assert.equal((await new RedisBallCustodyProjectionStore(redis).get(subjectKey)).state, 'resolved');
    assert.equal((await service.complete(auth, 'handled')).outcome, 'replayed');
    assert.equal(attempts, 2);
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((receipt) => receipt.sourceMessageId === source.id && receipt.taskId === taskId));
    const events = await new RedisBallCustodyEventLog(redis).read(subjectKey);
    assert.equal(events.length, 5);
    assert.equal(events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 1);
  });
});
